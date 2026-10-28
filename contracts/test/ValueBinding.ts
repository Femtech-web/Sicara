import { expect } from "chai";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers, fhevm } from "hardhat";
import type { ContractTransactionResponse } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { EncryptedValueBindingProbe } from "../types";

const WRAP = 1n << 128n;
const CIRCUIT = "sicara-note-membership-poseidon-v2-experimental";
const SHA256_BASELINE = { totalGlobalHCU: 124_587_544, transactions: 18 };
const binary = process.env.SICARA_PRIVACY_PROBE_BIN;
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "test",
  RAYON_NUM_THREADS: "2",
};
const random128 = () => BigInt("0x" + randomBytes(16).toString("hex"));
const respond = (challenge: bigint, value: bigint, mask: bigint) =>
  (challenge * value + mask) % WRAP;
// Little-endian Pallas field encoding used by the native proof envelope.
function field(value: bigint) {
  const bytes = Buffer.alloc(32);
  bytes.writeBigUInt64LE(value & 0xffffffffffffffffn);
  bytes.writeBigUInt64LE(value >> 64n, 8);
  return bytes.toString("hex");
}
const statementHash = (inputs: string[]) =>
  ethers.keccak256(ethers.concat(inputs.map((v) => "0x" + v)));
type Envelope = { circuitId: string; proof: string; publicInputs: string[] };
type Job = { statement: string; challenge: bigint; response: bigint };

/** Client-local channel: the amount and mask go to the prover over a pipe only. */
function nativeClient(path: string) {
  const child = spawn(path, ["--value-binding"], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  return {
    send: (message: Record<string, string>) =>
      child.stdin.write(JSON.stringify(message) + "\n"),
    async receive() {
      const next = await lines.next();
      assert.ok(!next.done, "native client closed early");
      return JSON.parse(next.value);
    },
    async finish() {
      child.stdin.end();
      assert.equal(await exited, 0, "native client failed");
    },
  };
}

/** What an admission service must check before honouring the encrypted capacity. */
function proofBindsJob(path: string, envelope: Envelope, job: Job) {
  const p = envelope.publicInputs;
  if (envelope.circuitId !== CIRCUIT || p.length !== 10) return false;
  if (statementHash(p.slice(0, 8)) !== job.statement) return false;
  if (p[8] !== field(job.challenge) || p[9] !== field(job.response))
    return false;
  const checked = spawnSync(path, ["--verify-note-eligibility"], {
    env,
    input: JSON.stringify(envelope),
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4000,
  });
  return (
    checked.status === 0 && JSON.parse(checked.stdout).relationVerified === true
  );
}

describe("Masked-response ZK/FHE value binding (local FHEVM mock, no collateral claim)", function () {
  this.timeout(300_000);
  let probe: EncryptedValueBindingProbe;
  let address: string;
  let client: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  const costs: { globalHCU: number; maxHCUDepth: number; gas: bigint }[] = [];
  before(function () {
    if (!fhevm.isMock) this.skip();
  });
  beforeEach(async () => {
    [client, stranger] = await ethers.getSigners();
    probe = await ethers.deployContract("EncryptedValueBindingProbe");
    address = await probe.getAddress();
  });
  async function measure(transaction: Promise<ContractTransactionResponse>) {
    const receipt = (await (await transaction).wait())!;
    const hcu = fhevm.computeTransactionHCU(receipt);
    // Limits in the installed host-contracts fixture, not a live-network cost promise.
    expect(hcu.globalHCU).to.be.lessThan(20_000_000);
    expect(hcu.maxHCUDepth).to.be.lessThan(5_000_000);
    costs.push({ ...hcu, gas: receipt.gasUsed });
  }
  async function encrypt(value: bigint, mask: bigint) {
    const input = await fhevm
      .createEncryptedInput(address, client.address)
      .add64(value)
      .add128(mask)
      .encrypt();
    return {
      value: ethers.hexlify(input.handles[0]),
      mask: ethers.hexlify(input.handles[1]),
      proof: input.inputProof,
    };
  }
  async function submit(
    statement: string,
    value: bigint,
    mask: bigint,
    response?: bigint,
  ) {
    const input = await encrypt(value, mask);
    const id = ethers.hexlify(ethers.randomBytes(32));
    const challenge = await probe.challengeFor(
      client.address,
      id,
      statement,
      input.value,
      input.mask,
    );
    const reply = response ?? respond(challenge, value, mask);
    await measure(
      probe.bind(id, statement, input.value, input.mask, input.proof, reply),
    );
    return { id, input, challenge, reply };
  }
  async function outcome(id: string) {
    const job = await probe.job(id);
    return {
      job: {
        statement: job.statement,
        challenge: job.challenge,
        response: job.response,
      },
      matches: await fhevm.userDecryptEbool(job.matches, address, client),
      capacity: await fhevm.userDecryptEuint(
        FhevmType.euint64,
        job.capacity,
        address,
        client,
      ),
      handle: job.capacity,
    };
  }

  it("recomputes the masked response homomorphically; substituted values or masks give zero capacity", async () => {
    const statement = ethers.hexlify(ethers.randomBytes(32));
    const value = 4_294_967_303n;
    const mask = random128();
    const honest = await submit(statement, value, mask);
    const result = await outcome(honest.id);
    expect(result.matches).to.equal(true);
    expect(result.capacity).to.equal(value * 50n);
    await assert.rejects(
      fhevm.userDecryptEuint(
        FhevmType.euint64,
        result.handle,
        address,
        stranger,
      ),
    );
    for (const [v, m, z] of [
      [value + 1n, mask, honest.reply],
      [value, random128(), honest.reply],
      [value, mask, (honest.reply + 1n) % WRAP],
      [2_100_000_000_000_001n, mask, undefined],
      [0n, mask, undefined],
    ] as const) {
      const attempt = await submit(statement, v, m, z);
      const checked = await outcome(attempt.id);
      expect(checked.matches).to.equal(false);
      expect(checked.capacity).to.equal(0n);
    }
    await expect(
      probe.bind(
        honest.id,
        statement,
        honest.input.value,
        honest.input.mask,
        honest.input.proof,
        honest.reply,
      ),
    ).to.be.revertedWithCustomError(probe, "InvalidJob");
    await expect(
      probe
        .connect(stranger)
        .bind(
          ethers.hexlify(ethers.randomBytes(32)),
          statement,
          honest.input.value,
          honest.input.mask,
          honest.input.proof,
          honest.reply,
        ),
    ).to.be.reverted;
  });

  it("joins a real Halo2 note-value proof to Zama encrypted capacity in one transaction", async function () {
    if (!binary) this.skip();
    const amount = 4_294_967_303n;
    const mask = random128();
    const native = nativeClient(binary!);
    native.send({
      amount: amount.toString(),
      mask: mask.toString(),
      minimum: "1",
    });
    const committed: { statement: string[] } = await native.receive();
    assert.equal(committed.statement.length, 8);
    const statement = statementHash(committed.statement);
    const input = await encrypt(amount, mask);
    const id = ethers.hexlify(ethers.randomBytes(32));
    const challenge = await probe.challengeFor(
      client.address,
      id,
      statement,
      input.value,
      input.mask,
    );
    native.send({ challenge: challenge.toString() });
    const envelope: Envelope = await native.receive();
    await native.finish();
    const response = respond(challenge, amount, mask);
    costs.length = 0;
    await measure(
      probe.bind(id, statement, input.value, input.mask, input.proof, response),
    );
    const honest = await outcome(id);
    expect(honest.capacity).to.equal(amount * 50n);
    assert.ok(proofBindsJob(binary!, envelope, honest.job));
    const [cost] = costs;

    // Each attack reuses the honest proof's statement and response. A changed handle
    // changes the challenge, so neither the FHE check nor the proof check can pass.
    const inflated = amount * 1000n;
    const attacks = {
      inflatedValue: [inflated, mask],
      highTwoAdicDifference: [amount + (1n << 50n), mask],
      maskSolvedForHonestChallenge: [
        inflated,
        (((response - challenge * inflated) % WRAP) + WRAP) % WRAP,
      ],
      differentMask: [amount, random128()],
    } as const;
    const rejected: Record<string, boolean> = {};
    for (const [name, [v, m]] of Object.entries(attacks)) {
      const attempt = await submit(statement, v, m, response);
      const checked = await outcome(attempt.id);
      expect(checked.capacity, name).to.equal(0n);
      expect(proofBindsJob(binary!, envelope, checked.job), name).to.equal(
        false,
      );
      rejected[name] = true;
    }
    // FHE alone accepts any self-consistent inputs; only the proof check gives them meaning.
    const unproven = await submit(statement, inflated, random128());
    const unprovenResult = await outcome(unproven.id);
    expect(unprovenResult.capacity).to.equal(inflated * 50n);
    expect(proofBindsJob(binary!, envelope, unprovenResult.job)).to.equal(
      false,
    );
    const tampered = {
      ...envelope,
      publicInputs: envelope.publicInputs.map((v, i) =>
        i === 9 ? field((response + 1n) % WRAP) : v,
      ),
    };
    expect(
      proofBindsJob(binary!, tampered, {
        ...honest.job,
        response: (response + 1n) % WRAP,
      }),
    ).to.equal(false);

    const evidence = {
      experiment: "masked-response-value-binding",
      scope:
        "local-fhevm-mock-and-client-local-halo2-proof-over-synthetic-note-root",
      circuitId: CIRCUIT,
      proofBytes: envelope.proof.length / 2,
      relation:
        "z = alpha*v + rho mod 2^128; alpha = keccak(domain, chain, contract, owner, job, statement, handles)",
      transactionsPerJob: 1,
      globalHCU: cost.globalHCU,
      maxHCUDepth: cost.maxHCUDepth,
      gas: cost.gas.toString(),
      sha256Baseline: SHA256_BASELINE,
      honestCapacityAuthorized: true,
      attacksRejected: rejected,
      tamperedResponseRejected: true,
      unprovenSelfConsistentJobRejectedByProofCheck: true,
      soundness:
        "unequal values pass with probability <= 2^(e-128), e = 2-adic valuation of the difference (<= 50 under the FHE bound); Fiat-Shamir grinding over job ids costs about 2^78 hashes",
      onchainHalo2Verifier: false,
      claimConsumedOnchain: false,
      liveZcashNoteBinding: false,
      liveFheExecution: false,
      readyForFundedTest: false,
    };
    const dir = resolve(__dirname, "../../.local/evidence");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(dir, "value-binding.json"),
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(evidence));
  });
});

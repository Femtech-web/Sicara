import { expect } from "chai";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { ethers, fhevm } from "hardhat";
import type { ContractTransactionResponse } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function commitment(value: bigint, salt: Buffer) {
  const word = Buffer.alloc(8);
  word.writeBigUInt64BE(value);
  return (
    "0x" +
    createHash("sha256")
      .update(Buffer.concat([Buffer.from("SICARA01"), word, salt]))
      .digest("hex")
  );
}
describe("Encrypted SHA256 value-binding experiment (local FHEVM mock, no collateral claim)", function () {
  this.timeout(180_000);
  before(function () {
    if (!fhevm.isMock) this.skip();
  });
  it("checks a shared salted commitment without publishing the value; wrong value/salt cannot authorize capacity", async () => {
    const [client, stranger] = await ethers.getSigners();
    const probe = await ethers.deployContract("EncryptedCommitmentProbe");
    const address = await probe.getAddress();
    let maximumGlobalHCU = 0,
      maximumDepth = 0,
      maximumGas = 0n;
    let jobGlobalHCU = 0,
      jobGas = 0n,
      jobTransactions = 0;
    const jobCosts: {
      case: string;
      totalGlobalHCU: number;
      totalGas: string;
      transactions: number;
      globalHCULowerBoundTransactions: number;
    }[] = [];
    async function measure(transaction: Promise<ContractTransactionResponse>) {
      const receipt = (await (await transaction).wait())!;
      const hcu = fhevm.computeTransactionHCU(receipt);
      maximumGlobalHCU = Math.max(maximumGlobalHCU, hcu.globalHCU);
      maximumDepth = Math.max(maximumDepth, hcu.maxHCUDepth);
      if (receipt.gasUsed > maximumGas) maximumGas = receipt.gasUsed;
      jobGlobalHCU += hcu.globalHCU;
      jobGas += receipt.gasUsed;
      jobTransactions++;
      // Limits in the installed host-contracts fixture, not a live-network cost promise.
      expect(hcu.globalHCU).to.be.lessThan(20_000_000);
      expect(hcu.maxHCUDepth).to.be.lessThan(5_000_000);
    }
    const value = 4_294_967_303n;
    const salt = randomBytes(32);
    const expected = commitment(value, salt);
    let zkProof: Record<string, unknown> | undefined;
    if (process.env.SICARA_PRIVACY_PROBE_BIN) {
      // Client-local witness channel only: never command-line arguments or backend logging.
      const native = spawnSync(
        process.env.SICARA_PRIVACY_PROBE_BIN,
        ["--sha256-binding"],
        {
          input: JSON.stringify({
            amount: value.toString(),
            minimum: "1",
            salt: salt.toString("hex"),
          }),
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 1_000_000,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NODE_ENV: "test",
            RAYON_NUM_THREADS: "2",
          },
        },
      );
      assert.equal(native.status, 0, "Client-local commitment proof failed");
      zkProof = JSON.parse(native.stdout);
      assert.equal(zkProof!.scope, "client-local-sha256-binding-test");
      assert.equal(zkProof!.proofVerified, true);
      assert.equal(zkProof!.commitment, expected);
      assert.equal(zkProof!.realZcashNoteBound, false);
    }
    const cases = [
      { value, wrong: "none" },
      { value: value + 1n, wrong: "value" },
      { value, wrong: "salt" },
      { value: 2_100_000_000_000_001n, wrong: "range" },
    ];
    for (const sample of cases) {
      jobGlobalHCU = 0;
      jobGas = 0n;
      jobTransactions = 0;
      const publicDigest =
        sample.wrong === "range" ? commitment(sample.value, salt) : expected;
      const inputSalt = sample.wrong === "salt" ? randomBytes(32) : salt;
      const input = fhevm
        .createEncryptedInput(address, client.address)
        .add64(sample.value);
      for (let i = 0; i < 8; i++) input.add32(inputSalt.readUInt32BE(i * 4));
      const encrypted = await input.encrypt();
      const id = ethers.hexlify(ethers.randomBytes(32));
      const handles = encrypted.handles.map((handle) => ethers.hexlify(handle));
      await measure(
        probe.start(
          id,
          publicDigest,
          handles[0],
          handles.slice(1),
          encrypted.inputProof,
        ),
      );
      await expect(
        probe.start(
          id,
          expected,
          handles[0],
          handles.slice(1),
          encrypted.inputProof,
        ),
      ).to.be.revertedWithCustomError(probe, "InvalidJob");
      await expect(probe.finish(id)).to.be.revertedWithCustomError(
        probe,
        "WrongPhase",
      );
      await expect(
        probe.connect(stranger).step(id, 1),
      ).to.be.revertedWithCustomError(probe, "NotClient");
      await expect(probe.step(id, 0)).to.be.revertedWithCustomError(
        probe,
        "WrongPhase",
      );
      await expect(probe.step(id, 5)).to.be.revertedWithCustomError(
        probe,
        "WrongPhase",
      );
      for (let i = 0; i < 64; i += 4) {
        await measure(probe.step(id, 4));
      }
      await measure(probe.finish(id));
      expect(jobTransactions).to.equal(18);
      jobCosts.push({
        case: sample.wrong,
        totalGlobalHCU: jobGlobalHCU,
        totalGas: jobGas.toString(),
        transactions: jobTransactions,
        globalHCULowerBoundTransactions:
          Math.floor(jobGlobalHCU / 20_000_000) + 1,
      });
      const result = await probe.result(id);
      expect(
        await fhevm.userDecryptEbool(result.matches, address, client),
      ).to.equal(sample.wrong === "none");
      expect(
        await fhevm.userDecryptEuint(
          FhevmType.euint64,
          result.capacity,
          address,
          client,
        ),
      ).to.equal(sample.wrong === "none" ? sample.value * 50n : 0n);
      await assert.rejects(
        fhevm.userDecryptEuint(
          FhevmType.euint64,
          result.capacity,
          address,
          stranger,
        ),
      );
      await expect(probe.step(id, 1)).to.be.revertedWithCustomError(
        probe,
        "WrongPhase",
      );
      await expect(probe.finish(id)).to.be.revertedWithCustomError(
        probe,
        "WrongPhase",
      );
    }
    const evidence = {
      experiment: "encrypted-sha256-binding",
      scope: "local-fhevm-mock",
      nativeProof: zkProof ?? null,
      roundTransactionsPerJob: 16,
      transactionsPerJob: 18,
      maximumGlobalHCU,
      maximumDepth,
      maximumGas: maximumGas.toString(),
      jobCosts,
      practicality:
        "not-approved-for-live-lending; local costs only; batching cannot bypass the installed HCU limit",
      matchingValueAccepted: true,
      wrongValueRejected: true,
      wrongSaltRejected: true,
      outOfRangeRejected: true,
      liveZcashNoteBinding: false,
      liveFheExecution: false,
      readyForFundedTest: false,
    };
    if (zkProof) {
      const dir = resolve(__dirname, "../../.local/evidence");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(dir, "shared-commitment-binding.json"),
        JSON.stringify(evidence, null, 2),
        { mode: 0o600 },
      );
    }
    console.log(
      JSON.stringify({
        ...evidence,
        nativeProof: zkProof
          ? {
              verified: true,
              proofBytes: zkProof.proofBytes,
              constraints: zkProof.constraints,
              setup: zkProof.setup,
            }
          : null,
      }),
    );
  });
});

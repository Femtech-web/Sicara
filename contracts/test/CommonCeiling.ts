import { expect } from "chai";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const types = {
  Eligibility: [
    { name: "loanId", type: "bytes32" },
    { name: "borrower", type: "address" },
    { name: "claim", type: "bytes32" },
    { name: "custodyKey", type: "bytes32" },
    { name: "root", type: "bytes32" },
    { name: "snapshotBlock", type: "bytes32" },
    { name: "snapshotHeight", type: "uint64" },
    { name: "proofHash", type: "bytes32" },
    { name: "validUntil", type: "uint64" },
  ],
};
const opaque = () => ethers.hexlify(ethers.randomBytes(32));
describe("Common ceiling (experimental trusted admission; synthetic note root)", function () {
  this.timeout(180_000);
  before(function () {
    if (!fhevm.isMock) this.skip();
  });
  it("derives the same public ceiling without collateral ciphertext, preserves private borrowing, and consumes claim/key once", async () => {
    const [attestor, alice, bob, stranger] = await ethers.getSigners();
    const token = await ethers.deployContract("DemoZama", [attestor.address]);
    const pool = await ethers.deployContract("CommonCeilingLoanProbe", [
      await token.getAddress(),
      attestor.address,
      9_999,
    ]);
    const address = await pool.getAddress();
    await token.mint(address, 10_000_000n);
    const domain = {
      name: "SicaraCommonCeiling",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: address,
    };
    const validUntil =
      (await ethers.provider.getBlock("latest"))!.timestamp + 115;
    const a = {
      loanId: opaque(),
      borrower: alice.address,
      claim: opaque(),
      custodyKey: opaque(),
      root: opaque(),
      snapshotBlock: opaque(),
      snapshotHeight: 1000,
      proofHash: opaque(),
      validUntil,
    };
    let nativeProof = false;
    if (process.env.SICARA_PRIVACY_PROBE_BIN) {
      const context = await pool.eligibilityContext(
        a.loanId,
        alice.address,
        validUntil,
      );
      const binary = process.env.SICARA_PRIVACY_PROBE_BIN;
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RAYON_NUM_THREADS: "2",
        NODE_ENV: "test",
      };
      const probe = spawnSync(
        binary,
        [
          "--note-eligibility",
          "--export-fixture",
          "--public-context",
          context.slice(2),
        ],
        { env, encoding: "utf8", timeout: 120_000, maxBuffer: 1_000_000 },
      );
      assert.equal(probe.status, 0, "Native note eligibility probe failed");
      const report = JSON.parse(probe.stdout);
      assert.equal(report.proofVerified, true);
      assert.equal(report.canonicalChainRootVerified, false);
      const proof = report.fixture;
      assert.equal(proof.publicInputs[7], context.slice(2));
      assert.equal(proof.publicInputs[3], "0f27000000000000" + "00".repeat(24)); // LE 9,999
      const verify = spawnSync(binary, ["--verify-note-eligibility"], {
        env,
        input: JSON.stringify(proof),
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4000,
      });
      assert.equal(verify.status, 0, "Fixed note verifier failed");
      a.claim = "0x" + proof.publicInputs[5];
      a.root = "0x" + proof.publicInputs[0];
      // Public approved key and policy context only; no amount or viewing material.
      a.custodyKey = ethers.keccak256(
        ethers.concat([
          "0x" + proof.publicInputs[1],
          "0x" + proof.publicInputs[2],
        ]),
      );
      a.proofHash = ethers.keccak256("0x" + proof.proof);
      nativeProof = true;
    }
    const signature = await attestor.signTypedData(domain, types, a);
    await expect(
      pool.registerLoan(a.loanId, alice.address, ethers.ZeroHash, "0x"),
    ).to.be.revertedWithCustomError(pool, "EligibilityRequired");
    await expect(
      pool.connect(stranger).registerEligibleLoan(a, signature),
    ).to.be.revertedWithCustomError(pool, "NotBorrower");
    for (const mutation of [
      { loanId: opaque() },
      { root: opaque() },
      { claim: opaque() },
      { custodyKey: opaque() },
      { proofHash: opaque() },
      { snapshotHeight: 1001 },
    ]) {
      await expect(
        pool
          .connect(alice)
          .registerEligibleLoan({ ...a, ...mutation }, signature),
      ).to.be.revertedWithCustomError(pool, "InvalidEligibility");
    }
    const start = await (
      await pool.connect(alice).registerEligibleLoan(a, signature)
    ).wait();
    assert.ok(start);
    const hcu = fhevm.computeTransactionHCU(start);
    const cap = await pool.commonCeiling();
    expect(cap).to.equal(499_950n);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        (await pool.loanState(a.loanId)).capacity,
        address,
        alice,
      ),
    ).to.equal(cap);
    await expect(
      pool.connect(alice).registerEligibleLoan(a, signature),
    ).to.be.revertedWithCustomError(pool, "CollateralAlreadyUsed");
    for (const duplicate of [
      { ...a, loanId: opaque(), borrower: bob.address },
      { ...a, loanId: opaque(), borrower: bob.address, claim: opaque() },
    ]) {
      const signed = await attestor.signTypedData(domain, types, duplicate);
      await expect(
        pool.connect(bob).registerEligibleLoan(duplicate, signed),
      ).to.be.revertedWithCustomError(pool, "CollateralAlreadyUsed");
    }
    const tooMuch = await fhevm
      .createEncryptedInput(address, alice.address)
      .add64(cap + 1n)
      .encrypt();
    await pool
      .connect(alice)
      .borrow(a.loanId, tooMuch.handles[0], tooMuch.inputProof);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        (await pool.loanState(a.loanId)).debt,
        address,
        alice,
      ),
    ).to.equal(0n);
    const input = await fhevm
      .createEncryptedInput(address, alice.address)
      .add64(250_000n)
      .encrypt();
    await pool
      .connect(alice)
      .borrow(a.loanId, input.handles[0], input.inputProof);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        (await pool.loanState(a.loanId)).debt,
        address,
        alice,
      ),
    ).to.equal(250_000n);
    await assert.rejects(
      fhevm.userDecryptEuint(
        FhevmType.euint64,
        (await pool.loanState(a.loanId)).debt,
        address,
        stranger,
      ),
    );
    const fresh = {
      ...a,
      loanId: opaque(),
      borrower: bob.address,
      claim: opaque(),
      custodyKey: opaque(),
    };
    const forged = await stranger.signTypedData(domain, types, fresh);
    await expect(
      pool.connect(bob).registerEligibleLoan(fresh, forged),
    ).to.be.revertedWithCustomError(pool, "InvalidEligibility");
    for (const badDomain of [
      { ...domain, chainId: 1n },
      { ...domain, verifyingContract: stranger.address },
    ]) {
      const signed = await attestor.signTypedData(badDomain, types, fresh);
      await expect(
        pool.connect(bob).registerEligibleLoan(fresh, signed),
      ).to.be.revertedWithCustomError(pool, "InvalidEligibility");
    }
    const later = {
      ...fresh,
      validUntil: (await ethers.provider.getBlock("latest"))!.timestamp + 500,
    };
    await expect(
      pool
        .connect(bob)
        .registerEligibleLoan(
          later,
          await attestor.signTypedData(domain, types, later),
        ),
    ).to.be.revertedWithCustomError(pool, "ExpiredEligibility");
    await pool
      .connect(bob)
      .registerEligibleLoan(
        fresh,
        await attestor.signTypedData(domain, types, fresh),
      );
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        (await pool.loanState(fresh.loanId)).capacity,
        address,
        bob,
      ),
    ).to.equal(cap);
    await token
      .connect(alice)
      .setOperator(
        address,
        (await ethers.provider.getBlock("latest"))!.timestamp + 120,
      );
    const repay = await fhevm
      .createEncryptedInput(address, alice.address)
      .add64(250_000n)
      .encrypt();
    await pool
      .connect(alice)
      .repay(a.loanId, repay.handles[0], repay.inputProof);
    await pool.connect(alice).requestSettlement(a.loanId);
    const result = await fhevm.publicDecrypt([
      (await pool.loanState(a.loanId)).settlementHandle,
    ]);
    await pool.finalizeSettlement(a.loanId, true, result.decryptionProof);
    expect((await pool.loanState(a.loanId)).settled).to.equal(true);
    const evidence = {
      scope: "common-ceiling-local-fhevm-mock",
      realNativeNoteProofVerified: nativeProof,
      syntheticRoot: true,
      registrationTransactions: 1,
      registrationGlobalHCU: hcu.globalHCU,
      registrationGas: start.gasUsed.toString(),
      samePolicyCeiling: true,
      clientCapacityInputAccepted: false,
      claimAndKeyReuseRejected: true,
      privateBorrowAndRepayPassed: true,
      trustedAttestorRequired: true,
      consensusProven: false,
      coSignerReleaseEnforced: false,
      readyForFundedTest: false,
    };
    console.log(JSON.stringify(evidence));
    if (nativeProof) {
      const folder = resolve(__dirname, "../../.local/evidence");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(folder, "common-ceiling-feasibility.json"),
        JSON.stringify(evidence, null, 2),
        { mode: 0o600 },
      );
    }
  });
});

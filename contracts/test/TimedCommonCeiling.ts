import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

async function timedLoan() {
  const [operator, borrower, watcher] = await ethers.getSigners();
  const token = await ethers.deployContract("DemoZama", [operator.address]);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const pool = await ethers.deployContract("TimedCommonCeilingLoanProbe", [
    await token.getAddress(),
    operator.address,
    100_000,
    now + 600,
    now + 900,
  ]);
  const address = await pool.getAddress();
  await token.mint(address, 10_000_000);
  const h = () => ethers.hexlify(ethers.randomBytes(32));
  const eligibility = {
    loanId: h(),
    borrower: borrower.address,
    claim: h(),
    custodyKey: h(),
    root: h(),
    snapshotBlock: h(),
    snapshotHeight: 1000,
    proofHash: h(),
    validUntil: now + 110,
  };
  const fields = [
    ["loanId", "bytes32"],
    ["borrower", "address"],
    ["claim", "bytes32"],
    ["custodyKey", "bytes32"],
    ["root", "bytes32"],
    ["snapshotBlock", "bytes32"],
    ["snapshotHeight", "uint64"],
    ["proofHash", "bytes32"],
    ["validUntil", "uint64"],
  ].map(([name, type]) => ({ name, type }));
  await pool
    .connect(borrower)
    .registerEligibleLoan(
      eligibility,
      await operator.signTypedData(
        {
          name: "SicaraCommonCeiling",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: address,
        },
        { Eligibility: fields },
        eligibility,
      ),
    );
  return {
    pool,
    token,
    borrower,
    watcher,
    id: eligibility.loanId,
    address,
    now,
  };
}

describe("Isolated common-ceiling maturity cutoffs", function () {
  before(function () {
    if (!fhevm.isMock) this.skip();
  });
  it("returns a delayed repayment decision to the client even after the normal settlement deadline", async function () {
    const { pool, token, borrower, watcher, id, address, now } =
      await timedLoan();
    const input = await fhevm
      .createEncryptedInput(address, borrower.address)
      .add64(100_000)
      .encrypt();
    await pool.connect(borrower).borrow(id, input.handles[0], input.inputProof);
    await token.connect(borrower).setOperator(address, now + 1000);
    const repay = await fhevm
      .createEncryptedInput(address, borrower.address)
      .add64(100_000)
      .encrypt();
    await pool.connect(borrower).repay(id, repay.handles[0], repay.inputProof);
    await expect(pool.requestResolution(id)).to.be.revertedWithCustomError(
      pool,
      "ResolutionNotReady",
    );
    // Simulate a KMS/worker outage beyond the old settlement and release windows.
    await ethers.provider.send("evm_setNextBlockTimestamp", [now + 1500]);
    await pool.connect(watcher).requestResolution(id);
    const handle = await pool.resolutionHandle(id);
    const proof = await fhevm.publicDecrypt([handle]);
    await expect(pool.finalizeResolution(id, false, proof.decryptionProof)).to
      .be.reverted;
    await expect(
      pool.connect(watcher).finalizeResolution(id, true, proof.decryptionProof),
    )
      .to.emit(pool, "LoanResolved")
      .withArgs(id, true);
    expect(await pool.resolution(id)).to.equal(1);
    expect((await pool.loanState(id)).settled).to.equal(true);
    await expect(
      pool.finalizeResolution(id, true, proof.decryptionProof),
    ).to.be.revertedWithCustomError(pool, "ResolutionAlreadyFinal");
  });
  it("requires a verified nonzero-debt bit for default; unknown and never-borrowed loans are not defaults", async function () {
    const { pool, borrower, id, address, now } = await timedLoan();
    const input = await fhevm
      .createEncryptedInput(address, borrower.address)
      .add64(100_000)
      .encrypt();
    await pool.connect(borrower).borrow(id, input.handles[0], input.inputProof);
    await ethers.provider.send("evm_setNextBlockTimestamp", [now + 1500]);
    expect(await pool.resolution(id)).to.equal(0);
    await expect(
      pool.finalizeResolution(id, false, "0x"),
    ).to.be.revertedWithCustomError(pool, "ResolutionNotReady");
    await pool.requestResolution(id);
    const handle = await pool.resolutionHandle(id);
    await pool.requestResolution(id);
    expect(await pool.resolutionHandle(id)).to.equal(handle);
    const proof = await fhevm.publicDecrypt([handle]);
    await expect(pool.finalizeResolution(id, true, proof.decryptionProof)).to.be
      .reverted;
    await pool.finalizeResolution(id, false, proof.decryptionProof);
    expect(await pool.resolution(id)).to.equal(2);
    await expect(
      pool.connect(borrower).repay(id, input.handles[0], input.inputProof),
    ).to.be.revertedWithCustomError(pool, "LoanWindowClosed");
    const cancelled = await timedLoan();
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      cancelled.now + 1500,
    ]);
    await cancelled.pool.requestResolution(cancelled.id);
    const zero = await fhevm.publicDecrypt([
      await cancelled.pool.resolutionHandle(cancelled.id),
    ]);
    await cancelled.pool.finalizeResolution(
      cancelled.id,
      true,
      zero.decryptionProof,
    );
    expect(await cancelled.pool.resolution(cancelled.id)).to.equal(1);
  });
  it("rejects unsafe schedules and rejects late token actions before processing ciphertext", async function () {
    const [operator, borrower] = await ethers.getSigners();
    const token = await ethers.deployContract("DemoZama", [operator.address]);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const factory = await ethers.getContractFactory(
      "TimedCommonCeilingLoanProbe",
    );
    await expect(
      factory.deploy(
        await token.getAddress(),
        operator.address,
        100_000,
        now + 30,
        now + 400,
      ),
    ).to.be.revertedWithCustomError(factory, "InvalidSchedule");
    const repayment = now + 600;
    const settlement = now + 900;
    const pool = await factory.deploy(
      await token.getAddress(),
      operator.address,
      100_000,
      repayment,
      settlement,
    );
    const id = ethers.hexlify(ethers.randomBytes(32));
    // Before cutoff the inherited loan checks apply; no loan exists in this test.
    await expect(
      pool.connect(borrower).repay(id, ethers.ZeroHash, "0x"),
    ).to.be.revertedWithCustomError(pool, "InvalidLoan");
    await ethers.provider.send("evm_setNextBlockTimestamp", [repayment]);
    await expect(
      pool.connect(borrower).repay(id, ethers.ZeroHash, "0x"),
    ).to.be.revertedWithCustomError(pool, "LoanWindowClosed");
    await expect(
      pool.connect(borrower).borrow(id, ethers.ZeroHash, "0x"),
    ).to.be.revertedWithCustomError(pool, "LoanWindowClosed");
    // Settlement gets a separate buffer after token repayment has closed.
    await expect(
      pool.connect(borrower).requestSettlement(id),
    ).to.be.revertedWithCustomError(pool, "InvalidLoan");
    await ethers.provider.send("evm_setNextBlockTimestamp", [settlement]);
    await expect(
      pool.connect(borrower).requestSettlement(id),
    ).to.be.revertedWithCustomError(pool, "LoanWindowClosed");
    await expect(
      pool.finalizeSettlement(id, true, "0x"),
    ).to.be.revertedWithCustomError(pool, "LoanWindowClosed");
  });
  it("cancels zero debt with a KMS proof and freezes draws before that proof is published", async function () {
    const [operator, borrower] = await ethers.getSigners();
    const token = await ethers.deployContract("DemoZama", [operator.address]);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const pool = await ethers.deployContract("TimedCommonCeilingLoanProbe", [
      await token.getAddress(),
      operator.address,
      100_000,
      now + 600,
      now + 900,
    ]);
    const address = await pool.getAddress();
    await token.mint(address, 10_000_000);
    const opaque = () => ethers.hexlify(ethers.randomBytes(32));
    const eligibility = {
      loanId: opaque(),
      borrower: borrower.address,
      claim: opaque(),
      custodyKey: opaque(),
      root: opaque(),
      snapshotBlock: opaque(),
      snapshotHeight: 1000,
      proofHash: opaque(),
      validUntil: now + 110,
    };
    const fields = [
      ["loanId", "bytes32"],
      ["borrower", "address"],
      ["claim", "bytes32"],
      ["custodyKey", "bytes32"],
      ["root", "bytes32"],
      ["snapshotBlock", "bytes32"],
      ["snapshotHeight", "uint64"],
      ["proofHash", "bytes32"],
      ["validUntil", "uint64"],
    ].map(([name, type]) => ({ name, type }));
    const signature = await operator.signTypedData(
      {
        name: "SicaraCommonCeiling",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: address,
      },
      { Eligibility: fields },
      eligibility,
    );
    await pool.connect(borrower).registerEligibleLoan(eligibility, signature);
    await pool.connect(borrower).requestSettlement(eligibility.loanId);
    const handle = (await pool.loanState(eligibility.loanId)).settlementHandle;
    const proof = await fhevm.publicDecrypt([handle]);
    const input = await fhevm
      .createEncryptedInput(address, borrower.address)
      .add64(100_000)
      .encrypt();
    await pool
      .connect(borrower)
      .borrow(eligibility.loanId, input.handles[0], input.inputProof);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        (await pool.loanState(eligibility.loanId)).debt,
        address,
        borrower,
      ),
    ).to.equal(0n);
    await pool.finalizeSettlement(
      eligibility.loanId,
      true,
      proof.decryptionProof,
    );
    expect((await pool.loanState(eligibility.loanId)).settled).to.equal(true);
    await expect(
      pool
        .connect(borrower)
        .borrow(eligibility.loanId, input.handles[0], input.inputProof),
    ).to.be.revertedWithCustomError(pool, "AlreadySettled");
  });
});

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { DemoZama, ConfidentialLoanSpike } from "../types";

const UNIT = 100_000_000n;
describe("ConfidentialLoanSpike (local FHEVM mock, not live testnet evidence)", function () {
  let token: DemoZama;
  let pool: ConfidentialLoanSpike;
  let operator: HardhatEthersSigner;
  let borrower: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let id: string;

  async function input(signer: HardhatEthersSigner, amount: bigint) {
    return fhevm.createEncryptedInput(await pool.getAddress(), signer.address).add64(amount).encrypt();
  }
  async function register(capacity = 500n * UNIT) {
    const encrypted = await input(operator, capacity);
    await (await pool.registerLoan(id, borrower.address, encrypted.handles[0], encrypted.inputProof)).wait();
  }
  async function borrow(amount: bigint) {
    const encrypted = await input(borrower, amount);
    await (await pool.connect(borrower).borrow(id, encrypted.handles[0], encrypted.inputProof)).wait();
  }
  async function repay(amount: bigint) {
    const encrypted = await input(borrower, amount);
    await (await pool.connect(borrower).repay(id, encrypted.handles[0], encrypted.inputProof)).wait();
  }
  async function debt() {
    return fhevm.userDecryptEuint(FhevmType.euint64, (await pool.loanState(id)).debt, await pool.getAddress(), borrower);
  }
  async function balance() {
    return fhevm.userDecryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(borrower.address), await token.getAddress(), borrower);
  }
  async function approve() {
    const block = await ethers.provider.getBlock("latest");
    await (await token.connect(borrower).setOperator(await pool.getAddress(), block!.timestamp + 3600)).wait();
  }
  async function outcome() {
    await (await pool.connect(borrower).requestSettlement(id)).wait();
    const handle = (await pool.loanState(id)).settlementHandle;
    return fhevm.publicDecrypt([handle]);
  }
  before(function () { if (!fhevm.isMock) this.skip(); });
  beforeEach(async () => {
    [operator, borrower, stranger] = await ethers.getSigners();
    token = await ethers.deployContract("DemoZama", [operator.address]);
    await token.waitForDeployment();
    pool = await ethers.deployContract("ConfidentialLoanSpike", [await token.getAddress(), operator.address]);
    await pool.waitForDeployment();
    await (await token.mint(await pool.getAddress(), 10_000n * UNIT)).wait();
    id = ethers.hexlify(ethers.randomBytes(32));
  });

  it("delivers confidential tokens, tracks partial repayment and verifies the final one-bit proof", async () => {
    await register(); await borrow(250n * UNIT);
    expect(await token.decimals()).to.equal(8);
    expect(await debt()).to.equal(250n * UNIT);
    expect(await balance()).to.equal(250n * UNIT);
    await approve(); await repay(100n * UNIT);
    expect(await debt()).to.equal(150n * UNIT);
    const partial = await outcome();
    await expect(pool.finalizeSettlement(id, false, partial.decryptionProof)).to.be.revertedWithCustomError(pool, "NotRepaid");
    await repay(150n * UNIT);
    expect(await debt()).to.equal(0);
    expect(await balance()).to.equal(0);
    const full = await outcome();
    await expect(pool.finalizeSettlement(id, true, full.decryptionProof)).to.emit(pool, "LoanSettled").withArgs(id);
    expect((await pool.loanState(id)).settled).to.equal(true);
    await expect(pool.finalizeSettlement(id, true, full.decryptionProof)).to.be.revertedWithCustomError(pool, "AlreadySettled");
  });
  it("does not issue for an encrypted over-limit amount and permits a valid retry", async () => {
    await register(); await borrow(501n * UNIT);
    expect(await debt()).to.equal(0);
    expect(await balance()).to.equal(0);
    await borrow(200n * UNIT);
    expect(await debt()).to.equal(200n * UNIT);
  });
  it("does not issue a second loan or re-borrow after repaying", async () => {
    await register(); await borrow(200n * UNIT); await borrow(100n * UNIT);
    expect(await debt()).to.equal(200n * UNIT);
    await approve(); await repay(200n * UNIT); await borrow(100n * UNIT);
    expect(await debt()).to.equal(0);
    expect(await balance()).to.equal(0);
  });
  it("rejects duplicate registration and non-owner/non-borrower operations", async () => {
    const capacity = await input(operator, UNIT);
    await expect(pool.connect(stranger).registerLoan(id, borrower.address, capacity.handles[0], capacity.inputProof)).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    await register();
    await expect(pool.registerLoan(id, borrower.address, capacity.handles[0], capacity.inputProof)).to.be.revertedWithCustomError(pool, "AlreadyRegistered");
    await expect(pool.connect(stranger).requestSettlement(id)).to.be.revertedWithCustomError(pool, "NotBorrower");
    const amount = await input(stranger, UNIT);
    await expect(pool.connect(stranger).borrow(id, amount.handles[0], amount.inputProof)).to.be.revertedWithCustomError(pool, "NotBorrower");
  });
  it("does not let unrelated users decrypt private debt", async () => {
    await register(); await borrow(250n * UNIT);
    let rejected = false;
    try { await fhevm.userDecryptEuint(FhevmType.euint64, (await pool.loanState(id)).debt, await pool.getAddress(), stranger); }
    catch { rejected = true; }
    expect(rejected).to.equal(true);
  });
  it("does not settle a never-issued zero-debt registration or accept a forged proof", async () => {
    await register();
    const result = await outcome();
    await expect(pool.finalizeSettlement(id, false, result.decryptionProof)).to.be.revertedWithCustomError(pool, "NotRepaid");
    await expect(pool.finalizeSettlement(id, true, "0x")).to.be.reverted;
  });
  it("caps repayment at debt and requires unexpired operator permission", async () => {
    await register(); await borrow(250n * UNIT);
    const amount = await input(borrower, 500n * UNIT);
    await expect(pool.connect(borrower).repay(id, amount.handles[0], amount.inputProof)).to.be.reverted;
    await approve(); await repay(500n * UNIT);
    expect(await debt()).to.equal(0);
    expect(await balance()).to.equal(0);
  });
  it("does not create debt when the pool lacks liquidity", async () => {
    const emptyPool = await ethers.deployContract("ConfidentialLoanSpike", [await token.getAddress(), operator.address]);
    const capacity = await fhevm.createEncryptedInput(await emptyPool.getAddress(), operator.address).add64(500n * UNIT).encrypt();
    await emptyPool.registerLoan(id, borrower.address, capacity.handles[0], capacity.inputProof);
    const amount = await fhevm.createEncryptedInput(await emptyPool.getAddress(), borrower.address).add64(250n * UNIT).encrypt();
    await emptyPool.connect(borrower).borrow(id, amount.handles[0], amount.inputProof);
    const clear = await fhevm.userDecryptEuint(FhevmType.euint64, (await emptyPool.loanState(id)).debt, await emptyPool.getAddress(), borrower);
    expect(clear).to.equal(0);
  });
});

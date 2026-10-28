import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { AttestedLoanPilot, DemoZama } from "../types";

const authorizationTypes = { CollateralAuthorization: [
  { name: "loanId", type: "bytes32" }, { name: "borrower", type: "address" },
  { name: "depositCommitment", type: "bytes32" }, { name: "capacityInput", type: "bytes32" },
  { name: "inputProofHash", type: "bytes32" }, { name: "policyHash", type: "bytes32" },
  { name: "validUntil", type: "uint64" },
] };
const policyHash = ethers.id("sicara:test-only:demo-prices:50-percent:zero-interest:v1");
const UNIT = 100_000_000n;

describe("AttestedLoanPilot (local mock; no claim of live Zcash attestation)", function () {
  let pool: AttestedLoanPilot;
  let token: DemoZama;
  let operator: HardhatEthersSigner;
  let borrower: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  async function fixture() {
    const encrypted = await fhevm.createEncryptedInput(await pool.getAddress(), borrower.address).add64(50n * UNIT).encrypt();
    const authorization = {
      loanId: ethers.hexlify(ethers.randomBytes(32)), borrower: borrower.address,
      // Opaque random commitment, not a public address/txid or unsalted low-entropy amount hash.
      depositCommitment: ethers.hexlify(ethers.randomBytes(32)),
      capacityInput: ethers.hexlify(encrypted.handles[0]),
      inputProofHash: ethers.keccak256(encrypted.inputProof), policyHash,
      validUntil: (await ethers.provider.getBlock("latest"))!.timestamp + 600,
    };
    const domain = { name: "SicaraCollateral", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await pool.getAddress() };
    const signature = await operator.signTypedData(domain, authorizationTypes, authorization);
    return { authorization, proof: encrypted.inputProof, domain, signature };
  }
  before(function () { if (!fhevm.isMock) this.skip(); });
  beforeEach(async () => {
    [operator, borrower, stranger] = await ethers.getSigners();
    token = await ethers.deployContract("DemoZama", [operator.address]);
    pool = await ethers.deployContract("AttestedLoanPilot", [await token.getAddress(), operator.address, policyHash]);
    await token.mint(await pool.getAddress(), 1_000n * UNIT);
  });

  it("imports the signed encrypted capacity, enforces it, borrows and settles repayment", async () => {
    const { authorization: a, proof, signature } = await fixture();
    await expect(pool.connect(borrower).registerAttestedLoan(a, proof, signature)).to.emit(pool, "CollateralAuthorized").withArgs(a.loanId, a.depositCommitment);
    const capacity = await fhevm.userDecryptEuint(FhevmType.euint64, (await pool.loanState(a.loanId)).capacity, await pool.getAddress(), borrower);
    expect(capacity).to.equal(50n * UNIT);
    const oversized = await fhevm.createEncryptedInput(await pool.getAddress(), borrower.address).add64(51n * UNIT).encrypt();
    await pool.connect(borrower).borrow(a.loanId, oversized.handles[0], oversized.inputProof);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, (await pool.loanState(a.loanId)).debt, await pool.getAddress(), borrower)).to.equal(0);
    const amount = await fhevm.createEncryptedInput(await pool.getAddress(), borrower.address).add64(40n * UNIT).encrypt();
    await pool.connect(borrower).borrow(a.loanId, amount.handles[0], amount.inputProof);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(borrower.address), await token.getAddress(), borrower)).to.equal(40n * UNIT);
    await token.connect(borrower).setOperator(await pool.getAddress(), a.validUntil);
    const repayment = await fhevm.createEncryptedInput(await pool.getAddress(), borrower.address).add64(40n * UNIT).encrypt();
    await pool.connect(borrower).repay(a.loanId, repayment.handles[0], repayment.inputProof);
    await pool.connect(borrower).requestSettlement(a.loanId);
    const result = await fhevm.publicDecrypt([(await pool.loanState(a.loanId)).settlementHandle]);
    await pool.finalizeSettlement(a.loanId, true, result.decryptionProof);
    expect((await pool.loanState(a.loanId)).settled).to.equal(true);
  });

  it("rejects unsigned owner registration and a third party submitting a borrower authorization", async () => {
    const { authorization: a, proof, signature } = await fixture();
    await expect(pool.registerLoan(a.loanId, borrower.address, a.capacityInput, proof)).to.be.revertedWithCustomError(pool, "AttestationRequired");
    await expect(pool.connect(stranger).registerAttestedLoan(a, proof, signature)).to.be.revertedWithCustomError(pool, "NotBorrower");
  });

  it("rejects forged signer, wrong chain and another deployment's signatures", async () => {
    const { authorization: a, proof, domain } = await fixture();
    const signatures = [
      await stranger.signTypedData(domain, authorizationTypes, a),
      await operator.signTypedData({ ...domain, chainId: 1 }, authorizationTypes, a),
      await operator.signTypedData({ ...domain, verifyingContract: stranger.address }, authorizationTypes, a),
    ];
    for (const signature of signatures) await expect(pool.connect(borrower).registerAttestedLoan(a, proof, signature)).to.be.revertedWithCustomError(pool, "InvalidAuthorization");
    expect(await pool.consumedDeposit(a.depositCommitment)).to.equal(false);
  });

  it("binds the ciphertext, proof, loan, deposit, policy, borrower and expiry", async () => {
    const { authorization: a, proof, signature } = await fixture();
    for (const mutation of [
      { capacityInput: ethers.hexlify(ethers.randomBytes(32)) },
      { loanId: ethers.id("another-loan") }, { depositCommitment: ethers.id("another-deposit") },
      { policyHash: ethers.id("another-policy") }, { validUntil: a.validUntil + 60 },
    ]) await expect(pool.connect(borrower).registerAttestedLoan({ ...a, ...mutation }, proof, signature)).to.be.revertedWithCustomError(pool, "InvalidAuthorization");
    await expect(pool.connect(borrower).registerAttestedLoan(a, "0x", signature)).to.be.revertedWithCustomError(pool, "InvalidAuthorization");
    await expect(pool.connect(stranger).registerAttestedLoan({ ...a, borrower: stranger.address }, proof, signature)).to.be.revertedWithCustomError(pool, "InvalidAuthorization");
  });

  it("rejects expired authorizations and consumes each deposit only once across loans", async () => {
    const { authorization: a, proof, domain, signature } = await fixture();
    await pool.connect(borrower).registerAttestedLoan(a, proof, signature);
    await expect(pool.connect(borrower).registerAttestedLoan(a, proof, signature)).to.be.revertedWithCustomError(pool, "DepositAlreadyConsumed");
    const second = { ...a, borrower: stranger.address, loanId: ethers.id("other-loan") };
    const secondSignature = await operator.signTypedData(domain, authorizationTypes, second);
    await expect(pool.connect(stranger).registerAttestedLoan(second, proof, secondSignature)).to.be.revertedWithCustomError(pool, "DepositAlreadyConsumed");
    const expired = { ...second, depositCommitment: ethers.id("unused-deposit"), validUntil: 1 };
    const expiredSignature = await operator.signTypedData(domain, authorizationTypes, expired);
    await expect(pool.connect(stranger).registerAttestedLoan(expired, proof, expiredSignature)).to.be.revertedWithCustomError(pool, "ExpiredAuthorization");
  });

  it("rolls back consumption on invalid FHE input and keeps capacity/debt private from unrelated users", async () => {
    const { authorization: a, proof, domain, signature } = await fixture();
    const invalid = { ...a, inputProofHash: ethers.keccak256("0x") };
    const invalidSignature = await operator.signTypedData(domain, authorizationTypes, invalid);
    await expect(pool.connect(borrower).registerAttestedLoan(invalid, "0x", invalidSignature)).to.be.reverted;
    expect(await pool.consumedDeposit(a.depositCommitment)).to.equal(false);
    await pool.connect(borrower).registerAttestedLoan(a, proof, signature);
    let rejected = false;
    try { await fhevm.userDecryptEuint(FhevmType.euint64, (await pool.loanState(a.loanId)).capacity, await pool.getAddress(), stranger); }
    catch { rejected = true; }
    expect(rejected).to.equal(true);
  });
});

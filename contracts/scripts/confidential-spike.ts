import { ethers, fhevm, network } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ContractTransactionResponse } from "ethers";

type Evidence = { chainId: number; network: string; mock: boolean; token: string; pool: string; borrower: string; loanId: string; transactions: Record<string, string>; confirmedBlocks?: Record<string, number>; completed?: boolean; recordedAt: string };
async function main() {
  if (network.name !== "sepolia") throw new Error("Live spike must run on Sepolia");
  await fhevm.initializeCLIApi();
  if (fhevm.isMock) throw new Error("Local mocks do not qualify as live evidence");
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Configure a dedicated test signer locally");
  const tokenAddress = process.env.SICARA_TOKEN_ADDRESS, poolAddress = process.env.SICARA_POOL_ADDRESS;
  if (!tokenAddress || !poolAddress || !ethers.isAddress(tokenAddress) || !ethers.isAddress(poolAddress)) throw new Error("Configure deployed spike addresses");
  if ((await ethers.provider.getNetwork()).chainId !== 11155111n) throw new Error("RPC is not Sepolia");
  const token = await ethers.getContractAt("DemoZama", tokenAddress, signer);
  const pool = await ethers.getContractAt("ConfidentialLoanSpike", poolAddress, signer);
  await fhevm.assertCoprocessorInitialized(pool, "Sicara spike");
  if ((await pool.token()).toLowerCase() !== tokenAddress.toLowerCase() || (await pool.owner()).toLowerCase() !== signer.address.toLowerCase()) throw new Error("Pool/token/operator mismatch");
  const existingId = await pool.loanByBorrower(signer.address);
  const id = existingId === ethers.ZeroHash ? ethers.hexlify(ethers.randomBytes(32)) : existingId;
  const directory = resolve(__dirname, "../../.local/evidence");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidencePath = resolve(directory, `sepolia-${id.slice(2)}.json`);
  let evidence: Evidence = { chainId: 11155111, network: "sepolia", mock: false, token: tokenAddress, pool: poolAddress, borrower: signer.address, loanId: id, transactions: {}, confirmedBlocks: {}, recordedAt: new Date().toISOString() };
  if (existingId !== ethers.ZeroHash) {
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    if (evidence.loanId !== id || evidence.pool.toLowerCase() !== poolAddress.toLowerCase() || evidence.borrower.toLowerCase() !== signer.address.toLowerCase()) throw new Error("Saved evidence mismatch");
    if (evidence.completed) { console.log(`Live round trip already complete: ${evidencePath}`); return; }
    console.log("Resuming saved loan; no new loan registration or issuance.");
  }
  evidence.confirmedBlocks ??= {};
  async function save() { evidence.recordedAt = new Date().toISOString(); await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
  async function record(stage: string, build: () => Promise<ContractTransactionResponse>) {
    const known = evidence.transactions[stage];
    let receipt;
    if (known) receipt = await ethers.provider.getTransactionReceipt(known) ?? await ethers.provider.waitForTransaction(known, 1, 120_000);
    else { const tx = await build(); evidence.transactions[stage] = tx.hash; await save(); receipt = await tx.wait(); }
    if (!receipt || receipt.status !== 1) throw new Error(`${stage} unconfirmed/failed; reconcile its saved hash`);
    evidence.confirmedBlocks![stage] = receipt.blockNumber; await save();
    console.log(`${stage} confirmed at Sepolia block ${receipt.blockNumber}`);
    return receipt.blockNumber;
  }
  // Pin reads to the receipt block: load-balanced RPC "latest" can lag newly mined receipts.
  async function expectPrivate(read: () => Promise<bigint>, expected: bigint, label: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      try { if (await read() === expected) return; } catch { /* coprocessor/KMS or RPC still catching up */ }
      console.log(`Waiting for confirmed ${label} and decryption readiness (${attempt + 1}/12)`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error(`${label} not verified; saved loan remains resumable`);
  }
  const unit = 100_000_000n;
  await record("register", async () => { const e = await fhevm.createEncryptedInput(poolAddress, signer.address).add64(100n * unit).encrypt(); return pool.registerLoan(id, signer.address, e.handles[0], e.inputProof); });
  const borrowedBlock = await record("borrow", async () => { const e = await fhevm.createEncryptedInput(poolAddress, signer.address).add64(40n * unit).encrypt(); return pool.borrow(id, e.handles[0], e.inputProof); });
  await expectPrivate(async () => fhevm.userDecryptEuint(FhevmType.euint64, (await pool.loanState(id, { blockTag: borrowedBlock })).debt, poolAddress, signer), 40n * unit, "issued debt");
  await expectPrivate(async () => fhevm.userDecryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(signer.address, { blockTag: borrowedBlock }), tokenAddress, signer), 40n * unit, "borrower balance");
  await record("approveRepayment", async () => { const block = await ethers.provider.getBlock("latest"); return token.setOperator(poolAddress, block!.timestamp + 3600); });
  const repaidBlock = await record("repay", async () => { const e = await fhevm.createEncryptedInput(poolAddress, signer.address).add64(40n * unit).encrypt(); return pool.repay(id, e.handles[0], e.inputProof); });
  await expectPrivate(async () => fhevm.userDecryptEuint(FhevmType.euint64, (await pool.loanState(id, { blockTag: repaidBlock })).debt, poolAddress, signer), 0n, "repaid debt");
  await expectPrivate(async () => fhevm.userDecryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(signer.address, { blockTag: repaidBlock }), tokenAddress, signer), 0n, "repaid balance");
  const requestedBlock = await record("requestSettlement", () => pool.requestSettlement(id));
  const settledBlock = await record("settle", async () => { const handle = (await pool.loanState(id, { blockTag: requestedBlock })).settlementHandle; const outcome = await fhevm.publicDecrypt([handle]); return pool.finalizeSettlement(id, true, outcome.decryptionProof); });
  if (!(await pool.loanState(id, { blockTag: settledBlock })).settled) throw new Error("Settlement not verified");
  const revokedBlock = await record("revokeOperator", () => token.setOperator(poolAddress, 0));
  if (await token.isOperator(signer.address, poolAddress, { blockTag: revokedBlock })) throw new Error("Operator permission not revoked");
  evidence.completed = true; await save();
  console.log(`Live confidential round trip verified. Evidence: ${evidencePath}`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : "Confidential spike failed"); process.exitCode = 1; });

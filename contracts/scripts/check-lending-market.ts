/** Isolated valueless-token smoke test. Does not register a loan or admit ZEC. */
import { deployments, ethers, fhevm, network } from 'hardhat';
import { FhevmType } from '@fhevm/hardhat-plugin';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ContractTransactionResponse } from 'ethers';

type Report = {
  pool: string; token: string; lender: string; offerId: string; deploymentBlock: number;
  runtimeHash: string; transactions: Record<string, { state: 'intent' | 'submitted' | 'confirmed'; hash?: string; block?: number }>;
  completed: boolean; collateralLoanVerified: false; interestDeliveryVerified: false;
};
async function main() {
  if (network.name !== 'sepolia' || (await ethers.provider.getNetwork()).chainId !== 11155111n) throw new Error('Sepolia only');
  await fhevm.initializeCLIApi();
  if (fhevm.isMock) throw new Error('Live SDK required');
  const [signer] = await ethers.getSigners();
  const deployment = await deployments.get('MatchedLendingPool');
  const tokenDeployment = await deployments.get('ConfidentialTestUSDC');
  const pool = await ethers.getContractAt('MatchedLendingPool', deployment.address, signer);
  const token = await ethers.getContractAt('ConfidentialTestUSDC', tokenDeployment.address, signer);
  if ((await pool.token()).toLowerCase() !== tokenDeployment.address.toLowerCase() || await pool.interestBps() !== 200n || await pool.commonCeiling() !== 50_000n || (await token.owner()).toLowerCase() !== signer.address.toLowerCase()) throw new Error('Unexpected test configuration');
  await fhevm.assertCoprocessorInitialized(pool, 'Isolated lender market');
  const deployed = deployment.transactionHash && await ethers.provider.getTransactionReceipt(deployment.transactionHash);
  if (!deployed || deployed.status !== 1 || (await ethers.provider.getBlock(deployed.blockNumber))?.hash !== deployed.blockHash) throw new Error('Noncanonical deployment');
  const directory = resolve('../.local/evidence');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'lending-market.json');
  const lockPath = resolve(directory, 'lending-market.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const runtimeHash = ethers.keccak256(await ethers.provider.getCode(deployment.address));
    let report: Report;
    try { report = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      report = { pool: deployment.address, token: tokenDeployment.address, lender: signer.address, offerId: ethers.hexlify(ethers.randomBytes(32)), deploymentBlock: deployed.blockNumber, runtimeHash, transactions: {}, completed: false, collateralLoanVerified: false, interestDeliveryVerified: false };
    }
    if (report.pool.toLowerCase() !== deployment.address.toLowerCase() || report.token.toLowerCase() !== tokenDeployment.address.toLowerCase() || report.lender.toLowerCase() !== signer.address.toLowerCase() || report.runtimeHash !== runtimeHash) throw new Error('Saved smoke test mismatch');
    async function save() {
      const temporary = `${path}.tmp`;
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(report, null, 2)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); }
    }
    async function transact(stage: string, build: () => Promise<ContractTransactionResponse>) {
      let saved = report.transactions[stage];
      if (saved && !saved.hash) throw new Error(`${stage}: unresolved send intent; manual reconciliation required`);
      if (!saved) {
        saved = { state: 'intent' }; report.transactions[stage] = saved; await save();
        const sent = await build(); saved.hash = sent.hash; saved.state = 'submitted'; await save();
      }
      let receipt = await ethers.provider.getTransactionReceipt(saved.hash!);
      // Hardhat's wrapped provider does not implement waitForTransaction.
      for (let attempt = 0; !receipt && attempt < 30; attempt++) {
        await new Promise(done => setTimeout(done, 4_000));
        receipt = await ethers.provider.getTransactionReceipt(saved.hash!);
      }
      if (!receipt || receipt.status !== 1 || (await ethers.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error(`${stage}: receipt not verified; do not resend`);
      saved.state = 'confirmed'; saved.block = receipt.blockNumber; await save();
      console.log(`${stage} confirmed: ${saved.hash}`);
      return receipt.blockNumber;
    }
    async function verifyAmount(read: () => Promise<string>, expected: bigint) {
      for (let attempt = 0; attempt < 12; attempt++) {
        try { if (await fhevm.userDecryptEuint(FhevmType.euint64, await read(), deployment.address, signer) === expected) return; } catch { /* bounded KMS readiness retry */ }
        if (attempt < 11) await new Promise(done => setTimeout(done, 5_000));
      }
      throw new Error('Private balance verification failed; saved transactions remain resumable');
    }
    if (report.completed) { console.log('Lender smoke test already complete; no new transactions.'); return; }
    await save();
    await transact('mintTestTokens', () => token.mint(signer.address, 10_000n));
    await transact('approve', async () => token.setOperator(deployment.address, (await ethers.provider.getBlock('latest'))!.timestamp + 1800));
    const supplied = await transact('supply', async () => {
      const encrypted = await fhevm.createEncryptedInput(deployment.address, signer.address).add64(10_000n).encrypt();
      return pool.supply(report.offerId, encrypted.handles[0], encrypted.inputProof);
    });
    if ((await pool.positionState(report.offerId, { blockTag: supplied })).loanId !== ethers.ZeroHash) throw new Error('Smoke offer unexpectedly matched; no automatic withdrawal');
    await verifyAmount(async () => (await pool.positionState(report.offerId, { blockTag: supplied })).available, 10_000n);
    const withdrawn = await transact('withdrawAll', () => pool.withdrawAll(report.offerId));
    await verifyAmount(async () => (await pool.positionState(report.offerId, { blockTag: withdrawn })).available, 0n);
    await transact('revoke', () => token.setOperator(deployment.address, 0));
    report.completed = true; await save();
    console.log(`Live unmatched supply and withdrawal verified: ${path}`);
    console.log('No ZEC collateral, borrower match or lender interest payment was tested.');
  } finally { await lock.close(); await unlink(lockPath); }
}
void main().catch((error: unknown) => {
  const detail = error as { shortMessage?: string; code?: string };
  console.error('Lender smoke test stopped; reconcile its durable evidence before retrying. No ZEC was requested.');
  console.error(detail.shortMessage?.slice(0, 180) ?? (error instanceof Error ? error.message.split('\n')[0].slice(0, 180) : 'Unknown failure'), detail.code ?? '');
  process.exitCode = 1;
});

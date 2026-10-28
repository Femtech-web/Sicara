/** Real testnet-only, resumable funded cancellation/refund proof. Each effect is journalled. */
import { readFile, mkdir, open, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { connectWorker } from "../services/database/worker-connection";
import { TestnetWallet } from "../services/zcash/sidecar-client";
import { SidecarWorkerWallet, refundMemo } from "../services/zcash/worker-wallet";
import { CollateralWorker } from "../services/zcash/collateral-worker";
import { OperationJournal } from "../services/zcash/operation-journal";
import { LoanRepository } from "../src/features/lending/server/loan-repository";
import { object, zatoshis } from "../services/zcash/protocol";

type Evidence = {
  wallet: string; requestKey: string; fundingId: string; amount: string;
  stage: 'new' | 'awaiting_deposit' | 'collateral_ready' | 'cancelled' | 'refund_unknown' | 'complete';
  loanId?: string; depositAddress?: string; fundingTx?: string; refundTx?: string;
  depositConfirmations?: number; refundConfirmations?: number; restartedRuns: string[];
  receiverVerified?: boolean; fundingShieldedVerified?: boolean; completed?: boolean; fundingFee?: string; refundFee?: string;
};
const forIssuance = process.argv.includes('--for-issuance');
const file = resolve(forIssuance ? '.local/evidence/attested-collateral.json' : '.local/evidence/funded-worker.json');
async function save(evidence: Evidence) {
  await mkdir(resolve('.local/evidence'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(evidence, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(resolve('.local/evidence'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function pause(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 30_000);
    signal.addEventListener('abort', finish, { once: true });
  });
}
async function main() {
  if (!process.env.DATABASE_WORKER_URL) throw new Error('Worker database configuration required');
  let evidence: Evidence;
  try { evidence = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    evidence = { wallet: forIssuance ? '0xcc886a72f79BaEd0098432704a65373F52131c54' : privateKeyToAccount(generatePrivateKey()).address, requestKey: randomUUID(), fundingId: randomUUID(), amount: '10000', stage: 'new', restartedRuns: [] };
    await save(evidence);
  }
  if (evidence.amount !== '10000') throw new Error('Unexpected proof amount');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const database = await connectWorker(process.env.DATABASE_WORKER_URL, stop);
  const binary = resolve(process.env.SICARA_ZCASH_BINARY ?? '.local/zcash/bin/zec-sidecar');
  const dataDir = resolve(process.env.SICARA_ZCASH_WALLET_DIR ?? '.local/zcash/wallet');
  const returnDir = resolve('.local/zcash/return-wallet');
  let custody: TestnetWallet | undefined;
  let funder: TestnetWallet | undefined;
  try {
    evidence.restartedRuns.push(randomUUID()); await save(evidence);
    custody = await TestnetWallet.start({ binary, dataDir, signal: controller.signal });
    const gateway = new SidecarWorkerWallet(custody, resolve(process.env.SICARA_ADDRESS_VALIDATOR ?? '.local/zcash/native-target/release/sicara-address-check'));
    const worker = new CollateralWorker(database.database, gateway, new OperationJournal(join(dataDir, 'sicara-operations')));
    await worker.initialize();
    const prior = JSON.parse(await readFile(resolve('.local/evidence/zcash-roundtrip.json'), 'utf8'));
    if (prior.completed !== true) throw new Error('Prior receiver proof required');
    const receiver = await gateway.validate(prior.returnAddress);
    const loans = new LoanRepository(database.database);
    if (evidence.stage === 'complete' && !evidence.loanId) throw new Error('Completed proof is missing its loan identity');
    const loan = evidence.stage === 'complete'
      ? await loans.find(evidence.wallet, evidence.loanId!)
      : await loans.prepare(evidence.wallet, evidence.requestKey, receiver, BigInt(evidence.amount));
    evidence.loanId = loan.id;
    if (evidence.stage === 'collateral_ready') {
      console.log(JSON.stringify({stage:evidence.stage,loanId:loan.id,stoppedForIssuance:true}));
      return;
    }

    if (evidence.stage === 'new') {
      await worker.tick();
      evidence.depositAddress = (await loans.find(evidence.wallet, loan.id)).deposit_address ?? undefined;
      if (!evidence.depositAddress) throw new Error('Allocation not ready');
      await save(evidence);
      funder = await TestnetWallet.start({ binary, dataDir: returnDir, signal: controller.signal });
      if (await funder.address() !== receiver) throw new Error('Funding wallet differs from bound return wallet');
      const journal = new OperationJournal(join(returnDir, 'funded-worker-proof'));
      const key = `refund-${evidence.fundingId}`;
      let operation = await journal.bind(key, { kind: 'test-deposit', loan: loan.id, to: evidence.depositAddress, amount: evidence.amount });
      const memo = refundMemo(evidence.fundingId);
      if (operation.state === 'prepared') {
        if (zatoshis((await funder.balance()).spendable) < 110_000n) throw new Error('Funding wallet needs testnet fee reserve');
        operation = { ...operation, state: 'submitting' }; await journal.save(key, operation);
        const result = await funder.sendRefund(evidence.depositAddress, BigInt(evidence.amount), memo);
        if (typeof result.txid !== 'string' || !/^[a-f0-9]{64}$/.test(result.txid)) throw new Error('Funding outcome unknown');
        operation = { ...operation, state: 'broadcast', txid: result.txid }; await journal.save(key, operation);
        evidence.fundingFee = typeof result.feeZats === 'string' ? result.feeZats : undefined;
      }
      if (!operation.txid) {
        const ledger = await funder.ledger();
        if (!Array.isArray(ledger.entries)) throw new Error('Invalid funding ledger');
        const matches = ledger.entries.map(object).filter(entry => entry.direction === 'sent' && entry.memoHex === memo);
        if (matches.length !== 1 || matches[0].address !== evidence.depositAddress || matches[0].zats !== evidence.amount || typeof matches[0].txid !== 'string') throw new Error('Funding outcome unknown; do not resend');
        operation = { ...operation, state: 'broadcast', txid: matches[0].txid }; await journal.save(key, operation);
      }
      evidence.fundingTx = operation.txid; evidence.stage = 'awaiting_deposit'; await save(evidence);
      console.log(JSON.stringify({ stage: evidence.stage, fundingTx: evidence.fundingTx, zatoshis: evidence.amount, stoppedForRestart: true }));
      return;
    }

    if (evidence.stage === 'cancelled') {
      const send = gateway.sendRefund.bind(gateway);
      gateway.sendRefund = async (destination, amount, id) => {
        const txid = await send(destination, amount, id);
        evidence.refundTx = txid; await save(evidence);
        // Controlled lost-response fault AFTER the native sidecar acknowledges broadcast.
        // The production worker only sees uncertainty and must recover the existing payment.
        throw new Error('Controlled lost response after real testnet broadcast');
      };
      await worker.tick();
      if (!evidence.refundTx) throw new Error('Refund not ready; existing intent remains safe to resume');
      evidence.stage = 'refund_unknown'; await save(evidence);
      console.log(JSON.stringify({ stage: evidence.stage, refundTx: evidence.refundTx, stoppedForRestart: true }));
      return;
    }

    for (let attempt = 0; attempt < (process.argv.includes('--wait') ? 80 : 1); attempt++) {
      if (controller.signal.aborted) return;
      // A completed proof may only inspect history, even if other loans now need work.
      // Never run a mutation-capable worker tick from this verification-only stage.
      const verification = evidence.stage === 'complete' ? await gateway.scan() : undefined;
      if (!verification) await worker.tick();
      const current = await loans.find(evidence.wallet, loan.id);
      const clock = await database.database.query<{ last_tip: string }>('SELECT last_tip FROM sicara.wallet_worker WHERE singleton=true');
      const tip = verification?.tip ?? Number(clock.rows[0].last_tip);
      if (evidence.stage === 'awaiting_deposit') {
        const observations = await database.database.query<{ height: string | null; zatoshis: string }>('SELECT height,zatoshis::text FROM sicara.deposit_observations WHERE loan_id=$1 AND present', [loan.id]);
        evidence.depositConfirmations = Math.min(...observations.rows.map(note => note.height === null ? 0 : Math.max(0, tip - Number(note.height) + 1)), 10);
        if (!observations.rows.length) evidence.depositConfirmations = 0;
        if (current.state === 'collateral_verified') {
          if (observations.rows.reduce((sum, note) => sum + BigInt(note.zatoshis), 0n) !== BigInt(evidence.amount)) throw new Error('Unexpected funded amount');
          if (forIssuance) {
            evidence.stage = 'collateral_ready'; await save(evidence);
            console.log(JSON.stringify({stage:evidence.stage,depositConfirmations:evidence.depositConfirmations,stoppedForIssuance:true}));
            return;
          }
          await loans.cancel(evidence.wallet, loan.id);
          evidence.stage = 'cancelled'; await save(evidence);
          console.log(JSON.stringify({ stage: evidence.stage, depositConfirmations: evidence.depositConfirmations, stoppedForRestart: true }));
          return;
        }
        if (!['awaiting_deposit', 'confirming'].includes(current.state)) throw new Error('Unexpected deposit state; reconcile existing intent');
      } else {
        const payments = await database.database.query<{ id: string; state: string; txid: string; confirmed_height: string | null; zatoshis: string }>('SELECT id,state,txid,confirmed_height,zatoshis::text FROM sicara.refund_payments WHERE loan_id=$1 ORDER BY sequence', [loan.id]);
        if (payments.rows.length !== 1 || payments.rows[0].txid && payments.rows[0].txid !== evidence.refundTx) throw new Error('Unexpected refund history');
        const payment = payments.rows[0];
        if (payment.confirmed_height) evidence.refundConfirmations = tip - Number(payment.confirmed_height) + 1;
        if (current.state === 'refunded' && payment.state === 'confirmed') {
          if (payment.zatoshis !== evidence.amount || !await gateway.inspectShielded(payment.txid)) throw new Error('Refund evidence mismatch');
          if (!evidence.fundingTx || !await gateway.inspectShielded(evidence.fundingTx)) throw new Error('Funding was not fully shielded');
          funder = await TestnetWallet.start({ binary, dataDir: returnDir, signal: controller.signal });
          await funder.sync();
          const received = await funder.deposits(0);
          const notes = received.notes.filter(note => note.txid === payment.txid && note.address === receiver && note.source === 'wallet' && note.height !== null && received.tip - note.height + 1 >= 10);
          if (received.stale || notes.reduce((sum, note) => sum + note.zatoshis, 0n) !== BigInt(evidence.amount)) throw new Error('Independent return scan not ready');
          const ledger = await custody.ledger();
          const entries = Array.isArray(ledger.entries) ? ledger.entries.map(object).filter(entry => entry.direction === 'sent' && entry.memoHex === refundMemo(payment.id)) : [];
          if (entries.length !== 1 || entries[0].txid !== payment.txid || entries[0].address !== receiver || entries[0].zats !== evidence.amount) throw new Error('Expected exactly one outgoing return');
          if (entries[0].height !== Number(payment.confirmed_height) || tip - Number(entries[0].height) + 1 < 10) throw new Error('Outgoing confirmation history changed');
          evidence.refundFee = typeof entries[0].feeZats === 'string' ? entries[0].feeZats : undefined;
          evidence.receiverVerified = true; evidence.fundingShieldedVerified = true; evidence.completed = true; evidence.stage = 'complete'; await save(evidence);
          console.log(JSON.stringify({ stage: 'complete', depositConfirmations: evidence.depositConfirmations, refundConfirmations: evidence.refundConfirmations, refundTx: evidence.refundTx, duplicateSends: false, receiverVerified: true }));
          return;
        }
      }
      await save(evidence);
      console.log(JSON.stringify({ stage: evidence.stage, loanState: current.state, depositConfirmations: evidence.depositConfirmations, refundConfirmations: evidence.refundConfirmations ?? 0 }));
      if (attempt < 79 && process.argv.includes('--wait')) await pause(controller.signal);
    }
  } finally {
    await funder?.close(); await custody?.close(); await database.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
void main().catch(() => { console.error('Funded worker check stopped. Preserve its evidence and operation journal; reconcile before any retry. No credentials were logged.'); process.exitCode = 1; });

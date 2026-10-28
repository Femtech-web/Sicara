/** Unfunded hosted readiness canary. Refuses a database containing other loan requests. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { connectWorker } from "../services/database/worker-connection";
import { connectionOptions } from "../services/database/connection-options";
import type { Database } from "../services/database/types";
import { TestnetWallet } from "../services/zcash/sidecar-client";
import { SidecarWorkerWallet } from "../services/zcash/worker-wallet";
import { CollateralWorker } from "../services/zcash/collateral-worker";
import { OperationJournal } from "../services/zcash/operation-journal";
import { LoanRepository } from "../src/features/lending/server/loan-repository";
import { WalletAuth, hashToken } from "../src/features/wallet/server/auth";

type Evidence = { wallet: string; requestKey: string; loanId?: string; depositAddress?: string; completed: boolean; sends: number; checkedAt?: string };

async function main() {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_WORKER_URL || !process.env.SICARA_APP_ORIGIN) throw new Error("Database configuration required");
  const evidencePath = resolve(".local/evidence/worker-readiness.json");
  let evidence: Evidence;
  const account = privateKeyToAccount(generatePrivateKey());
  try { evidence = JSON.parse(await readFile(evidencePath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    evidence = { wallet: account.address, requestKey: randomUUID(), completed: false, sends: 0 };
    await mkdir(resolve('.local/evidence'), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  const database = await connectWorker(process.env.DATABASE_WORKER_URL);
  const application = new Client({ ...connectionOptions(process.env.DATABASE_URL), connectionTimeoutMillis: 10_000 });
  let wallet: TestnetWallet | undefined;
  try {
    let excluded = false;
    try {
      const competing = await connectWorker(process.env.DATABASE_WORKER_URL);
      await competing.close();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Another collateral worker')) throw error;
      excluded = true;
    }
    if (!excluded) throw new Error('Database did not exclude a competing worker connection');
    const existing = await database.database.query("SELECT id FROM sicara.loans WHERE wallet <> $1 OR request_key <> $2 LIMIT 1", [evidence.wallet.toLowerCase(), evidence.requestKey]);
    if (existing.rows.length) throw new Error("Readiness canary requires an otherwise empty loan database");
    await application.connect();
    await application.query('SET ROLE sicara_backend');
    const appDb: Database = {
      query: (text, values) => application.query(text, values),
      async transaction(run) {
        await application.query('BEGIN');
        try { const result = await run(application); await application.query('COMMIT'); return result; }
        catch (error) { await application.query('ROLLBACK'); throw error; }
      },
    };
    {
      const auth = new WalletAuth(appDb, process.env.SICARA_APP_ORIGIN);
      const challenge = await auth.challenge(account.address);
      const signed = await account.signMessage({ message: challenge.message });
      const session = await auth.verify(challenge.id, signed, challenge.browserToken);
      try {
        if ((await auth.session(session.token))?.wallet !== account.address.toLowerCase()) throw new Error("Hosted session mismatch");
        const sameDatabase = await database.database.query<{ wallet: string }>('SELECT wallet FROM sicara.sessions WHERE token_hash=$1', [hashToken(session.token)]);
        if (sameDatabase.rows[0]?.wallet !== account.address.toLowerCase()) throw new Error('Application and worker point to different databases');
      } finally { await auth.logout(session.token); }
    }
    const dataDir = resolve(process.env.SICARA_ZCASH_WALLET_DIR ?? '.local/zcash/wallet');
    wallet = await TestnetWallet.start({ binary: resolve(process.env.SICARA_ZCASH_BINARY ?? '.local/zcash/bin/zec-sidecar'), dataDir });
    const gateway = new SidecarWorkerWallet(wallet, resolve(process.env.SICARA_ADDRESS_VALIDATOR ?? '.local/zcash/native-target/release/sicara-address-check'));
    gateway.sendRefund = async () => { throw new Error('Readiness canary never sends funds'); };
    const worker = new CollateralWorker(database.database, gateway, new OperationJournal(join(dataDir, 'sicara-operations')));
    await worker.initialize();
    const previous = JSON.parse(await readFile(resolve('.local/evidence/zcash-roundtrip.json'), 'utf8'));
    if (previous.completed !== true) throw new Error('Expected existing testnet receiver evidence');
    const receiver = await gateway.validate(previous.returnAddress);
    const loans = new LoanRepository(database.database);
    const loan = await loans.prepare(evidence.wallet, evidence.requestKey, receiver, 10_000n);
    evidence.loanId = loan.id;
    if (!evidence.completed) {
      await worker.tick();
      const allocated = await loans.find(evidence.wallet, loan.id);
      if (!allocated.deposit_address || allocated.deposit_address === await gateway.address()) throw new Error('Expected a distinct allocated receiver');
      evidence.depositAddress = allocated.deposit_address;
      const observed = await database.database.query("SELECT note_id FROM sicara.deposit_observations WHERE loan_id=$1", [loan.id]);
      if (observed.rows.length) throw new Error('Unexpected funds; canary refuses all send operations');
      if (allocated.state !== 'refunded') await loans.cancel(evidence.wallet, loan.id);
      await worker.tick();
    }
    if ((await loans.find(evidence.wallet, loan.id)).state !== 'refunded') throw new Error('Canary did not close its unfunded request');
    const payments = await database.database.query("SELECT id FROM sicara.refund_payments WHERE loan_id=$1", [loan.id]);
    if (payments.rows.length) throw new Error('Unfunded canary must not prepare any payment');
    evidence.completed = true;
    evidence.checkedAt = new Date().toISOString();
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ hostedSession: true, workerExclusion: true, realAllocation: true, unfundedCancellation: true, sends: 0, completed: true }));
  } finally {
    await wallet?.close();
    await application.end();
    await database.close();
  }
}
void main().catch(() => { console.error('Worker readiness check stopped; preserve its evidence and reconcile the existing request. No credentials were logged.'); process.exitCode = 1; });

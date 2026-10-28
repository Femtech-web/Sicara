import { ShieldedReturnSender } from "./shielded-return-sender";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../database/types";
import { LoanRepository } from "../../src/features/lending/server/loan-repository";
import { OperationJournal } from "./operation-journal";
import { REFUND_CHUNK_ZATOSHIS, refundMemo, type WorkerWallet } from "./worker-wallet";
import type {DepositSnapshot} from './protocol';

type Row = Record<string, unknown>;
type Loan = Row & { id: string; state: string; return_address: string; deposit_address: string | null };
type Payment = Row & { id: string; loan_id: string; destination: string; zatoshis: string; state: string; txid: string | null };

/** One protected custody wallet, one session-level DB lock, sequential effects.
 * Does not issue credit. Post-issuance returns require the settlement verifier callback.
 */
export class CollateralWorker {
  private databaseId = "";
  private fingerprint = "";
  private loans: LoanRepository;
  constructor(private db: Database, private wallet: WorkerWallet, private journal: OperationJournal, private feeReserve = 1_000_000n,private beforeReturns?:(snapshot:DepositSnapshot)=>Promise<void>) {
    if (feeReserve < 100_000n) throw new Error("Operator fee reserve is too small");
    this.loans = new LoanRepository(db);
  }

  async initialize() {
    const address = await this.wallet.address();
    if (await this.wallet.validate(address) !== address) throw new Error("Custody wallet must use its canonical shielded testnet receiver");
    this.fingerprint = createHash("sha256").update(`sicara:test:${address}`).digest("hex");
    await this.db.query("INSERT INTO sicara.wallet_worker(singleton,instance_id,wallet_fingerprint) VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING", [randomUUID(), this.fingerprint]);
    const row = await this.db.query<{ instance_id: string; wallet_fingerprint: string }>("SELECT instance_id,wallet_fingerprint FROM sicara.wallet_worker WHERE singleton=true");
    if (row.rows[0].wallet_fingerprint !== this.fingerprint) throw new Error("Database belongs to a different custody wallet");
    this.databaseId = row.rows[0].instance_id;
    await this.journal.bind("manifest", { network: "test", wallet: this.fingerprint, database: this.databaseId });
    // A DB restored without its operation rows cannot safely spend from this wallet.
    for (const key of await this.journal.keys()) {
      const table = key.startsWith("refund-") ? "refund_payments" : key.startsWith("release-") ? "release_payments" : key.startsWith('issuance-') ? 'collateral_authorizations' : "address_allocations";
      const column = (key.startsWith("refund-") || key.startsWith("release-")) ? "id" : "loan_id";
      const id = key.slice(key.indexOf("-") + 1);
      const result = await this.db.query(`SELECT ${column} FROM sicara.${table} WHERE ${column}=$1`, [id]);
      if (!result.rows.length) throw new Error("Wallet journal has operations missing from the database; restore and reconcile before continuing");
    }
  }

  async tick() {
    if (!this.databaseId) throw new Error("Worker must initialize under exclusive wallet/database locks");
    const summary = { allocations: 0, observations: 0, payments: 0, blocked: 0 };
    await this.db.query("WITH expired AS (UPDATE sicara.loans SET state='refund_pending' WHERE state='allocating' AND expires_at <= clock_timestamp() RETURNING id,return_address) INSERT INTO sicara.refund_intents(loan_id,destination,reason) SELECT id,return_address,'expired' FROM expired ON CONFLICT(loan_id) DO NOTHING");
    const waiting = await this.db.query<Loan>("SELECT id,state,return_address,deposit_address FROM sicara.loans l WHERE state='allocating' OR (state='refund_pending' AND deposit_address IS NULL AND EXISTS (SELECT 1 FROM sicara.address_allocations a WHERE a.loan_id=l.id AND a.state='pending')) ORDER BY created_at LIMIT 50");
    for (const loan of waiting.rows) {
      if (await this.allocate(loan)) summary.allocations++;
      else summary.blocked++;
    }
    const snapshot = await this.wallet.scan();
    if (snapshot.stale) throw new Error("Worker refuses stale wallet snapshots");
    await this.recheckConfirmed(snapshot.tip);
    const tracked = await this.db.query<Loan>("SELECT id,state,return_address,deposit_address FROM sicara.loans WHERE deposit_address IS NOT NULL AND state <> 'released' ORDER BY created_at");
    for (const loan of tracked.rows) {
      await this.loans.observe(loan.id, snapshot);
      summary.observations++;
    }
    await this.db.query("UPDATE sicara.wallet_worker SET last_tip=$1,scanned_at=clock_timestamp() WHERE singleton=true", [snapshot.tip]);
    if(this.beforeReturns)await this.beforeReturns(snapshot);
    else if((await this.db.query('SELECT loan_id FROM sicara.release_intents LIMIT 1')).rows.length)throw new Error('Settlement verifier required while release history exists');
    const refunds = await this.db.query<Loan>("SELECT id,state,return_address,deposit_address FROM sicara.loans WHERE state IN ('refund_pending','late_refund_pending','refunded') ORDER BY created_at");
    for (const loan of refunds.rows) {
      const payment = await this.planRefund(loan, snapshot.tip);
      if (payment) {
        const result = await this.processPayment(payment, snapshot.tip);
        if (result) summary.payments++; else summary.blocked++;
      }
    }
    return summary;
  }

  private async allocate(loan: Loan) {
    const existing = await this.db.query<{ state: string }>("SELECT state FROM sicara.address_allocations WHERE loan_id=$1", [loan.id]);
    if (existing.rows[0]?.state === "review") return false;
    let receiver: string;
    try { receiver = await this.wallet.validate(loan.return_address); }
    catch {
      await this.db.query("INSERT INTO sicara.address_allocations(loan_id,state,return_receiver) VALUES($1,'review',$2) ON CONFLICT(loan_id) DO UPDATE SET state='review'", [loan.id, loan.return_address]);
      return false;
    }
    await this.db.query("INSERT INTO sicara.address_allocations(loan_id,state,return_receiver) VALUES($1,'pending',$2) ON CONFLICT(loan_id) DO NOTHING", [loan.id, receiver]);
    const key = `allocation-${loan.id}`;
    let operation = await this.journal.bind(key, { kind: "allocation", loan: loan.id, returnReceiver: receiver, wallet: this.fingerprint });
    if (operation.state === "allocating") {
      // newAddress may have persisted a diversifier before its response was lost.
      // That unknown address was never published. Do not reuse or allocate again blindly.
      await this.db.query("UPDATE sicara.address_allocations SET state='review' WHERE loan_id=$1", [loan.id]);
      return false;
    }
    if (operation.state === "prepared") {
      operation = { ...operation, state: "allocating" };
      await this.journal.save(key, operation);
      const address = await this.wallet.newAddress();
      if (await this.wallet.validate(address) !== address || address === receiver) throw new Error("Invalid or self-referencing allocated address");
      operation = { ...operation, state: "allocated", address };
      await this.journal.save(key, operation);
    }
    if (operation.state !== "allocated" || !operation.address) throw new Error("Unexpected address allocation journal state");
    await this.db.transaction(async sql => {
      const current = await sql.query<Loan>("SELECT id,state,return_address,deposit_address FROM sicara.loans WHERE id=$1 FOR UPDATE", [loan.id]);
      if (!current.rows[0] || current.rows[0].return_address !== loan.return_address) throw new Error("Loan binding changed during allocation");
      await sql.query("UPDATE sicara.address_allocations SET state='allocated',deposit_address=$2 WHERE loan_id=$1", [loan.id, operation.address]);
      await sql.query("UPDATE sicara.loans SET deposit_address=$2,state=CASE WHEN state='allocating' THEN 'awaiting_deposit' ELSE state END WHERE id=$1", [loan.id, operation.address]);
    });
    return true;
  }

  private async planRefund(loan: Loan, tip: number): Promise<Payment | null> {
    const receiver = await this.wallet.validate(loan.return_address);
    return this.db.transaction(async sql => {
      const locked = await sql.query<Loan>("SELECT id,state,return_address,deposit_address FROM sicara.loans WHERE id=$1 FOR UPDATE", [loan.id]);
      const current = locked.rows[0];
      if (!current || !['refund_pending','late_refund_pending','refunded'].includes(current.state)) return null;
      if (!current.deposit_address) {
        const allocated = await sql.query("SELECT loan_id FROM sicara.address_allocations WHERE loan_id=$1", [loan.id]);
        if (!allocated.rows.length && !await this.journal.get(`allocation-${loan.id}`)) {
          await sql.query("UPDATE sicara.refund_intents SET state='confirmed' WHERE loan_id=$1", [loan.id]);
          await sql.query("UPDATE sicara.loans SET state='refunded' WHERE id=$1", [loan.id]);
        }
        return null;
      }
      const allocation = await sql.query<{ return_receiver: string }>("SELECT return_receiver FROM sicara.address_allocations WHERE loan_id=$1 AND state='allocated'", [loan.id]);
      if (allocation.rows[0]?.return_receiver !== receiver) throw new Error("Refund destination does not match validated allocation binding");
      const pending = await sql.query<Payment>("SELECT * FROM sicara.refund_payments WHERE loan_id=$1 AND state <> 'confirmed' ORDER BY sequence LIMIT 1", [loan.id]);
      if (pending.rows[0]) {
        if (pending.rows[0].destination !== receiver) throw new Error("Pending refund destination differs from the bound receiver");
        return pending.rows[0];
      }
      const observed = await sql.query<{ amount: string; incomplete: string }>("SELECT coalesce(sum(zatoshis),0)::text AS amount,count(*) FILTER (WHERE NOT present OR height IS NULL OR height > $2-9)::text AS incomplete FROM sicara.deposit_observations WHERE loan_id=$1", [loan.id, tip]);
      if (observed.rows[0].incomplete !== "0") return null;
      const history = await sql.query<{ paid: string; sequence: number }>("SELECT coalesce(sum(zatoshis),0)::text AS paid,coalesce(max(sequence),0)::integer AS sequence FROM sicara.refund_payments WHERE loan_id=$1", [loan.id]);
      const remaining = BigInt(observed.rows[0].amount) - BigInt(history.rows[0].paid);
      if (remaining < 0n) throw new Error("Refund history exceeds observed deposits; reconciliation required");
      if (remaining === 0n) {
        await sql.query("UPDATE sicara.refund_intents SET state='confirmed' WHERE loan_id=$1", [loan.id]);
        await sql.query("UPDATE sicara.loans SET state='refunded' WHERE id=$1", [loan.id]);
        return null;
      }
      await sql.query("INSERT INTO sicara.refund_intents(loan_id,destination,reason) VALUES($1,$2,'expired') ON CONFLICT(loan_id) DO UPDATE SET state='reconciliation_required'", [loan.id, loan.return_address]);
      const amount = remaining < REFUND_CHUNK_ZATOSHIS ? remaining : REFUND_CHUNK_ZATOSHIS;
      const payment = await sql.query<Payment>("INSERT INTO sicara.refund_payments(id,loan_id,sequence,destination,zatoshis) VALUES($1,$2,$3,$4,$5) RETURNING *", [randomUUID(), loan.id, history.rows[0].sequence + 1, receiver, amount.toString()]);
      await sql.query("UPDATE sicara.loans SET state=CASE WHEN state IN ('refunded','late_refund_pending') THEN 'late_refund_pending' ELSE 'refund_pending' END WHERE id=$1", [loan.id]);
      return payment.rows[0];
    });
  }

  private async processPayment(payment: Payment, scanTip: number) {
    return new ShieldedReturnSender(this.db,this.wallet,this.journal,this.fingerprint,this.feeReserve,'refund').process(payment,scanTip);
  }

  private async review(id: string) {
    await this.db.query("UPDATE sicara.refund_payments SET state='review' WHERE id=$1", [id]);
    return false;
  }

  private async recheckConfirmed(scanTip: number) {
    const confirmed = await this.db.query<Payment>("SELECT * FROM sicara.refund_payments WHERE state='confirmed'");
    if (!confirmed.rows.length) return;
    const ledger = await this.wallet.sent();
    for (const payment of confirmed.rows) {
      const matches = ledger.payments.filter(entry => entry.memo === refundMemo(payment.id));
      const entry = matches[0];
      if (matches.length !== 1 || entry.txid !== payment.txid || entry.amount !== BigInt(payment.zatoshis) || entry.destination !== payment.destination || Math.min(scanTip, ledger.tip) - entry.height + 1 < 10) {
        await this.review(payment.id);
        // Keep the old wallet's historical request separate from a newer active one.
        await this.db.query("UPDATE sicara.loans SET state=CASE WHEN state IN ('refunded','late_refund_pending') THEN 'late_refund_pending' ELSE 'reorg_review' END WHERE id=$1", [payment.loan_id]);
      }
    }
  }
}

import type {Database} from '../database/types';
import type {WorkerWallet} from './worker-wallet';
import {returnMemo} from './worker-wallet';
import {OperationJournal} from './operation-journal';
export type ReturnPayment=Record<string,unknown>&{id:string;loan_id:string;destination:string;zatoshis:string;state:string;txid:string|null};
/** Shared exact-once shielded send/reconciliation for pre-issuance refunds and settled releases. */
export class ShieldedReturnSender {
  private table:'refund_payments'|'release_payments';
  constructor(private db:Database,private wallet:WorkerWallet,private journal:OperationJournal,private fingerprint:string,private feeReserve:bigint,private kind:'refund'|'release') {this.table=kind==='refund'?'refund_payments':'release_payments';}
  async process(payment: ReturnPayment, scanTip: number) {
    if (payment.state === "review") return false;
    if (await this.wallet.validate(payment.destination) !== payment.destination) throw new Error("Refund payment receiver is not canonical");
    const key = `${this.kind}-${payment.id}`;
    let operation = await this.journal.bind(key, { kind: this.kind, loan: payment.loan_id, destination: payment.destination, zatoshis: payment.zatoshis, wallet: this.fingerprint });
    const ledger = await this.wallet.sent();
    const matches = ledger.payments.filter(entry => entry.memo === returnMemo(payment.id,this.kind));
    if (matches.length > 1) return this.review(payment.id);
    if (matches.length === 1) {
      const entry = matches[0];
      if (entry.destination !== payment.destination || entry.amount !== BigInt(payment.zatoshis) || (payment.txid && payment.txid !== entry.txid) || (operation.txid && operation.txid !== entry.txid) || !await this.wallet.inspectShielded(entry.txid)) return this.review(payment.id);
      operation = { ...operation, state: "broadcast", txid: entry.txid };
      await this.journal.save(key, operation);
      const confirmed = Math.min(scanTip, ledger.tip) - entry.height + 1 >= 10;
      await this.db.query(`UPDATE sicara.${this.table} SET state=$2,txid=$3,confirmed_height=$4 WHERE id=$1`, [payment.id, confirmed ? 'confirmed' : 'broadcast', entry.txid, confirmed ? entry.height : null]);
      if(this.kind==='refund')await this.db.query("UPDATE sicara.refund_intents SET state='broadcast' WHERE loan_id=$1", [payment.loan_id]);
      return true;
    }
    if (operation.state === "broadcast" && operation.txid) {
      await this.db.query(`UPDATE sicara.${this.table} SET state='broadcast',txid=$2 WHERE id=$1`, [payment.id, operation.txid]);
      if(this.kind==='refund')await this.db.query("UPDATE sicara.refund_intents SET state='broadcast' WHERE loan_id=$1", [payment.loan_id]);
      return false;
    }
    if (operation.state !== "prepared" || payment.state !== "prepared") return false;
    // A single unknown/in-flight payment pauses all new sends from the shared wallet.
    const busy = await this.db.query("SELECT id FROM sicara.refund_payments WHERE state IN ('submitting','broadcast','review') UNION ALL SELECT id FROM sicara.release_payments WHERE state IN ('submitting','broadcast','review') UNION ALL SELECT loan_id AS id FROM sicara.release_intents WHERE state='review' LIMIT 1");
    if (busy.rows.length) return false;
    const liabilities = await this.db.query<{ received: string; paid: string }>("SELECT (SELECT coalesce(sum(zatoshis),0)::text FROM sicara.deposit_observations WHERE present AND height IS NOT NULL AND height <= $1-9) AS received,((SELECT coalesce(sum(zatoshis),0) FROM sicara.refund_payments WHERE state='confirmed')+(SELECT coalesce(sum(zatoshis),0) FROM sicara.release_payments WHERE state='confirmed'))::text AS paid", [scanTip]);
    const outstanding = BigInt(liabilities.rows[0].received) - BigInt(liabilities.rows[0].paid);
    if (outstanding < 0n || await this.wallet.spendable() < outstanding + this.feeReserve) return false;
    operation = { ...operation, state: "submitting" };
    await this.journal.save(key, operation);
    const armed = await this.db.query(`UPDATE sicara.${this.table} SET state='submitting' WHERE id=$1 AND state='prepared' RETURNING id`, [payment.id]);
    if (!armed.rows.length) return false;
    let txid: string;
    try { txid = await (this.kind==='refund'?this.wallet.sendRefund(payment.destination, BigInt(payment.zatoshis), payment.id):this.wallet.sendRelease(payment.destination, BigInt(payment.zatoshis), payment.id)); }
    catch { return false; } // Every send error is uncertain. The ledger must recover it.
    if (!/^[a-f0-9]{64}$/.test(txid)) return false;
    operation = { ...operation, state: "broadcast", txid };
    await this.journal.save(key, operation);
    await this.db.query(`UPDATE sicara.${this.table} SET state='broadcast',txid=$2 WHERE id=$1`, [payment.id, txid]);
    if(this.kind==='refund')await this.db.query("UPDATE sicara.refund_intents SET state='broadcast' WHERE loan_id=$1", [payment.loan_id]);
    return true;
  }

  private async review(id:string) {
    await this.db.query(`UPDATE sicara.${this.table} SET state='review' WHERE id=$1`,[id]);
    if(this.kind==='release')await this.db.transaction(async sql=>{
      const payment=await sql.query<{loan_id:string}>('SELECT loan_id FROM sicara.release_payments WHERE id=$1',[id]);
      await sql.query("UPDATE sicara.release_intents SET state='review' WHERE loan_id=$1",[payment.rows[0].loan_id]);
      await sql.query("UPDATE sicara.loans SET state='release_review' WHERE id=$1",[payment.rows[0].loan_id]);
    });
    return false;
  }
}

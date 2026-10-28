import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../../../../services/database/types";
import { assessDeposit, testnetAddress, zatoshis, type DepositSnapshot } from "../../../../services/zcash/protocol";
import { walletAddress } from "../../wallet/server/auth";

export class LoanError extends Error {}
type Loan = Record<string, unknown> & {
  id: string; wallet: string; state: string; return_address: string;
  deposit_address: string | null; required_zatoshis: string; expires_at: Date;
};

/** Private repository: never expose writes directly to a browser or a Supabase client. */
export class LoanRepository {
  constructor(private db: Database) {}

  async list(wallet: string) {
    const result = await this.db.query("SELECT id,state,required_zatoshis::text,created_at,expires_at FROM sicara.loans WHERE wallet=$1 ORDER BY created_at DESC LIMIT 50", [walletAddress(wallet)]);
    // No custody address or operator observation data in the public read model.
    return result.rows;
  }

  async find(wallet: string, id: string) {
    const result = await this.db.query<Loan>("SELECT * FROM sicara.loans WHERE id=$1 AND wallet=$2", [id, walletAddress(wallet)]);
    if (!result.rows[0]) throw new LoanError("Loan not found.");
    return result.rows[0];
  }

  // Internal preparation only. No HTTP creation endpoint until native destination validation,
  // idempotent wallet allocation and real refund execution are integrated.
  async prepare(wallet: string, requestKey: string, returnAddress: string, required: bigint) {
    wallet = walletAddress(wallet);
    testnetAddress(returnAddress); // Preliminary only: this state cannot accept funds.
    if (required <= 0n) throw new LoanError("Collateral must be positive.");
    zatoshis(required.toString());
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestKey)) throw new LoanError("Invalid request key.");
    return this.db.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [wallet]);
      const existing = await sql.query<Loan>("SELECT * FROM sicara.loans WHERE wallet=$1 AND request_key=$2", [wallet, requestKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].return_address !== returnAddress || BigInt(existing.rows[0].required_zatoshis) !== required) throw new LoanError("Request key already used for different terms.");
        return existing.rows[0];
      }
      const active = await sql.query("SELECT id FROM sicara.loans WHERE wallet=$1 AND state NOT IN ('refunded','released','late_refund_pending')", [wallet]);
      if (active.rows.length) throw new LoanError("A loan request is already open for this wallet.");
      const result = await sql.query<Loan>("INSERT INTO sicara.loans(id,wallet,request_key,return_address,required_zatoshis,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour') RETURNING *", [randomUUID(), wallet, requestKey, returnAddress, required.toString()]);
      return result.rows[0];
    });
  }

  async cancel(wallet: string, id: string) {
    return this.db.transaction(async sql => {
      const loan = await this.lock(sql, id, walletAddress(wallet));
      // Keep original terms/address immutable and keep the wallet slot reserved.
      if (!['allocating', 'awaiting_deposit', 'confirming', 'collateral_verified', 'reorg_review', 'refund_pending', 'late_refund_pending'].includes(loan.state)) throw new LoanError("Loan cannot be cancelled in this state.");
      await this.refund(sql, loan, "cancelled");
    });
  }

  /** Worker-only full wallet scan, sinceHeight=0. Never accepts browser observations.
   * Missing/reorganized notes keep their reservation and require operator reconciliation.
   * This records a candidate; it is not a signed authorization to issue.
   */
  async observe(id: string, snapshot: DepositSnapshot) {
    if (snapshot.stale) throw new LoanError("Fresh full wallet scan required.");
    return this.db.transaction(async sql => {
      const loan = await this.lock(sql, id);
      if (!loan.deposit_address || loan.state === 'allocating') throw new LoanError("Address allocation incomplete.");
      if (loan.state === 'released') throw new LoanError("Released loans need a separate recovery policy.");
      const assessment = assessDeposit(snapshot, loan.deposit_address, BigInt(loan.required_zatoshis), 10);
      await sql.query("UPDATE sicara.deposit_observations SET present=false WHERE loan_id=$1", [id]);
      for (const note of snapshot.notes.filter(note => note.address === loan.deposit_address)) {
        if (note.zatoshis <= 0n) continue;
        const noteId = `${note.txid}:${note.valuePool}:${note.index}`;
        const result = await sql.query("INSERT INTO sicara.deposit_observations(note_id,loan_id,zatoshis,height,scan_tip,present) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(note_id) DO UPDATE SET height=excluded.height,scan_tip=excluded.scan_tip,present=true WHERE sicara.deposit_observations.loan_id=excluded.loan_id AND sicara.deposit_observations.zatoshis=excluded.zatoshis RETURNING note_id", [noteId, id, note.zatoshis.toString(), note.source === 'wallet' ? note.height : null, snapshot.tip]);
        if (!result.rows.length) throw new LoanError("Deposit identity conflicts with existing ownership or amount.");
      }
      const broken = await sql.query("SELECT r.note_id FROM sicara.collateral_reservations r JOIN sicara.deposit_observations n ON n.note_id=r.note_id WHERE r.loan_id=$1 AND (NOT n.present OR n.height IS NULL OR n.height > $2-9)", [id, snapshot.tip]);
      const authorization = await sql.query("SELECT loan_id FROM sicara.collateral_authorizations WHERE loan_id=$1", [id]);
      if (authorization.rows.length) {
        // An outstanding/consumed authorization stays frozen even after request expiry,
        // late overpayment or a collateral reorg. It can never re-enter cancellation.
        const state = broken.rows.length ? (loan.state.startsWith('release')?'release_review':'issuance_review') : loan.state;
        if (state === 'issuance_review'||state==='release_review') {
          await sql.query("UPDATE sicara.loans SET state=$2 WHERE id=$1", [id, state]);
        }
        return state;
      }
      if (broken.rows.length) {
        const state = ['refunded', 'late_refund_pending'].includes(loan.state) ? 'late_refund_pending' : 'reorg_review';
        await sql.query("UPDATE sicara.loans SET state=$2 WHERE id=$1", [id, state]);
        return state;
      }
      // Refund/reorg states cannot silently return to eligibility after another scan.
      if (['refund_pending', 'reorg_review', 'refunded', 'late_refund_pending'].includes(loan.state)) return loan.state;
      const clock = await sql.query<{ expired: boolean }>("SELECT expires_at <= clock_timestamp() AS expired FROM sicara.loans WHERE id=$1", [id]);
      if (clock.rows[0].expired || assessment.confirmed + assessment.pending > BigInt(loan.required_zatoshis)) {
        await this.refund(sql, loan, clock.rows[0].expired ? 'expired' : 'overpayment');
        return 'refund_pending';
      }
      let state = assessment.status === 'confirmed' ? 'collateral_verified' : assessment.status === 'confirming' ? 'confirming' : 'awaiting_deposit';
      if (state === 'collateral_verified') {
        for (const noteId of [...assessment.noteIds].sort()) {
          await sql.query("INSERT INTO sicara.collateral_reservations(note_id,loan_id) VALUES($1,$2) ON CONFLICT(note_id) DO NOTHING", [noteId, id]);
        }
      }
      // A verified request with less than the required collateral fails closed.
      if (loan.state === 'collateral_verified' && state !== 'collateral_verified') state = 'reorg_review';
      await sql.query("UPDATE sicara.loans SET state=$2 WHERE id=$1", [id, state]);
      return state;
    });
  }

  private async lock(sql: Sql, id: string, wallet?: string) {
    const result = await sql.query<Loan>("SELECT * FROM sicara.loans WHERE id=$1 AND ($2::text IS NULL OR wallet=$2) FOR UPDATE", [id, wallet ?? null]);
    if (!result.rows[0]) throw new LoanError("Loan not found.");
    return result.rows[0];
  }
  private async refund(sql: Sql, loan: Loan, reason: 'cancelled' | 'expired' | 'overpayment') {
    await sql.query("INSERT INTO sicara.refund_intents(loan_id,destination,reason) VALUES($1,$2,$3) ON CONFLICT(loan_id) DO NOTHING", [loan.id, loan.return_address, reason]);
    await sql.query("UPDATE sicara.loans SET state=CASE WHEN state='late_refund_pending' THEN state ELSE 'refund_pending' END WHERE id=$1", [loan.id]);
  }
}

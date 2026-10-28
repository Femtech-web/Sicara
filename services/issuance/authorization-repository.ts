import { randomBytes } from "node:crypto";
import { keccak256, recoverTypedDataAddress, type Hex } from "viem";
import type { Database } from "../database/types";

export const DEMO_POLICY = keccak256(Buffer.from("sicara:test-only:demo-prices:50-percent:zero-interest:v1"));
export const authorizationTypes = { CollateralAuthorization: [
  { name: "loanId", type: "bytes32" }, { name: "borrower", type: "address" },
  { name: "depositCommitment", type: "bytes32" }, { name: "capacityInput", type: "bytes32" },
  { name: "inputProofHash", type: "bytes32" }, { name: "policyHash", type: "bytes32" },
  { name: "validUntil", type: "uint64" },
] } as const;
export type AuthorizationRow = Record<string, unknown> & {
  loan_id: string; wallet: string; chain_id: string; pool: string; policy_hash: Hex;
  chain_loan_id: Hex; deposit_commitment: Hex; valid_until: string; capacity_units: string;
  state: string; capacity_input: Hex | null; input_proof: Hex | null; signature: Hex | null;
};
const opaqueId = () => `0x${randomBytes(32).toString("hex")}`;
const address = /^0x[0-9a-f]{40}$/;
const bytes32 = /^0x[0-9a-f]{64}$/;

/** Internal trusted worker only. Never accepts deposits or proof data from HTTP clients. */
export class AuthorizationRepository {
  constructor(private db: Database) {}
  async get(id: string) {
    const result = await this.db.query<AuthorizationRow>("SELECT a.*,l.wallet FROM sicara.collateral_authorizations a JOIN sicara.loans l ON l.id=a.loan_id WHERE a.loan_id=$1", [id]);
    if (!result.rows[0]) throw new Error("Collateral authorization not found");
    return result.rows[0];
  }
  async reserve(id: string, pool: string, validitySeconds = 120) {
    pool = pool.toLowerCase();
    if (!address.test(pool) || !Number.isInteger(validitySeconds) || validitySeconds < 60 || validitySeconds > 600) throw new Error("Invalid testnet issuance configuration");
    return this.db.transaction(async sql => {
      const locked = await sql.query<{ state: string; required_zatoshis: string; eligible: boolean }>("SELECT state,required_zatoshis::text,expires_at>clock_timestamp() AS eligible FROM sicara.loans WHERE id=$1 FOR UPDATE", [id]);
      const prior = await sql.query("SELECT pool FROM sicara.collateral_authorizations WHERE loan_id=$1", [id]);
      if (prior.rows.length) {
        if (prior.rows[0].pool !== pool) throw new Error("Existing authorization uses another deployment");
        return;
      }
      const loan = locked.rows[0];
      if (!loan || loan.state !== 'collateral_verified' || !loan.eligible) throw new Error("Confirmed unexpired collateral required");
      const scan = await sql.query<{ last_tip: string; fresh: boolean }>("SELECT last_tip,scanned_at>clock_timestamp()-interval '30 seconds' AS fresh FROM sicara.wallet_worker WHERE singleton=true");
      if (!scan.rows[0]?.fresh) throw new Error("Fresh custody worker scan required");
      const notes = await sql.query<{ total: string; broken: string }>("SELECT COALESCE(sum(n.zatoshis),0)::text AS total,count(*) FILTER(WHERE NOT n.present OR n.height IS NULL OR n.height>$2::bigint-9)::text AS broken FROM sicara.collateral_reservations r JOIN sicara.deposit_observations n ON n.note_id=r.note_id WHERE r.loan_id=$1", [id, scan.rows[0].last_tip]);
      const refunds = await sql.query("SELECT loan_id FROM sicara.refund_intents WHERE loan_id=$1", [id]);
      if (refunds.rows.length || notes.rows[0].broken !== '0' || notes.rows[0].total !== loan.required_zatoshis) throw new Error("Collateral cannot be authorized");
      // Explicit fixed DEMO price: ZEC $100, Demo ZAMA $1, 50% LTV, both 8 decimals.
      const capacity = BigInt(loan.required_zatoshis) * 50n;
      if (capacity > (1n << 64n) - 1n) throw new Error("Capacity exceeds encrypted integer range");
      await sql.query("UPDATE sicara.loans SET state='issuance_pending' WHERE id=$1", [id]);
      await sql.query("INSERT INTO sicara.collateral_authorizations(loan_id,chain_id,pool,policy_hash,chain_loan_id,deposit_commitment,valid_until,capacity_units,scan_tip) VALUES($1,11155111,$2,$3,$4,$5,floor(extract(epoch FROM clock_timestamp()))::bigint+$6,$7,$8)", [id,pool,DEMO_POLICY,opaqueId(),opaqueId(),validitySeconds,capacity.toString(),scan.rows[0].last_tip]);
    }).then(() => this.get(id));
  }
  async prepare(id: string, capacityInput: Hex, proof: Hex) {
    if (!bytes32.test(capacityInput) || /^0x0+$/.test(capacityInput) || !/^0x[0-9a-f]+$/i.test(proof) || proof.length > 262144) throw new Error("Invalid encrypted capacity proof");
    return this.db.transaction(async sql => {
      await sql.query("SELECT id FROM sicara.loans WHERE id=$1 AND state='issuance_pending' FOR UPDATE", [id]);
      const result = await sql.query("UPDATE sicara.collateral_authorizations a SET capacity_input=$2,input_proof=$3,state='prepared' WHERE loan_id=$1 AND state='reserved' AND valid_until>extract(epoch FROM clock_timestamp()) AND EXISTS(SELECT 1 FROM sicara.loans WHERE id=$1 AND state='issuance_pending') RETURNING loan_id", [id,capacityInput,proof]);
      if (!result.rows.length) throw new Error("Authorization is expired, frozen or already prepared");
    });
  }
  typedData(row: AuthorizationRow) {
    if (!row.capacity_input || !row.input_proof) throw new Error("Encrypted input not persisted");
    return {
      domain: { name: 'SicaraCollateral', version: '1', chainId: 11155111, verifyingContract: row.pool as Hex },
      primaryType: 'CollateralAuthorization' as const, types: authorizationTypes,
      message: { loanId: row.chain_loan_id, borrower: row.wallet as Hex, depositCommitment: row.deposit_commitment, capacityInput: row.capacity_input, inputProofHash: keccak256(row.input_proof), policyHash: row.policy_hash, validUntil: BigInt(row.valid_until) },
    };
  }
  async saveSignature(id: string, signature: Hex, attestor: string) {
    const row = await this.get(id);
    if ((await recoverTypedDataAddress({ ...this.typedData(row), signature })).toLowerCase() !== attestor.toLowerCase()) throw new Error("Invalid attestor signature");
    const updated = await this.db.query("UPDATE sicara.collateral_authorizations a SET signature=$2,state='signed' WHERE loan_id=$1 AND state='prepared' AND valid_until>extract(epoch FROM clock_timestamp()) AND EXISTS(SELECT 1 FROM sicara.loans WHERE id=$1 AND state='issuance_pending') RETURNING loan_id", [id,signature]);
    if (!updated.rows.length) throw new Error("Authorization no longer signable");
  }
  async review(id: string) {
    await this.db.transaction(async sql => {
      await sql.query("SELECT id FROM sicara.loans WHERE id=$1 FOR UPDATE", [id]);
      await sql.query("UPDATE sicara.collateral_authorizations SET state='review' WHERE loan_id=$1", [id]);
      await sql.query("UPDATE sicara.loans SET state='issuance_review' WHERE id=$1", [id]);
    });
  }
}

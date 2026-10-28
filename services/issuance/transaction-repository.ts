import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import type { Database } from '../database/types';

export type TransactionRow = Record<string,unknown> & {loan_id:string;stage:string;attempt:number;tx_hash:Hex;raw_transaction:Hex;state:string;block_number:string|null;block_hash:Hex|null};
export type IssuanceStage='register'|'borrow'|'approve'|'repay'|'request_settlement'|'settle'|'revoke';
/** Persist a signed transaction BEFORE broadcasting. Retry only identical bytes/hash. */
export class IssuanceTransactions {
  constructor(private db:Database) {}
  async get(id:string,stage:IssuanceStage):Promise<TransactionRow|undefined> {
    return (await this.db.query<TransactionRow>('SELECT * FROM sicara.sepolia_transactions WHERE loan_id=$1 AND stage=$2 ORDER BY attempt DESC LIMIT 1',[id,stage])).rows[0];
  }
  async prepare(id:string,stage:IssuanceStage,raw:Hex,expectedData:Hex,approvalToken?:Hex) {
    if (!raw.startsWith('0x02')) throw new Error('Only signed EIP-1559 test transactions are supported');
    const parsed=parseTransaction(raw);
    const from=(await recoverTransactionAddress({serializedTransaction:raw as `0x02${string}`})).toLowerCase();
    await this.db.transaction(async sql=>{
      const result=await sql.query<{wallet:string;pool:string;state:string;authorization_state:string;signature:string|null}>("SELECT l.wallet,a.pool,l.state,a.state AS authorization_state,a.signature FROM sicara.loans l JOIN sicara.collateral_authorizations a ON a.loan_id=l.id WHERE l.id=$1 FOR UPDATE OF l",[id]);
      const loan=result.rows[0];
      const target=(stage==='approve'||stage==='revoke')?approvalToken?.toLowerCase():loan?.pool;
      if (!loan || !target || !loan.signature || !['signed','registered'].includes(loan.authorization_state) || stage!=='register'&&loan.authorization_state!=='registered' || !['issuance_pending','issuance_registered'].includes(loan.state) || from!==loan.wallet || parsed.chainId!==11155111 || parsed.to?.toLowerCase()!==target || (parsed.value??0n)!==0n || parsed.data!==expectedData) throw new Error('Signed transaction binding mismatch or issuance frozen');
      const known=await sql.query<TransactionRow>('SELECT * FROM sicara.sepolia_transactions WHERE loan_id=$1 AND stage=$2 ORDER BY attempt DESC LIMIT 1',[id,stage]);
      if (known.rows.length && known.rows[0].state!=='failed') {
        if (known.rows[0].raw_transaction!==raw) throw new Error('Transaction already prepared; reconcile existing hash');
        return;
      }
      if(known.rows.length && (stage!=='borrow'||known.rows[0].attempt>=3))throw new Error('No further automatic attempts supported');
      await sql.query('INSERT INTO sicara.sepolia_transactions(loan_id,stage,tx_hash,raw_transaction,attempt) VALUES($1,$2,$3,$4,$5)',[id,stage,keccak256(raw),raw,(known.rows[0]?.attempt??0)+1]);
    });
    return (await this.get(id,stage))!;
  }
  async confirm(id:string,stage:IssuanceStage,hash:Hex,block:number,blockHash:Hex) {
    const updated=await this.db.query("UPDATE sicara.sepolia_transactions SET state='confirmed',block_number=$4,block_hash=$5 WHERE loan_id=$1 AND stage=$2 AND tx_hash=$3 AND state IN ('prepared','confirmed') AND (block_hash IS NULL OR block_hash=$5) RETURNING loan_id",[id,stage,hash,block,blockHash]);
    if (!updated.rows.length) throw new Error('Receipt changed; review required');
  }
  /** Caller must verify status=0, canonical block and finality before this write. */
  async failedBorrow(id:string,hash:Hex,block:number,blockHash:Hex) {
    const updated=await this.db.query("UPDATE sicara.sepolia_transactions SET state='failed',block_number=$3,block_hash=$4 WHERE loan_id=$1 AND stage='borrow' AND tx_hash=$2 AND state IN ('prepared','review','failed') AND (block_hash IS NULL OR block_hash=$4) RETURNING loan_id",[id,hash,block,blockHash]);
    if(!updated.rows.length)throw new Error('Failed receipt binding changed');
  }
}

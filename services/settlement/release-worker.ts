import {createHash,randomUUID} from 'node:crypto';
import type {Hex} from 'viem';
import type {Database} from '../database/types';
import type {WorkerWallet} from '../zcash/worker-wallet';
import {returnMemo,REFUND_CHUNK_ZATOSHIS} from '../zcash/worker-wallet';
import {OperationJournal} from '../zcash/operation-journal';
import {ShieldedReturnSender,type ReturnPayment} from '../zcash/shielded-return-sender';
import {LoanRepository} from '../../src/features/lending/server/loan-repository';
import {SettlementMismatch,type SettlementBinding,type SettlementVerifier} from './sepolia-settlement';
import type {DepositSnapshot} from '../zcash/protocol';

type Intent=Record<string,unknown>&SettlementBinding&{loan_id:string;destination:string;zatoshis:string;state:string;settlement_block_hash:Hex|null;settlement_block:string|null};
/** Record a candidate settlement without opening the custody wallet or authorizing a send. */
export async function trackRelease(db:Database,id:string,settlementTx:Hex){
  if(!/^0x[0-9a-f]{64}$/.test(settlementTx))throw new Error('Invalid settlement transaction');
  await db.transaction(async sql=>{
    const loan=await sql.query<{return_address:string;required_zatoshis:string;state:string}>("SELECT return_address,required_zatoshis::text,state FROM sicara.loans WHERE id=$1 FOR UPDATE",[id]);
    if(!loan.rows[0]||!['issuance_registered','release_pending','released'].includes(loan.rows[0].state))throw new Error('Registered loan required for release tracking');
    await sql.query("INSERT INTO sicara.release_intents(loan_id,destination,zatoshis,settlement_tx) VALUES($1,$2,$3,$4) ON CONFLICT(loan_id) DO UPDATE SET settlement_tx=excluded.settlement_tx",[id,loan.rows[0].return_address,loan.rows[0].required_zatoshis,settlementTx]);
  });
}
/** Caller holds the SAME DB session lock and custody wallet lock as CollateralWorker. */
export class ReleaseWorker {
  constructor(private db:Database,private wallet:WorkerWallet,private journal:OperationJournal,private verifier:SettlementVerifier,private reserve=1_000_000n) {
    if(reserve<100_000n)throw new Error('Operator fee reserve too small');
  }
  async track(id:string,settlementTx:Hex){
    await trackRelease(this.db,id,settlementTx);
  }
  async tick(currentSnapshot?:DepositSnapshot){
    const snapshot=currentSnapshot??await this.wallet.scan();if(snapshot.stale)throw new Error('Fresh full custody scan required');
    const address=await this.wallet.address();
    const fingerprint=createHash('sha256').update(`sicara:test:${address}`).digest('hex');
    const sender=new ShieldedReturnSender(this.db,this.wallet,this.journal,fingerprint,this.reserve,'release');
    const ready:ReturnPayment[]=[];
    const rows=await this.db.query<Intent>("SELECT r.*,a.pool,a.chain_loan_id,a.deposit_commitment,a.policy_hash,a.registration_tx,a.registration_block_hash,l.wallet FROM sicara.release_intents r JOIN sicara.collateral_authorizations a ON a.loan_id=r.loan_id JOIN sicara.loans l ON l.id=r.loan_id ORDER BY r.created_at");
    for(const intent of rows.rows){
      if(intent.state==='review')continue;
      if(!intent.registration_tx||!intent.registration_block_hash){await this.review(intent.loan_id);continue;}
      let proof;
      try{proof=await this.verifier.verify(intent);}catch(error){if(error instanceof SettlementMismatch){await this.review(intent.loan_id);continue;}throw error;}
      if(!proof){if(intent.settlement_block_hash)await this.review(intent.loan_id);continue;}
      if(intent.settlement_block_hash&&(intent.settlement_block_hash!==proof.blockHash||Number(intent.settlement_block)!==proof.block)){await this.review(intent.loan_id);continue;}
      const loan=await new LoanRepository(this.db).find(intent.wallet,intent.loan_id);
      if(!['issuance_registered','release_pending','released'].includes(loan.state)){await this.review(intent.loan_id);continue;}
      const notes=snapshot.notes.filter(note=>note.address===loan.deposit_address);
      if(notes.some(note=>note.height===null||note.source!=='wallet'||snapshot.tip-note.height+1<10)||notes.reduce((sum,note)=>sum+note.zatoshis,0n)!==BigInt(intent.zatoshis)){await this.review(intent.loan_id);continue;}
      if(await this.wallet.validate(intent.destination)!==intent.destination){await this.review(intent.loan_id);continue;}
      const allocation=await this.db.query<{return_receiver:string}>('SELECT return_receiver FROM sicara.address_allocations WHERE loan_id=$1 AND state=\'allocated\'',[intent.loan_id]);
      if(allocation.rows[0]?.return_receiver!==intent.destination){await this.review(intent.loan_id);continue;}
      const ledger=await this.wallet.sent();
      const confirmed=await this.db.query<ReturnPayment>("SELECT * FROM sicara.release_payments WHERE loan_id=$1 AND state='confirmed'",[intent.loan_id]);
      let broken=false;
      for(const payment of confirmed.rows){const matches=ledger.payments.filter(entry=>entry.memo===returnMemo(payment.id,'release'));const entry=matches[0];if(matches.length!==1||entry.txid!==payment.txid||entry.amount!==BigInt(payment.zatoshis)||entry.destination!==payment.destination||Math.min(snapshot.tip,ledger.tip)-entry.height+1<10){broken=true;break;}}
      if(broken){await this.review(intent.loan_id);continue;}
      await this.db.transaction(async sql=>{
        await sql.query('SELECT id FROM sicara.loans WHERE id=$1 FOR UPDATE',[intent.loan_id]);
        await sql.query("UPDATE sicara.release_intents SET state=CASE WHEN state='confirmed' THEN state ELSE 'authorized' END,settlement_block=$2,settlement_block_hash=$3 WHERE loan_id=$1",[intent.loan_id,proof.block,proof.blockHash]);
        await sql.query("UPDATE sicara.loans SET state=CASE WHEN state='released' THEN state ELSE 'release_pending' END WHERE id=$1 AND state IN ('issuance_registered','release_pending','released')",[intent.loan_id]);
      });
      const payment=await this.plan(intent);
      if(payment)ready.push(payment);
    }
    // Complete verification for every tracked loan before any wallet send. A later
    // reorg/review or unavailable RPC must not be discovered after an earlier send.
    for(const payment of ready)await sender.process(payment,snapshot.tip);
  }
  private async plan(intent:Intent):Promise<ReturnPayment|null>{
    return this.db.transaction(async sql=>{
      const loan=await sql.query<{state:string}>('SELECT state FROM sicara.loans WHERE id=$1 FOR UPDATE',[intent.loan_id]);
      if(!['release_pending','released'].includes(loan.rows[0]?.state))return null;
      const pending=await sql.query<ReturnPayment>("SELECT * FROM sicara.release_payments WHERE loan_id=$1 AND state<>'confirmed' ORDER BY sequence LIMIT 1",[intent.loan_id]);
      if(pending.rows[0])return pending.rows[0];
      const totals=await sql.query<{paid:string;sequence:number}>('SELECT coalesce(sum(zatoshis),0)::text AS paid,coalesce(max(sequence),0)::integer AS sequence FROM sicara.release_payments WHERE loan_id=$1',[intent.loan_id]);
      const remaining=BigInt(intent.zatoshis)-BigInt(totals.rows[0].paid);
      if(remaining<0n)throw new Error('Release exceeds bound collateral');
      if(remaining===0n){await sql.query("UPDATE sicara.release_intents SET state='confirmed' WHERE loan_id=$1",[intent.loan_id]);await sql.query("UPDATE sicara.loans SET state='released' WHERE id=$1",[intent.loan_id]);return null;}
      const inserted=await sql.query<ReturnPayment>('INSERT INTO sicara.release_payments(id,loan_id,sequence,destination,zatoshis) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),intent.loan_id,totals.rows[0].sequence+1,intent.destination,(remaining<REFUND_CHUNK_ZATOSHIS?remaining:REFUND_CHUNK_ZATOSHIS).toString()]);
      return inserted.rows[0];
    });
  }
  private async review(id:string){
    await this.db.transaction(async sql=>{
      await sql.query('SELECT id FROM sicara.loans WHERE id=$1 FOR UPDATE',[id]);
      await sql.query("UPDATE sicara.release_intents SET state='review' WHERE loan_id=$1",[id]);
      await sql.query("UPDATE sicara.release_payments SET state='review' WHERE loan_id=$1",[id]);
      await sql.query("UPDATE sicara.loans SET state='release_review' WHERE id=$1",[id]);
    });
  }
}

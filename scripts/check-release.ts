/** Internal live proof for the existing synthetic loan; never a public withdrawal endpoint. */
import {readFile,mkdir,open,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Hex} from 'viem';
import {connectWorker} from '../services/database/worker-connection';
import {TestnetWallet} from '../services/zcash/sidecar-client';
import {SidecarWorkerWallet,returnMemo} from '../services/zcash/worker-wallet';
import {CollateralWorker} from '../services/zcash/collateral-worker';
import {OperationJournal} from '../services/zcash/operation-journal';
import {ReleaseWorker} from '../services/settlement/release-worker';
import {SepoliaSettlementVerifier,type SettlementBinding} from '../services/settlement/sepolia-settlement';
import {object} from '../services/zcash/protocol';

const file=resolve('.local/evidence/repaid-release.json');
type Evidence={loanId:string;chainLoanId:Hex;pool:Hex;repaidVerified:boolean;settlementTx:Hex;transactions:Record<string,Hex>;releaseTx?:string;faultArmed?:boolean;completed?:boolean;receiverVerified?:boolean;releaseConfirmations?:number;runs?:string[]};
async function save(value:Evidence){
 await mkdir(resolve('.local/evidence'),{recursive:true,mode:0o700});const temp=`${file}.${randomUUID()}.tmp`;const handle=await open(temp,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}await rename(temp,file);
 const directory=await open(resolve('.local/evidence'),'r');try{await directory.sync();}finally{await directory.close();}
}
async function pause(signal:AbortSignal){
 if(signal.aborted)return;
 await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,30_000);signal.addEventListener('abort',done,{once:true});});
}
async function main(){
 if(!process.env.DATABASE_WORKER_URL)throw new Error('Worker configuration required');
 const evidence:Evidence=JSON.parse(await readFile(file,'utf8'));
 if(!evidence.repaidVerified||!evidence.settlementTx||evidence.transactions.settle!==evidence.settlementTx)throw new Error('Verified repayment evidence required');
 const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const connection=await connectWorker(process.env.DATABASE_WORKER_URL,stop);
 const binary=resolve(process.env.SICARA_ZCASH_BINARY??'.local/zcash/bin/zec-sidecar');const dataDir=resolve(process.env.SICARA_ZCASH_WALLET_DIR??'.local/zcash/wallet');
 let custody:TestnetWallet|undefined;let receiver:TestnetWallet|undefined;
 try{
  custody=await TestnetWallet.start({binary,dataDir,signal:controller.signal});
  const gateway=new SidecarWorkerWallet(custody,resolve(process.env.SICARA_ADDRESS_VALIDATOR??'.local/zcash/native-target/release/sicara-address-check'));
  const journal=new OperationJournal(join(dataDir,'sicara-operations'));
  const verifier=new SepoliaSettlementVerifier(process.env.SICARA_SEPOLIA_RPC_URL??'https://ethereum-sepolia-rpc.publicnode.com');
  const release=new ReleaseWorker(connection.database,gateway,journal,verifier);
  const worker=new CollateralWorker(connection.database,gateway,journal,1_000_000n,snapshot=>release.tick(snapshot));await worker.initialize();
  evidence.runs??=[];evidence.runs.push(randomUUID());await save(evidence);
  if(!evidence.completed&&!evidence.faultArmed){
   evidence.faultArmed=true;await save(evidence);
   const send=gateway.sendRelease.bind(gateway);
   gateway.sendRelease=async(destination,amount,id)=>{const txid=await send(destination,amount,id);evidence.releaseTx=txid;await save(evidence);throw new Error('Controlled lost response after real release broadcast');};
   await worker.tick();
   console.log(JSON.stringify({phase:evidence.releaseTx?'release_unknown':'waiting',releaseTx:evidence.releaseTx,stoppedForRestart:true}));return;
  }
  const attempts=process.argv.includes('--wait')?60:1;
  for(let attempt=0;attempt<attempts&&!controller.signal.aborted;attempt++){
   // Completed evidence can only inspect history; never run another wallet effect.
   if(!evidence.completed)await worker.tick();
   const snapshot=await gateway.scan();
   const binding=await connection.database.query<SettlementBinding&Record<string,unknown>>('SELECT a.pool,a.chain_loan_id,a.deposit_commitment,a.policy_hash,a.registration_tx,a.registration_block_hash,l.wallet,r.settlement_tx FROM sicara.release_intents r JOIN sicara.collateral_authorizations a ON a.loan_id=r.loan_id JOIN sicara.loans l ON l.id=r.loan_id WHERE r.loan_id=$1',[evidence.loanId]);
   if(binding.rows.length!==1||!await verifier.verify(binding.rows[0]))throw new Error('Canonical settlement no longer verified');
   const row=await connection.database.query<{id:string;state:string;txid:string|null;zatoshis:string;destination:string;loan_state:string;intent_state:string;confirmed_height:string|null}>("SELECT p.*,p.zatoshis::text,l.state AS loan_state,r.state AS intent_state FROM sicara.release_payments p JOIN sicara.loans l ON l.id=p.loan_id JOIN sicara.release_intents r ON r.loan_id=p.loan_id WHERE p.loan_id=$1 ORDER BY p.sequence",[evidence.loanId]);
   if(row.rows.length!==1||row.rows[0].zatoshis!=='10000')throw new Error('Unexpected release history');
   const payment=row.rows[0];if(payment.txid&&evidence.releaseTx&&payment.txid!==evidence.releaseTx)throw new Error('Changed release transaction');
   if(payment.txid)evidence.releaseTx=payment.txid;
   if(payment.confirmed_height)evidence.releaseConfirmations=snapshot.tip-Number(payment.confirmed_height)+1;
   if(payment.loan_state==='release_review'||payment.state==='review'||payment.intent_state==='review')throw new Error('Release requires review; no resubmission');
   if(payment.loan_state==='released'&&payment.state==='confirmed'&&payment.intent_state==='confirmed'){
    if(!payment.txid||snapshot.stale||!await gateway.inspectShielded(payment.txid))throw new Error('Shielded release not verified');
    const prior=JSON.parse(await readFile(resolve('.local/evidence/zcash-roundtrip.json'),'utf8'));if(!prior.completed||prior.returnAddress!==payment.destination)throw new Error('Independent return wallet differs');
    receiver=await TestnetWallet.start({binary,dataDir:resolve('.local/zcash/return-wallet'),signal:controller.signal});
    if(await receiver.address()!==payment.destination)throw new Error('Wrong receiver wallet');
    await receiver.sync();const received=await receiver.deposits(0);
    const notes=received.notes.filter(note=>note.txid===payment.txid&&note.address===payment.destination&&note.source==='wallet'&&note.height!==null&&received.tip-note.height+1>=10);
    if(received.stale||notes.reduce((sum,note)=>sum+note.zatoshis,0n)!==10_000n)throw new Error('Independent receiver not ready');
    const ledger=await custody.ledger();const entries=Array.isArray(ledger.entries)?ledger.entries.map(object).filter(entry=>entry.direction==='sent'&&entry.memoHex===returnMemo(payment.id,'release')):[];
    if(entries.length!==1||entries[0].txid!==payment.txid||entries[0].address!==payment.destination||entries[0].zats!=='10000'||entries[0].height!==Number(payment.confirmed_height)||snapshot.tip-Number(payment.confirmed_height)+1<10)throw new Error('Expected one canonical confirmed release');
    evidence.receiverVerified=true;evidence.completed=true;await save(evidence);
    console.log(JSON.stringify({phase:'complete',releaseTx:payment.txid,zatoshis:'10000',releaseConfirmations:evidence.releaseConfirmations,receiverVerified:true,duplicateSends:false,runs:evidence.runs.length}));return;
   }
   await save(evidence);console.log(JSON.stringify({phase:payment.loan_state,payment:payment.state,releaseTx:evidence.releaseTx,confirmations:evidence.releaseConfirmations??0}));
   if(attempt+1<attempts)await pause(controller.signal);
  }
 }finally{await receiver?.close();await custody?.close();await connection.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
void main().catch(()=>{console.error('Shielded release check stopped. Preserve existing signed packets, SQL and wallet journal; reconcile before any retry. No credentials logged.');process.exitCode=1;});

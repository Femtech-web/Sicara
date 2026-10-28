/** Experimental amount-free policy admission. NO FROST share or live spend API. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {mkdir,open,readFile} from 'node:fs/promises';
import {join} from 'node:path';

const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export type Lock = {
 version:1;network:'zcash-testnet';pool:'ironwood';custodyKey:string;claim:string;
 loanId:string;borrower:string;evmChain:11155111;contract:string;policy:string;
 destinationCommitment:string;registrationContext:string;
};
export type SettlementCheckpoint={
 version:1;kind:'repaid-no-reborrow';chain:11155111;contract:string;loanId:string;
 borrower:string;policy:string;registrationContext:string;block:number;blockHash:string;
 tip:number;observedAt:number;
};
export type Endorsement={signer:string;signature:string};
export type ReleaseStatement={
 version:1;kind:'shielded-full-principal-return';network:'zcash-testnet';pool:'ironwood';
 custodyKey:string;claim:string;loanId:string;destinationCommitment:string;
 transactionDigest:string;checkpointHash:string;policy:string;
};
export function checkpointMessage(c:SettlementCheckpoint){return Buffer.from(JSON.stringify(['sicara:experimental:settlement-checkpoint:v1',c.version,c.kind,c.chain,c.contract,c.loanId,c.borrower,c.policy,c.registrationContext,c.block,c.blockHash,c.tip,c.observedAt]));}
export const checkpointHash=(c:SettlementCheckpoint)=>createHash('sha256').update(checkpointMessage(c)).digest('hex');
export const lockHash=(lock:Lock)=>hash(lock);

async function reserve(directory:string,name:string,value:unknown){
 await mkdir(directory,{recursive:true,mode:0o700});const file=await open(join(directory,name),'wx',0o600);
 try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
 const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
}
function validLock(l:Lock){
 const fields=['version','network','pool','custodyKey','claim','loanId','borrower','evmChain','contract','policy','destinationCommitment','registrationContext'];
 if(Object.keys(l).sort().join(',')!==fields.sort().join(',')||l.version!==1||l.network!=='zcash-testnet'||l.pool!=='ironwood'||l.evmChain!==11155111||![l.custodyKey,l.claim,l.loanId,l.policy,l.destinationCommitment,l.registrationContext].every(hex)||!/^0x[0-9a-f]{40}$/.test(l.borrower)||!/^0x[0-9a-f]{40}$/.test(l.contract))throw new Error('Invalid pinned lock');
}
/** The transaction-policy verifier must bind the EXACT digest, full locked input,
 * shielded return commitment and fee policy without receiving note plaintext.
 * It is a test seam today: no implemented private transaction proof is claimed.
 */
export class ExperimentalCosignerPolicy {
 private readonly observers:ReadonlyMap<string,string>;
 constructor(private readonly directory:string,observerKeys:ReadonlyMap<string,string>,private readonly verifyPrivateTransaction:(statement:ReleaseStatement,proof:Uint8Array)=>Promise<void>){
  if(observerKeys.size<2||new Set(observerKeys.values()).size!==observerKeys.size)throw new Error('Two distinct pinned observer keys required');
  for(const key of observerKeys.values()){if(createPublicKey(key).asymmetricKeyType!=='ed25519')throw new Error('Ed25519 observer key required');}
  this.observers=new Map(observerKeys);
 }
 /** Must complete before authorizing borrowing; expiry NEVER unlocks this key.
  * One fresh threshold custody key per loan avoids borrowing against another
  * note while authorizing a full-wallet release. Certification is still missing.
  */
 async freeze(lock:Lock){validLock(lock);await reserve(this.directory,`${lock.custodyKey}.lock`,lock);}
 async prepareRelease(lock:Lock,checkpoint:SettlementCheckpoint,endorsements:Endorsement[],statement:ReleaseStatement,privateProof:Uint8Array,now=Date.now()){
  validLock(lock);
  const stored=JSON.parse(await readFile(join(this.directory,`${lock.custodyKey}.lock`),'utf8'));
  if(lockHash(stored)!==lockHash(lock))throw new Error('Pinned lock changed');
  const c=checkpoint;
  if(c.version!==1||c.kind!=='repaid-no-reborrow'||c.chain!==11155111||c.contract!==lock.contract||c.loanId!==lock.loanId||c.borrower!==lock.borrower||c.policy!==lock.policy||c.registrationContext!==lock.registrationContext||!hex(c.blockHash)||!Number.isSafeInteger(c.block)||!Number.isSafeInteger(c.tip)||c.block<1||c.tip-c.block+1<12||!Number.isSafeInteger(c.observedAt)||c.observedAt>now||now-c.observedAt>30_000)throw new Error('Settlement checkpoint mismatch or stale');
  const seen=new Set<string>();let count=0;
  for(const e of endorsements){
   if(seen.has(e.signer))throw new Error('Duplicate observer');seen.add(e.signer);
   const key=this.observers.get(e.signer);
   if(!key||!/^[0-9a-f]{128}$/.test(e.signature)||!verify(null,checkpointMessage(c),key,Buffer.from(e.signature,'hex')))throw new Error('Invalid checkpoint endorsement');count++;
  }
  if(count<2)throw new Error('Observer quorum missing');
  const s=statement;
  if(s.version!==1||s.kind!=='shielded-full-principal-return'||s.network!==lock.network||s.pool!==lock.pool||s.custodyKey!==lock.custodyKey||s.claim!==lock.claim||s.loanId!==lock.loanId||s.destinationCommitment!==lock.destinationCommitment||s.policy!==lock.policy||s.checkpointHash!==checkpointHash(c)||!hex(s.transactionDigest))throw new Error('Release statement mismatch');
  if(privateProof.length===0||privateProof.length>100_000)throw new Error('Private transaction-policy proof required');
  await this.verifyPrivateTransaction(s,privateProof);
  // Reserve BEFORE returning policy admission. Crash/unknown outcome stays frozen.
  // Never expire/delete or regenerate a digest; no signature/nonces exist here.
  await reserve(this.directory,`${lock.custodyKey}.release`,{scope:'experimental-no-spend-authority',lockHash:lockHash(lock),transactionDigest:s.transactionDigest,statementHash:hash(s)});
  return {policyAdmissionPrepared:true,transactionDigest:s.transactionDigest,frostSignatureProduced:false,readyForFundedTest:false};
 }
}

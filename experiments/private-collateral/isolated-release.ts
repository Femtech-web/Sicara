/** Isolated test admission ONLY. No wallet, FROST nonces or broadcast capability. */
import {createHash} from 'node:crypto';
import {mkdir,open,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CommonCeilingSettlementVerifier,type CommonSettlementBinding} from './lock-settlement';

export type TestSchedule={maturityHeight:number;releaseExpiryHeight:number;releaseConfirmations:number;releaseAdmissionBuffer:number;repaymentCutoff:number;settlementCutoff:number};
export type ChainSource=string|{source:string;operator:string;stack:string};
export type ChainTrust='independent-quorum'|'trusted-single-server-test-only';
export type ChainObservation={kind:'cross-checked-trusted-rpc'|'trusted-single-server-test-only';network:'zcash-testnet';pool:'ironwood';height:number;tipHeight:number;blockHash:string;root:string;observedAt:number;sources:ChainSource[];quorum:number};
export type IsolatedLock={version:1;custodyKey:string;nullifier:string;defaultDigest:string;lenderOutpointHash:string;schedule:TestSchedule;settlement:Omit<CommonSettlementBinding,'settlementTx'>};
export type ReleaseEffects={digest:string;nullifier:string;expiryHeight:number;lockTime:number;shieldedOnly:boolean;privateReturnPolicyVerified:boolean};
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function reserve(directory:string,name:string,value:unknown){
 await mkdir(directory,{recursive:true,mode:0o700});const f=await open(join(directory,name),'wx',0o600);
 try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}
 const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
}
export function checkSchedule(s:TestSchedule){
 if(Object.keys(s).sort().join(',')!==['maturityHeight','releaseExpiryHeight','releaseConfirmations','releaseAdmissionBuffer','repaymentCutoff','settlementCutoff'].sort().join(',')||!Object.values(s).every(Number.isSafeInteger)||s.maturityHeight<1||s.maturityHeight>=500_000_000||s.releaseExpiryHeight<1||s.releaseConfirmations<10||s.releaseAdmissionBuffer<20||s.releaseExpiryHeight+s.releaseConfirmations>=s.maturityHeight||s.repaymentCutoff<1||s.settlementCutoff-s.repaymentCutoff<120)throw new Error('Unsafe test maturity schedule');
}
export function checkReleaseWindow(s:TestSchedule,o:ChainObservation,now:number,trust:ChainTrust='independent-quorum'){
 checkSchedule(s);
 const pins=new Map([
  ['https://testnet.zec.rocks:443',['zec.rocks','lightwalletd']],
  ['https://zaino.testnet.unsafe.zec.rocks:443',['zec.rocks','zaino']],
  ['https://lightwalletd.testnet.electriccoin.co:9067',['ecc','lightwalletd']],
  ['https://lwd.testnet.zec.pro:443',['zec.pro','lightwalletd']],
  ['https://zcash-testnet.chainsafe.dev:443',['chainsafe','lightwalletd']],
  ['https://lightwalletd.testnet.cipherscan.app:443',['cipherscan','lightwalletd']],
 ]);
 const operators=new Set<string>();
 for(const entry of o.sources){
  const source=typeof entry==='string'?entry:entry.source;
  const pin=pins.get(source);
  if(!pin||(typeof entry!=='string'&&(entry.operator!==pin[0]||entry.stack!==pin[1])))throw new Error('Unpinned observer identity');
  operators.add(pin[0]);
 }
 const testMode=trust==='trusted-single-server-test-only';
 if(testMode&&(o.sources.length!==1||(typeof o.sources[0]==='string'?o.sources[0]:o.sources[0].source)!=='https://testnet.zec.rocks:443'||o.quorum!==1))throw new Error('Test-only source must be exactly the owner-approved server');
 if(o.kind!==(testMode?'trusted-single-server-test-only':'cross-checked-trusted-rpc')||o.network!=='zcash-testnet'||o.pool!=='ironwood'||!Number.isSafeInteger(o.height)||!Number.isSafeInteger(o.tipHeight)||o.height<1||o.tipHeight-o.height+1!==10||!hex(o.blockHash)||!hex(o.root)||!Number.isSafeInteger(o.observedAt)||o.observedAt>now||now-o.observedAt>30_000||!Number.isSafeInteger(o.quorum)||o.quorum<(testMode?1:2)||operators.size<o.quorum)throw new Error('Missing fresh cross-checked chain observation');
 if(o.tipHeight+s.releaseAdmissionBuffer>=s.releaseExpiryHeight||now>=s.settlementCutoff*1000)throw new Error('Insufficient release window; reconciliation required');
}

/** The effect reader MUST recompute the signature digest from exact transaction
 * bytes and verify output/fee policy without disclosing values. There is no live
 * implementation of that private-return verifier yet; absent reader fails closed.
 * Both services must run this independently with separate backed-up directories.
 */
export class IsolatedReleaseCoordinator {
 constructor(private directory:string,private settlement:CommonCeilingSettlementVerifier,
  private observe:()=>Promise<ChainObservation>,
  private inspectPrivateReturn:(transaction:Uint8Array,lock:IsolatedLock)=>Promise<ReleaseEffects>,private trust:ChainTrust='independent-quorum'){ }
 async freeze(lock:IsolatedLock){
  checkSchedule(lock.schedule);
  if(Object.keys(lock).sort().join(',')!==['version','custodyKey','nullifier','defaultDigest','lenderOutpointHash','schedule','settlement'].sort().join(',')||Object.keys(lock.settlement).sort().join(',')!==['pool','runtimeCodeHash','loanId','borrower','claim','custodyKey','policy','registrationTx','registrationBlockHash','repaymentCutoff','settlementCutoff'].sort().join(',')||lock.version!==1||![lock.custodyKey,lock.nullifier,lock.defaultDigest,lock.lenderOutpointHash].every(hex)||lock.settlement.custodyKey!==`0x${lock.custodyKey}`||lock.schedule.repaymentCutoff!==lock.settlement.repaymentCutoff||lock.schedule.settlementCutoff!==lock.settlement.settlementCutoff)throw new Error('Invalid isolated lock binding');
  // Partial writes freeze availability; input/key reservations never expire.
  await reserve(this.directory,`${lock.lenderOutpointHash}.utxo`,{lockHash:digest(lock)});
  await reserve(this.directory,`${lock.custodyKey}.lock`,lock);
 }
 async prepareRelease(lock:IsolatedLock,settlementTx:CommonSettlementBinding['settlementTx'],transaction:Uint8Array,now=Date.now()){
  if(!hex(lock.custodyKey)||!hex(lock.lenderOutpointHash))throw new Error('Invalid isolated key');
  const pinned=JSON.parse(await readFile(join(this.directory,`${lock.custodyKey}.lock`),'utf8'));
  const input=JSON.parse(await readFile(join(this.directory,`${lock.lenderOutpointHash}.utxo`),'utf8'));
  if(digest(pinned)!==digest(lock)||input.lockHash!==digest(lock))throw new Error('Pinned lock or lender input changed');
  checkReleaseWindow(lock.schedule,await this.observe(),now,this.trust);
  const settled=await this.settlement.verify({...lock.settlement,settlementTx});
  if(transaction.length===0||transaction.length>2_000_000)throw new Error('Exact release transaction required');
  const effects=await this.inspectPrivateReturn(transaction,lock);
  if(!hex(effects.digest)||effects.nullifier!==lock.nullifier||effects.lockTime!==0||effects.expiryHeight!==lock.schedule.releaseExpiryHeight||effects.shieldedOnly!==true||effects.privateReturnPolicyVerified!==true)throw new Error('Private return policy not established');
  // Re-observe after RPC/proof work. Never sign using a window checked minutes ago.
  checkReleaseWindow(lock.schedule,await this.observe(),Math.max(now,Date.now()),this.trust);
  await reserve(this.directory,`${lock.custodyKey}.release`,{
   scope:'experimental-admission-no-signature',lockHash:digest(lock),transactionDigest:effects.digest,
   settlementTx,settlementBlock:settled.settlementBlock.toString(),settlementBlockHash:settled.settlementBlockHash,
  });
  return {transactionDigest:effects.digest,signingEnabled:false as const,broadcastEnabled:false as const};
 }
}

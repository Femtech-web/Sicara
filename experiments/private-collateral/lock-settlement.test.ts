import test from 'node:test';
import assert from 'node:assert/strict';
import {custom,decodeFunctionData,encodeAbiParameters,encodeEventTopics,keccak256,parseAbiParameters,toHex,type Hex} from 'viem';
import {CommonCeilingSettlementVerifier,commonSettlementAbi,type CommonSettlementBinding} from './lock-settlement';
import {execFileSync} from 'node:child_process';
import {nativeLockEffects,releaseEffects} from './lock-effects';
import {IsolatedEscrowCoordinator,escrowAuthorizationMessage,type EscrowBinding} from './escrow-outcome';
import {generateKeyPairSync,sign} from 'node:crypto';
import {IsolatedReleaseCoordinator,checkReleaseWindow,checkSchedule,type IsolatedLock,type ChainObservation} from './isolated-release';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Hex;
const now=Math.floor(Date.now()/1000);
const binding:CommonSettlementBinding={pool:a(1),runtimeCodeHash:keccak256('0x6001'),loanId:h(2),borrower:a(3),claim:h(4),custodyKey:h(5),policy:h(6),registrationTx:h(7),registrationBlockHash:h(8),settlementTx:h(9),repaymentCutoff:now+600,settlementCutoff:now+900};
type Mode='pending-resolution'|'recovered'|'defaulted'|'valid'|'unconfirmed'|'wrong-chain'|'failed'|'wrong-pool'|'wrong-registration'|'wrong-loan'|'wrong-claim'|'wrong-key'|'wrong-borrower'|'unsettled'|'unconsumed-claim'|'unconsumed-key'|'wrong-policy'|'wrong-cutoff'|'wrong-code'|'reorg'|'mid-check-reorg'|'late'|'offline';
function verifier(mode:Mode='valid',b:CommonSettlementBinding=binding){
 let blocks=0;
 return new CommonCeilingSettlementVerifier('unused',custom({request:async({method,params})=>{
  if(mode==='offline')throw new Error('RPC unavailable');
  if(method==='eth_chainId')return toHex(mode==='wrong-chain'?1:11155111);
  if(method==='eth_blockNumber')return toHex(mode==='unconfirmed'?110:111);
  if(method==='eth_getCode')return mode==='wrong-code'?'0x6002':'0x6001';
  if(method==='eth_getTransactionReceipt'){
   const reg=(params as [Hex])[0]===b.registrationTx;
   const blockHash=reg?b.registrationBlockHash:h(10);
   const tx=reg?b.registrationTx:b.settlementTx;
   const topics=reg?encodeEventTopics({abi:commonSettlementAbi,eventName:'EligibilityConsumed',args:{loanId:b.loanId,claim:mode==='wrong-claim'?h(40):b.claim,custodyKey:mode==='wrong-key'?h(50):b.custodyKey}}):encodeEventTopics({abi:commonSettlementAbi,eventName:'LoanSettled',args:{loanId:mode==='wrong-loan'?h(20):b.loanId}});
   const logs=[{address:b.pool,topics,data:'0x' as Hex,blockNumber:toHex(reg?90:100),transactionHash:tx,transactionIndex:'0x0',blockHash,logIndex:'0x0',removed:false}];
   if(!reg&&mode==='recovered')logs.push({...logs[0],topics:encodeEventTopics({abi:commonSettlementAbi,eventName:'LoanResolved',args:{loanId:b.loanId}}),data:encodeAbiParameters(parseAbiParameters('bool'),[true]),logIndex:'0x1'});
   return {transactionHash:tx,blockHash:reg&&mode==='wrong-registration'?h(80):blockHash,blockNumber:toHex(reg?90:100),transactionIndex:'0x0',from:b.borrower,to:mode==='wrong-pool'?a(40):b.pool,cumulativeGasUsed:'0x100',gasUsed:'0x100',effectiveGasPrice:'0x1',status:mode==='failed'?'0x0':'0x1',type:'0x2',logsBloom:`0x${'00'.repeat(256)}`,logs};
  }
  if(method==='eth_getBlockByNumber'){
   blocks++;
   const reg=(params as [Hex])[0]==='0x5a';
   return {number:toHex(reg?90:100),hash:mode==='reorg'||(mode==='mid-check-reorg'&&blocks>2)?h(100):reg?b.registrationBlockHash:h(10),timestamp:toHex(mode==='late'?b.settlementCutoff:['defaulted','recovered','pending-resolution'].includes(mode)?b.settlementCutoff+1:now),transactions:[]};
  }
  if(method==='eth_call'){
   const p=(params as [{data:Hex}])[0];
   const {functionName}=decodeFunctionData({abi:commonSettlementAbi,data:p.data});
   switch(functionName){
    case 'loanState':return encodeAbiParameters(parseAbiParameters('address,bytes32,bytes32,bytes32,bytes32,bytes32,bool'),[mode==='wrong-borrower'?a(30):b.borrower,h(11),h(12),h(13),h(14),h(15),!['unsettled','defaulted','pending-resolution'].includes(mode)]);
    case 'consumedClaim':return encodeAbiParameters(parseAbiParameters('bool'),[mode!=='unconsumed-claim']);
    case 'consumedCustodyKey':return encodeAbiParameters(parseAbiParameters('bool'),[mode!=='unconsumed-key']);
    case 'policyHash':return encodeAbiParameters(parseAbiParameters('bytes32'),[mode==='wrong-policy'?h(60):b.policy]);
    case 'repaymentCutoff':return encodeAbiParameters(parseAbiParameters('uint64'),[BigInt(b.repaymentCutoff+(mode==='wrong-cutoff'?1:0))]);
    case 'settlementCutoff':return encodeAbiParameters(parseAbiParameters('uint64'),[BigInt(b.settlementCutoff)]);
    case 'resolution':return encodeAbiParameters(parseAbiParameters('uint8'),[mode==='defaulted'?2:mode==='recovered'?1:0]);
    case 'resolutionHandle':return encodeAbiParameters(parseAbiParameters('bytes32'),[['defaulted','recovered'].includes(mode)?h(15):h(0)]);
   }
  }
  throw new Error(`Unexpected method ${method}`);
 }},{retryCount:0}));
}

test('common-ceiling release requires canonical KMS-settled receipt, exact registration, code and deadlines',async()=>{
 assert.equal((await verifier().verify(binding)).kind,'verified-common-ceiling-settlement');
 assert.equal((await verifier('recovered').verify(binding)).kind,'verified-common-ceiling-settlement');
 for(const mode of ['unconfirmed','wrong-chain','failed','wrong-pool','wrong-registration','wrong-loan','wrong-claim','wrong-key','wrong-borrower','unsettled','unconsumed-claim','unconsumed-key','wrong-policy','wrong-cutoff','wrong-code','reorg','mid-check-reorg','late','offline'] as const){
  await assert.rejects(verifier(mode).verify(binding),Error,mode);
 }
});

test('isolated release reserves key/input and exact digest across restart; late or unverified returns stay frozen',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sicara-isolated-release-'));
 try{
  const schedule={maturityHeight:1200,releaseExpiryHeight:1180,releaseConfirmations:10,releaseAdmissionBuffer:20,repaymentCutoff:binding.repaymentCutoff,settlementCutoff:binding.settlementCutoff};
  const {settlementTx,...settlement}=binding;
  const lock:IsolatedLock={version:1,custodyKey:binding.custodyKey.slice(2),nullifier:h(21).slice(2),defaultDigest:h(22).slice(2),lenderOutpointHash:h(23).slice(2),schedule,settlement};
  const observation:ChainObservation={kind:'cross-checked-trusted-rpc',network:'zcash-testnet',pool:'ironwood',height:1091,tipHeight:1100,root:h(24).slice(2),blockHash:h(25).slice(2),observedAt:Date.now(),sources:['https://testnet.zec.rocks:443','https://lightwalletd.testnet.electriccoin.co:9067'],quorum:2};
  const effects={digest:h(26).slice(2),nullifier:lock.nullifier,expiryHeight:1180,lockTime:0,shieldedOnly:true,privateReturnPolicyVerified:true};
  // Fixture effects only. The real private return verifier remains unavailable.
  const good=()=>new IsolatedReleaseCoordinator(directory,verifier(),async()=>observation,async()=>effects);
  await good().freeze(lock);
  await assert.rejects(good().freeze({...lock,custodyKey:h(27).slice(2),settlement:{...settlement,custodyKey:h(27)}}),{code:'EEXIST'});
  await assert.rejects(new IsolatedReleaseCoordinator(directory,verifier('unsettled'),async()=>observation,async()=>effects).prepareRelease(lock,settlementTx,new Uint8Array([1])));
  await assert.rejects(new IsolatedReleaseCoordinator(directory,verifier(),async()=>observation,async()=>{throw new Error('Private return verifier unavailable');}).prepareRelease(lock,settlementTx,new Uint8Array([1])),/unavailable/);
  await assert.rejects(new IsolatedReleaseCoordinator(directory,verifier(),async()=>observation,async()=>({...effects,nullifier:h(28).slice(2)})).prepareRelease(lock,settlementTx,new Uint8Array([1])),/policy/);
  let reads=0;
  await assert.rejects(new IsolatedReleaseCoordinator(directory,verifier(),async()=>{const tipHeight=++reads===1?1100:1160;return {...observation,tipHeight,height:tipHeight-9};},async()=>effects).prepareRelease(lock,settlementTx,new Uint8Array([1])),/window/);
  const outcomes=await Promise.allSettled([good().prepareRelease(lock,settlementTx,new Uint8Array([1])),good().prepareRelease(lock,settlementTx,new Uint8Array([1]))]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  await assert.rejects(good().prepareRelease(lock,settlementTx,new Uint8Array([1])),{code:'EEXIST'});
  const record=JSON.parse(await readFile(join(directory,`${lock.custodyKey}.release`),'utf8'));
  assert.equal(record.transactionDigest,effects.digest);
  assert.equal(record.settlementTx,settlementTx);
  for(const bad of [{...observation,observedAt:Date.now()-31_000},{...observation,sources:['one'],quorum:1},{...observation,tipHeight:1170}]){
   assert.throws(()=>checkReleaseWindow(schedule,bad,Date.now()));
  }
  assert.throws(()=>checkSchedule({...schedule,releaseExpiryHeight:1195}));
  assert.throws(()=>checkSchedule({...schedule,maturityHeight:500_000_000}));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('default is only established after the settlement cutoff, in a confirmed unsettled block',async()=>{
 const {settlementTx:ignoredSettlementTx,...pinned}=binding;
 void ignoredSettlementTx;
 assert.equal((await verifier('defaulted').verifyUnsettledAfterCutoff(pinned)).kind,'verified-unsettled-after-cutoff');
 for(const mode of ['pending-resolution','recovered','valid','late','unconfirmed','wrong-chain','wrong-registration','wrong-claim','wrong-key','wrong-borrower','unconsumed-claim','wrong-policy','wrong-cutoff','wrong-code','offline'] as const){
  await assert.rejects(verifier(mode).verifyUnsettledAfterCutoff(pinned),Error,mode);
 }
});

const lockBin=process.env.SICARA_LOCK_BIN;
test('real redacted PCZTs: native effect reader drives release admission and escrow recovery',{skip:!lockBin},async()=>{
 const report=JSON.parse(execFileSync(lockBin!,['--lock-kit','--export-fixture'],{env:{RAYON_NUM_THREADS:'2'},encoding:'utf8',maxBuffer:50_000_000,timeout:300_000}));
 const {release,escrowRefund,escrowClaim}=report.inspectorFixtures;
 const bytes=(f:{pczt:string})=>Buffer.from(f.pczt,'hex');
 const read=nativeLockEffects(lockBin!);
 const effects=await read(bytes(release),release.custodyKey,release.nullifier);
 assert.equal(effects.privateReturnPolicyVerified,true);
 assert.equal(effects.plaintextPresent,false);
 assert.equal(effects.digest,release.digest);
 assert.equal(effects.expiryHeight,release.expiryHeight);
 assert.equal((await read(bytes(release),release.custodyKey,escrowRefund.nullifier)).privateReturnPolicyVerified,false);
 assert.equal((await read(bytes(escrowRefund),release.custodyKey,release.nullifier)).privateReturnPolicyVerified,false);
 // The digest covers effects, not proofs (ZIP 244), so it is recomputed from the
 // inspected effects. Effect tampering (other note, later expiry) is rejected natively.
 await assert.rejects(read(bytes(release).subarray(0,4096),release.custodyKey,release.nullifier));
 const directory=await mkdtemp(join(tmpdir(),'sicara-native-effects-'));
 try{
  const real={...binding,custodyKey:`0x${release.custodyKey}` as Hex};
  const {settlementTx,...settlement}=real;
  const schedule={maturityHeight:release.expiryHeight+30,releaseExpiryHeight:release.expiryHeight,releaseConfirmations:10,releaseAdmissionBuffer:20,repaymentCutoff:binding.repaymentCutoff,settlementCutoff:binding.settlementCutoff};
  const lock:IsolatedLock={version:1,custodyKey:release.custodyKey,nullifier:release.nullifier,defaultDigest:h(22).slice(2),lenderOutpointHash:h(23).slice(2),schedule,settlement};
  const tipHeight=release.expiryHeight-70;
  const observation:ChainObservation={kind:'cross-checked-trusted-rpc',network:'zcash-testnet',pool:'ironwood',height:tipHeight-9,tipHeight,root:h(24).slice(2),blockHash:h(25).slice(2),observedAt:Date.now(),sources:['https://testnet.zec.rocks:443','https://lightwalletd.testnet.electriccoin.co:9067'],quorum:2};
  const coordinator=new IsolatedReleaseCoordinator(join(directory,'release'),verifier('valid',real),async()=>observation,releaseEffects(lockBin!));
  await coordinator.freeze(lock);
  const admitted=await coordinator.prepareRelease(lock,settlementTx,bytes(release));
  assert.equal(admitted.transactionDigest,release.digest);
  const wrongNote={...lock,nullifier:escrowRefund.nullifier};
  const other=new IsolatedReleaseCoordinator(join(directory,'release-wrong'),verifier('valid',real),async()=>observation,releaseEffects(lockBin!));
  await other.freeze(wrongNote);
  await assert.rejects(other.prepareRelease(wrongNote,settlementTx,bytes(release)),/policy/);
  // Missed release: the default fired, the loan had settled, escrow returns to the client.
  const client=generateKeyPairSync('ed25519'),lender=generateKeyPairSync('ed25519');
  const escrowBinding:EscrowBinding={version:1,escrowKey:escrowRefund.custodyKey,escrowNullifier:escrowRefund.nullifier,settlement,clientSigner:client.publicKey.export({type:'spki',format:'pem'}).toString(),lenderSigner:lender.publicKey.export({type:'spki',format:'pem'}).toString()};
  const authorize=(partner:'client'|'lender',digest=escrowRefund.digest)=>sign(null,escrowAuthorizationMessage(escrowBinding,partner,digest),partner==='client'?client.privateKey:lender.privateKey).toString('hex');
  const refunds=new IsolatedEscrowCoordinator(join(directory,'escrow'),verifier('valid',real),read);
  await refunds.freeze(escrowBinding);
  await assert.rejects(refunds.decide(escrowBinding,{partner:'lender',transaction:bytes(escrowRefund)}),/window/);
  const unsettled=new IsolatedEscrowCoordinator(join(directory,'escrow-unsettled'),verifier('unsettled',real),read);await unsettled.freeze(escrowBinding);
  await assert.rejects(unsettled.decide(escrowBinding,{partner:'client',settlementTx,transaction:bytes(escrowRefund)}));
  await assert.rejects(refunds.decide(escrowBinding,{partner:'client',transaction:bytes(escrowRefund)}),/receipt/);
  await assert.rejects(refunds.decide({...escrowBinding,settlement:{...settlement,loanId:h(90)}},{partner:'client',settlementTx,transaction:bytes(escrowRefund)}),/changed/);
  await assert.rejects(refunds.decide(escrowBinding,{partner:'client',settlementTx,transaction:bytes(escrowRefund)}),/authorize/);
  await assert.rejects(refunds.decide(escrowBinding,{partner:'client',settlementTx,transaction:bytes(escrowRefund),authorization:authorize('lender')}),/authorize/);
  const refund=await refunds.decide(escrowBinding,{partner:'client',settlementTx,transaction:bytes(escrowRefund),authorization:authorize('client')});
  assert.equal(refund.transactionDigest,escrowRefund.digest);
  assert.equal(refund.outcome,'verified-common-ceiling-settlement');
  await assert.rejects(refunds.decide(escrowBinding,{partner:'client',settlementTx,transaction:bytes(escrowRefund),authorization:authorize('client')}),{code:'EEXIST'});
  const claims=new IsolatedEscrowCoordinator(join(directory,'escrow-default'),verifier('defaulted',real),read);
  await claims.freeze(escrowBinding);
  assert.equal((await claims.decide(escrowBinding,{partner:'lender',transaction:bytes(escrowClaim),authorization:authorize('lender',escrowClaim.digest)})).outcome,'verified-unsettled-after-cutoff');
  assert.equal(report.escrow.missedDeadlineRefundVerified,true);
  assert.equal(report.escrow.excessFeeRejected,true);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('approved single-server test observations cannot enter the independent-quorum path',()=>{
 const schedule={maturityHeight:1200,releaseExpiryHeight:1180,releaseConfirmations:10,releaseAdmissionBuffer:20,repaymentCutoff:binding.repaymentCutoff,settlementCutoff:binding.settlementCutoff};
 const observation:ChainObservation={kind:'trusted-single-server-test-only',network:'zcash-testnet',pool:'ironwood',height:1091,tipHeight:1100,root:h(24).slice(2),blockHash:h(25).slice(2),observedAt:Date.now(),sources:[{source:'https://testnet.zec.rocks:443',operator:'zec.rocks',stack:'lightwalletd'}],quorum:1};
 assert.throws(()=>checkReleaseWindow(schedule,observation,Date.now()));
 assert.doesNotThrow(()=>checkReleaseWindow(schedule,observation,Date.now(),'trusted-single-server-test-only'));
 assert.throws(()=>checkReleaseWindow(schedule,{...observation,sources:['https://lightwalletd.testnet.electriccoin.co:9067']},Date.now(),'trusted-single-server-test-only'));
 const sameOperator:ChainObservation={...observation,kind:'cross-checked-trusted-rpc',quorum:2,sources:[...observation.sources,{source:'https://zaino.testnet.unsafe.zec.rocks:443',operator:'zec.rocks',stack:'zaino'}]};
 assert.throws(()=>checkReleaseWindow(schedule,sameOperator,Date.now()));
 assert.doesNotThrow(()=>checkReleaseWindow(schedule,{...sameOperator,sources:[observation.sources[0],{source:'https://lightwalletd.testnet.electriccoin.co:9067',operator:'ecc',stack:'lightwalletd'}]},Date.now()));
});

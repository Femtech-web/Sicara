import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ExperimentalCosignerPolicy,checkpointMessage,checkpointHash,type Lock,type SettlementCheckpoint,type ReleaseStatement} from './cosigner-policy';
const h=()=>randomBytes(32).toString('hex');const address='0x'+'11'.repeat(20);
test('experimental cosigner refuses early/arbitrary release and preserves one digest across restart (transaction proof is a fixture)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sicara-cosigner-'));
 try{
  const keys=[generateKeyPairSync('ed25519'),generateKeyPairSync('ed25519')];
  const pins=new Map(keys.map((k,i)=>[String(i),k.publicKey.export({type:'spki',format:'pem'}).toString()]));
  const missing=new ExperimentalCosignerPolicy(dir,pins,async()=>{throw new Error('Private transaction verifier unavailable');});
  const lock:Lock={version:1,network:'zcash-testnet',pool:'ironwood',custodyKey:h(),claim:h(),loanId:h(),borrower:address,evmChain:11155111,contract:address,policy:h(),destinationCommitment:h(),registrationContext:h()};
  await missing.freeze(lock);
  await assert.rejects(missing.freeze({...lock,custodyKey:h(),amount:'10000'} as Lock),/Invalid pinned lock/);
  await assert.rejects(missing.freeze({...lock,loanId:h()}),{code:'EEXIST'});
  const now=Date.now();
  const checkpoint:SettlementCheckpoint={version:1,kind:'repaid-no-reborrow',chain:11155111,contract:address,loanId:lock.loanId,borrower:address,policy:lock.policy,registrationContext:lock.registrationContext,block:1000,tip:1011,blockHash:h(),observedAt:now};
  const endorse=(c:SettlementCheckpoint)=>keys.map((k,i)=>({signer:String(i),signature:sign(null,checkpointMessage(c),k.privateKey).toString('hex')}));
  const endorsements=endorse(checkpoint);
  const statement:ReleaseStatement={version:1,kind:'shielded-full-principal-return',network:'zcash-testnet',pool:'ironwood',custodyKey:lock.custodyKey,claim:lock.claim,loanId:lock.loanId,destinationCommitment:lock.destinationCommitment,transactionDigest:h(),checkpointHash:checkpointHash(checkpoint),policy:lock.policy};
  await assert.rejects(missing.prepareRelease(lock,checkpoint,endorsements,statement,new Uint8Array([1]),now),/unavailable/);
  // Explicit test verifier, never exposed to a wallet/FROST signer.
  const fixture=new ExperimentalCosignerPolicy(dir,pins,async(s,p)=>{assert.equal(p[0],42);assert.equal(s.transactionDigest,statement.transactionDigest);});
  for(const c of [{...checkpoint,kind:'unpaid'},{...checkpoint,tip:1010},{...checkpoint,observedAt:now-30_001},{...checkpoint,loanId:h()},{...checkpoint,blockHash:h()}]){
   await assert.rejects(fixture.prepareRelease(lock,c as SettlementCheckpoint,endorsements,statement,new Uint8Array([42]),now));
  }
  await assert.rejects(fixture.prepareRelease(lock,checkpoint,[endorsements[0]],statement,new Uint8Array([42]),now),/quorum/);
  await assert.rejects(fixture.prepareRelease(lock,checkpoint,[endorsements[0],endorsements[0]],statement,new Uint8Array([42]),now),/Duplicate/);
  await assert.rejects(fixture.prepareRelease(lock,checkpoint,endorsements,{...statement,destinationCommitment:h()},new Uint8Array([42]),now),/mismatch/);
  await assert.rejects(fixture.prepareRelease(lock,checkpoint,endorsements,statement,new Uint8Array(),now),/required/);
  const outcomes=await Promise.allSettled([fixture.prepareRelease(lock,checkpoint,endorsements,statement,new Uint8Array([42]),now),fixture.prepareRelease(lock,checkpoint,endorsements,statement,new Uint8Array([42]),now)]);
  assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);
  const reopened=new ExperimentalCosignerPolicy(dir,pins,async()=>{});
  await assert.rejects(reopened.prepareRelease(lock,checkpoint,endorsements,{...statement,transactionDigest:h()},new Uint8Array([42]),now),{code:'EEXIST'});
  await assert.rejects(reopened.prepareRelease({...lock,policy:h()},checkpoint,endorsements,statement,new Uint8Array([42]),now),/changed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

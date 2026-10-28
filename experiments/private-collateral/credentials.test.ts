import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {FixtureCredentialIssuer,FixtureCredentialRedeemer,newIssuerKeys,prepareCredential,finishCredential,signRedemption} from './credentials';

const opaque=()=>randomBytes(32).toString('hex');
const borrower='0x1111111111111111111111111111111111111111';
const stranger='0x2222222222222222222222222222222222222222';
const pool='0x3333333333333333333333333333333333333333';
test('blind fixture credentials verify without putting borrower identity in issuance; replay is rejected after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sicara-anonymous-fixture-'));
 try{
  const keys=await newIssuerKeys();const issuance=join(dir,'issuer');const redemption=join(dir,'redeemer');
  const issuer=new FixtureCredentialIssuer(keys,issuance);
  const requests=await Promise.all([prepareCredential(keys.publicKey),prepareCredential(keys.publicKey)]);
  const lock=opaque();const blindSignature=await issuer.issue(lock,requests[0].blinded);
  assert.deepEqual(await new FixtureCredentialIssuer(keys,issuance).issue(lock,requests[0].blinded),blindSignature);
  await assert.rejects(issuer.issue(lock,requests[1].blinded),/already used/);
  const token=await finishCredential(keys.publicKey,requests[0],blindSignature);
  const otherToken=await finishCredential(keys.publicKey,requests[1],await issuer.issue(opaque(),requests[1].blinded));
  const challenge=opaque();const redeemer=new FixtureCredentialRedeemer(keys.publicKey,pool,challenge,redemption);
  const authorization=await signRedemption(token,requests[0],borrower,pool,challenge);
  const records=await Promise.all((await readdir(issuance)).map(file=>readFile(join(issuance,file),'utf8')));
  for(const record of records){assert.ok(!record.includes(borrower));assert.ok(!record.includes(Buffer.from(token.prepared).toString('hex')));assert.ok(!record.includes('amount'));}
  await assert.rejects(redeemer.redeem(token,{...authorization,borrower:stranger}),/binding/);
  await assert.rejects(redeemer.redeem(otherToken,authorization),/binding/);
  const corrupted={...token,signature:new Uint8Array(token.signature)};corrupted.signature[0]^=1;
  await assert.rejects(redeemer.redeem(corrupted,authorization),/credential/);
  const attempts=await Promise.allSettled([redeemer.redeem(token,authorization),redeemer.redeem(token,authorization)]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
  await assert.rejects(new FixtureCredentialRedeemer(keys.publicKey,pool,challenge,redemption).redeem(token,authorization),/already redeemed/);
  await assert.rejects(new FixtureCredentialRedeemer(keys.publicKey,pool,opaque(),redemption).redeem(otherToken,authorization),/challenge/);
  const untrusted=await newIssuerKeys();
  await assert.rejects(new FixtureCredentialRedeemer(untrusted.publicKey,pool,challenge,join(dir,'other')).redeem(token,authorization),/credential/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

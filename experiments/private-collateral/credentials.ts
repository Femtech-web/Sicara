/** OFFLINE fixture protocol using RFC 9474. Not a collateral verifier or app API. */
import {RSABSSA} from '@cloudflare/blindrsa-ts';
import {createHash} from 'node:crypto';
import {mkdir,open,readFile} from 'node:fs/promises';
import {join} from 'node:path';

const suite=RSABSSA.SHA384.PSS.Randomized();
export const FIXTURE_POOL='0x3333333333333333333333333333333333333333';
const prefix=new TextEncoder().encode(`sicara:offline-fixture-credential:sepolia:${FIXTURE_POOL}:v1:common-epoch\0`);
const hex=(bytes:Uint8Array)=>Buffer.from(bytes).toString('hex');
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const fixed=(value:string)=>{if(!/^[a-f0-9]{64}$/.test(value))throw new Error('Opaque fixture identity required');return value;};
export type Credential={prepared:Uint8Array;signature:Uint8Array};
export type ClientRequest={prepared:Uint8Array;blinded:Uint8Array;inverse:Uint8Array;possession:CryptoKeyPair};
export type Redemption={borrower:string;pool:string;challenge:string;signature:Uint8Array};

/** Private files are an experiment-only atomic journal, not a distributed database. */
async function reserve(directory:string,id:string,value:unknown){
 await mkdir(directory,{recursive:true,mode:0o700});
 const handle=await open(join(directory,`${fixed(id)}.json`),'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 const folder=await open(directory,'r');try{await folder.sync();}finally{await folder.close();}
}
function authorizationBytes(token:Credential,borrower:string,pool:string,challenge:string){
 if(!/^0x[0-9a-fA-F]{40}$/.test(borrower)||!/^0x[0-9a-fA-F]{40}$/.test(pool))throw new Error('EVM binding required');
 return new TextEncoder().encode(JSON.stringify(['sicara:offline-redemption:v1',11155111,pool.toLowerCase(),borrower.toLowerCase(),fixed(challenge),digest(token.prepared)]));
}
export async function newIssuerKeys(){
 return suite.generateKey({modulusLength:3072,publicExponent:new Uint8Array([1,0,1])});
}
export async function prepareCredential(publicKey:CryptoKey):Promise<ClientRequest>{
 const possession=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
 const publicBytes=new Uint8Array(await crypto.subtle.exportKey('raw',possession.publicKey));
 const nonce=crypto.getRandomValues(new Uint8Array(32));
 const payload=new Uint8Array(prefix.length+64);payload.set(prefix);payload.set(nonce,prefix.length);payload.set(publicBytes,prefix.length+32);
 const prepared=suite.prepare(payload);const {blindedMsg,inv}=await suite.blind(publicKey,prepared);
 return {prepared,blinded:blindedMsg,inverse:inv,possession};
}
export async function finishCredential(publicKey:CryptoKey,request:ClientRequest,blindSignature:Uint8Array):Promise<Credential>{
 return {prepared:request.prepared,signature:await suite.finalize(publicKey,request.prepared,blindSignature,request.inverse)};
}

export class FixtureCredentialIssuer {
 constructor(private keys:CryptoKeyPair,private directory:string){}
 async issue(syntheticLock:string,blinded:Uint8Array){
  fixed(syntheticLock);if(blinded.length!==384)throw new Error('3072-bit blinded request required');
  // The "lock" is an EXPLICIT synthetic assumption. No Zcash funds are verified here.
  const requestHash=digest(blinded);
  const path=join(this.directory,`${syntheticLock}.json`);
  try{await reserve(this.directory,syntheticLock,{scope:'synthetic-lock-only',requestHash,state:'reserved'});}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   const prior=JSON.parse(await readFile(path,'utf8'));
   if(prior.requestHash!==requestHash)throw new Error('Fixture lock already used for a different blinded request');
   if(typeof prior.blindSignature!=='string')throw new Error('Issuance uncertain; do not issue a replacement');
   return new Uint8Array(Buffer.from(prior.blindSignature,'hex'));
  }
  const blindSignature=await suite.blindSign(this.keys.privateKey,blinded);
  const handle=await open(path,'r+');
  try{await handle.writeFile(JSON.stringify({scope:'synthetic-lock-only',requestHash,state:'signed',blindSignature:hex(blindSignature)}));await handle.sync();}
  finally{await handle.close();}
  return blindSignature;
 }
}

export async function signRedemption(token:Credential,request:ClientRequest,borrower:string,pool:string,challenge:string):Promise<Redemption>{
 return {borrower,pool,challenge,signature:new Uint8Array(await crypto.subtle.sign('Ed25519',request.possession.privateKey,authorizationBytes(token,borrower,pool,challenge)))};
}
export class FixtureCredentialRedeemer {
 constructor(private pinnedIssuerKey:CryptoKey,private pool:string,private expectedChallenge:string,private directory:string){
  if(pool.toLowerCase()!==FIXTURE_POOL)throw new Error('Wrong fixture deployment');
  fixed(expectedChallenge);
 }
 async redeem(token:Credential,redemption:Redemption){
  if(redemption.pool.toLowerCase()!==this.pool.toLowerCase()||redemption.challenge!==this.expectedChallenge)throw new Error('Wrong deployment or challenge');
  if(!await suite.verify(this.pinnedIssuerKey,token.signature,token.prepared))throw new Error('Invalid credential');
  // RFC 9474 Randomized Prepare prepends 32 bytes. Reject noncanonical payloads.
  const payload=token.prepared.subarray(32);
  if(payload.length!==prefix.length+64||!Buffer.from(payload.subarray(0,prefix.length)).equals(Buffer.from(prefix)))throw new Error('Wrong credential scope');
  const publicKey=await crypto.subtle.importKey('raw',new Uint8Array(payload.subarray(prefix.length+32)),{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',publicKey,new Uint8Array(redemption.signature),authorizationBytes(token,redemption.borrower,redemption.pool,redemption.challenge)))throw new Error('Possession/borrower binding failed');
  // Serial comes from nonce/message, NOT signature bytes, so signature variants cannot replay.
  const nullifier=digest(payload);
  try{await reserve(this.directory,nullifier,{scope:'synthetic-redemption-only',borrower:redemption.borrower.toLowerCase(),pool:this.pool.toLowerCase()});}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Credential already redeemed');throw error;}
  return {nullifier,borrower:redemption.borrower.toLowerCase()};
 }
}

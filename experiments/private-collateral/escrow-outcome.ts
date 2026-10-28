/** Deadline recovery for the isolated test. A pre-signed default pays the public minimum
 * into a per-loan escrow; this decides, once, who that escrow note may pay:
 *  - loan settled (repaid or zero-debt cancelled) → client, even after a missed release;
 *  - loan unsettled in a confirmed block past the settlement cutoff → lender.
 * The cosigner cannot see destinations, so it admits only a session with the entitled
 * partner, who built the transaction for its own funds. No signatures or broadcast here.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {mkdir,open,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Hex} from 'viem';
import type {CommonCeilingSettlementVerifier,CommonSettlementBinding} from './lock-settlement';
import type {LockEffects} from './lock-effects';

export type EscrowBinding={version:1;escrowKey:string;escrowNullifier:string;clientSigner:string;lenderSigner:string;settlement:Omit<CommonSettlementBinding,'settlementTx'>};
export type EscrowRequest={partner:'client'|'lender';settlementTx?:Hex;transaction:Uint8Array;authorization?:string};
type ReadEffects=(transaction:Uint8Array,custodyKey:string,nullifier:string)=>Promise<LockEffects>;
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bindingHash=(b:EscrowBinding)=>createHash('sha256').update(JSON.stringify(b)).digest('hex');
export const escrowAuthorizationMessage=(b:EscrowBinding,partner:EscrowRequest['partner'],digest:string)=>Buffer.from(JSON.stringify(['sicara:isolated-escrow-consent:v1',bindingHash(b),partner,digest]));
async function reserve(directory:string,name:string,value:unknown){
 await mkdir(directory,{recursive:true,mode:0o700});const file=await open(join(directory,name),'wx',0o600);
 try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
 const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
}
function validate(b:EscrowBinding){
 if(b.version!==1||!hex(b.escrowKey)||!hex(b.escrowNullifier)||Object.keys(b).sort().join(',')!=='clientSigner,escrowKey,escrowNullifier,lenderSigner,settlement,version'||b.clientSigner===b.lenderSigner)throw new Error('Invalid escrow binding');
 for(const key of [b.clientSigner,b.lenderSigner])if(createPublicKey(key).asymmetricKeyType!=='ed25519')throw new Error('Pinned Ed25519 participant key required');
}

export class IsolatedEscrowCoordinator {
 constructor(private directory:string,private settlement:CommonCeilingSettlementVerifier,private readEffects:ReadEffects){}
 /** Call only after certified DKG/default binding, BEFORE collateral funding or
  * eligibility. Keys identify authenticated participant sessions, not supplied
  * ad hoc by a requester. This module does not certify that initial setup.
  */
 async freeze(binding:EscrowBinding){
  validate(binding);
  await reserve(this.directory,`${binding.escrowKey}.key`,{bindingHash:bindingHash(binding)});
  await reserve(this.directory,`${binding.escrowNullifier}.lock`,binding);
 }
 async decide(binding:EscrowBinding,request:EscrowRequest){
  validate(binding);
  const pinned=JSON.parse(await readFile(join(this.directory,`${binding.escrowNullifier}.lock`),'utf8'));
  const key=JSON.parse(await readFile(join(this.directory,`${binding.escrowKey}.key`),'utf8'));
  if(bindingHash(pinned)!==bindingHash(binding)||key.bindingHash!==bindingHash(binding))throw new Error('Pinned escrow loan or participant changed');
  let verified;
  if(request.partner==='client'){
   if(!request.settlementTx)throw new Error('Settlement receipt required');
   verified=await this.settlement.verify({...binding.settlement,settlementTx:request.settlementTx});
  }else if(request.partner==='lender')verified=await this.settlement.verifyUnsettledAfterCutoff(binding.settlement);
  else throw new Error('Unknown partner');
  const e=await this.readEffects(request.transaction,binding.escrowKey,binding.escrowNullifier);
  if(e.plaintextPresent!==false||e.privateReturnPolicyVerified!==true||e.nullifier!==binding.escrowNullifier||e.lockTime!==0||e.expiryHeight!==0||e.shieldedOnly!==true||!hex(e.digest))throw new Error('Escrow spend policy not met');
  const signer=request.partner==='client'?binding.clientSigner:binding.lenderSigner;
  if(!request.authorization||!/^[a-f0-9]{128}$/.test(request.authorization)||!verify(null,escrowAuthorizationMessage(binding,request.partner,e.digest),signer,Buffer.from(request.authorization,'hex')))throw new Error('Entitled participant must authorize the exact transaction digest');
  // One decision per escrow note; a crash leaves it reserved for reconciliation.
  await reserve(this.directory,`${binding.escrowNullifier}.escrow`,{kind:verified.kind,partner:request.partner,digest:e.digest,binding:bindingHash(binding)});
  return {transactionDigest:e.digest,outcome:verified.kind,partner:request.partner,signingEnabled:false as const,broadcastEnabled:false as const};
 }
}

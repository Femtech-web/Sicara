/** Signing-service effect reader backed by the native lock kit. Input is a REDACTED PCZT;
 * the native side recomputes the digest itself and rejects any PCZT carrying plaintext.
 * No wallet, key share or network access. Spawned with an empty environment.
 */
import {spawn} from 'node:child_process';
import type {IsolatedLock,ReleaseEffects} from './isolated-release';

export type LockEffects={digest:string;nullifier:string|null;expiryHeight:number;lockTime:number;shieldedOnly:boolean;fee:number;actions:number;plaintextPresent:boolean;privateReturnPolicyVerified:boolean};
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

export function nativeLockEffects(binary:string){
 return (transaction:Uint8Array,custodyKey:string,nullifier:string)=>new Promise<LockEffects>((resolve,reject)=>{
  if(!hex(custodyKey)||!hex(nullifier)||transaction.length===0||transaction.length>1_900_000)return reject(new Error('Invalid effect request'));
  const child=spawn(binary,['--inspect-lock'],{env:{},stdio:['pipe','pipe','ignore'],timeout:60_000});
  let out='';
  child.stdout.setEncoding('utf8').on('data',d=>{out+=d;if(out.length>20_000)child.kill();});
  child.on('error',()=>reject(new Error('Effect reader unavailable')));
  child.on('close',code=>{
   try{
    if(code!==0)throw new Error('Effect reader rejected the transaction');
    const e=JSON.parse(out);
    if(!hex(e.digest)||(e.nullifier!==null&&!hex(e.nullifier))||![e.expiryHeight,e.lockTime,e.fee,e.actions].every(Number.isSafeInteger)||typeof e.shieldedOnly!=='boolean'||typeof e.plaintextPresent!=='boolean'||typeof e.privateReturnPolicyVerified!=='boolean')throw new Error('Malformed effects');
    resolve(e);
   }catch(error){reject(error);}
  });
  child.stdin.end(JSON.stringify({custodyKey,nullifier,pczt:Buffer.from(transaction).toString('hex')}));
 });
}
/** Adapter for IsolatedReleaseCoordinator: the release must spend the frozen note. */
export const releaseEffects=(binary:string)=>{
 const read=nativeLockEffects(binary);
 return async(transaction:Uint8Array,lock:IsolatedLock):Promise<ReleaseEffects>=>{
  const e=await read(transaction,lock.custodyKey,lock.nullifier);
  return {digest:e.digest,nullifier:e.nullifier??'',expiryHeight:e.expiryHeight,lockTime:e.lockTime,shieldedOnly:e.shieldedOnly,privateReturnPolicyVerified:e.privateReturnPolicyVerified&&!e.plaintextPresent};
 };
};

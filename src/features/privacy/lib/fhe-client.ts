/** Browser-only encryption/decryption. Never send clear amounts or viewing keys to app APIs. */
import type {Address,Hex,WalletClient} from 'viem';
import type {FhevmInstance} from '@zama-fhe/relayer-sdk/web';
let initialization:Promise<FhevmInstance>|undefined;
export function fheClient(){
 if(typeof window==='undefined')throw new Error('Private computation requires your browser.');
 initialization??=(async()=>{const sdk=await import('@zama-fhe/relayer-sdk/web');await sdk.initSDK({thread:0});return sdk.createInstance({...sdk.SepoliaConfig,network:'https://ethereum-sepolia-rpc.publicnode.com'});})().catch(error=>{initialization=undefined;throw error;});
 return initialization;
}
export async function encryptAmount(pool:Address,account:Address,amount:bigint){
 const sdk=await fheClient();const result=await sdk.createEncryptedInput(pool,account).add64(amount).encrypt();
 const hex=(value:Uint8Array)=>`0x${Array.from(value,b=>b.toString(16).padStart(2,'0')).join('')}` as Hex;
 return {handle:hex(result.handles[0]),proof:hex(result.inputProof)};
}
/** Ephemeral viewing key/signature remain in this function's memory, never localStorage/logs. */
async function decryptHandles(wallet:WalletClient,contract:Address,handles:Hex[]){
 const account=wallet.account;if(!account||wallet.chain?.id!==11155111)throw new Error('Connect the same wallet on Sepolia.');
 const sdk=await fheClient(),keys=sdk.generateKeypair();
 const start=Math.floor(Date.now()/1000)-30;const addresses=[contract];
 const data=sdk.createEIP712(keys.publicKey,addresses,start,1);
 const signature=await wallet.signTypedData({account,domain:{...data.domain,verifyingContract:data.domain.verifyingContract as Address},types:data.types,primaryType:data.primaryType,message:{...data.message,startTimestamp:BigInt(data.message.startTimestamp),durationDays:BigInt(data.message.durationDays)}});
 const result=await sdk.userDecrypt(handles.map(handle=>({handle,contractAddress:contract})),keys.privateKey,keys.publicKey,signature.replace(/^0x/,''),addresses,account.address,start,1);
 return result;
}
export async function decryptValues(wallet:WalletClient,contract:Address,handles:Hex[]):Promise<bigint[]>{
 const result=await decryptHandles(wallet,contract,handles);
 return handles.map(h=>{const value=result[h];if(typeof value!=='bigint'&&typeof value!=='number')throw new Error('Private amount is not ready. Refresh and retry viewing.');return BigInt(value);});
}

export async function decryptLoanState(wallet:WalletClient,contract:Address,debt:Hex,borrowed:Hex){
 const result=await decryptHandles(wallet,contract,[debt,borrowed]);
 const amount=result[debt],drawn=result[borrowed];
 if((typeof amount!=='bigint'&&typeof amount!=='number')||typeof drawn!=='boolean')throw new Error('Private loan state is not ready.');
 return {debt:BigInt(amount),borrowed:drawn};
}
export async function settlementProof(handle:Hex){
 const result=await(await fheClient()).publicDecrypt([handle]);
 if(result.clearValues[handle]!==true||!/^0x[a-f0-9]+$/i.test(result.decryptionProof))throw new Error('Zero debt is not verified yet. Repay first, then request a fresh outcome.');
 return result.decryptionProof as Hex;
}

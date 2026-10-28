"use client";
import {useRef,useState} from 'react';
import {useConfig,useConnection,usePublicClient,useReadContracts,useWriteContract} from 'wagmi';
import {getConnection} from 'wagmi/actions';
import {BaseError,UserRejectedRequestError,toHex,type Hex} from 'viem';
import {useQueryClient} from '@tanstack/react-query';
import {useWalletDialog} from '@/features/wallet/hooks/use-wallet-dialog';
import {AssetSelector} from '@/features/lending/components/asset-selector';
import {assets,type BorrowAssetId} from '@/features/lending/model/assets';
import {formatTokenAmount} from '@/features/lending/model/quote';
import {focusRing,primaryButton} from '@/components/ui/control-styles';
import {encryptAmount} from '@/features/privacy/lib/fhe-client';
import {markets,marketAbi,confidentialTokenAbi} from '../config/market';
import {tokenUnits} from '../model/amount';

type Intent={offerId:Hex;state:'prepared'|'submitting'|'confirmed';hash?:Hex};
export function LendForm(){
 const [assetId,setAssetId]=useState<BorrowAssetId>('cusdc'),[input,setInput]=useState(''),[stage,setStage]=useState(''),[error,setError]=useState(''),[hash,setHash]=useState<Hex>();
 const {address,chainId,isConnected}=useConnection();const config=useConfig(),openWallet=useWalletDialog(),client=usePublicClient({chainId:11155111}),write=useWriteContract(),cache=useQueryClient();
 const asset=assets[assetId],market=markets[assetId],pool=market.pool;
 const terms=useReadContracts({contracts:pool?[{address:pool,abi:marketAbi,functionName:'commonCeiling'},{address:pool,abi:marketAbi,functionName:'interestBps'},{address:pool,abi:marketAbi,functionName:'repaymentCutoff'}]:[],allowFailure:false,chainId:11155111,query:{enabled:!!pool,refetchInterval:60_000}});
 const ceiling=terms.data?.[0],bps=terms.data?.[1],cutoff=terms.data?.[2];
 const [busy,setBusy]=useState(false);const inFlight=useRef(false);
 async function submit(){
  if(inFlight.current)return;setError('');if(!address||chainId!==11155111){openWallet();return;}
  if(!pool||!client||ceiling===undefined||cutoff===undefined){setError('This lending market is not available yet.');return;}
  const account=address;const check=()=>{const current=getConnection(config);if(current.address?.toLowerCase()!==account.toLowerCase()||current.chainId!==11155111)throw new Error('Your wallet changed. Start again with the connected account.');};
  const key=`sicara:supply:${pool}:${account.toLowerCase()}`;
  let intent:Intent|undefined;inFlight.current=true;setBusy(true);setStage('Preparing supply…');
  try{
   if(!navigator.locks)throw new Error('Use a browser supporting Web Locks for once-only supply.');
   await navigator.locks.request(key,{ifAvailable:true},async lock=>{
   if(!lock)throw new Error('A supply request is open in another tab.');
   const amount=tokenUnits(input,asset.decimals);if(amount>ceiling)throw new Error(`Each offer can supply up to ${formatTokenAmount(ceiling,asset.decimals)} ${asset.symbol}.`);
   const now=(await client.getBlock()).timestamp;if(now>=cutoff)throw new Error('This test market is closed to new supply. Existing unmatched funds remain withdrawable.');check();
   const stored=localStorage.getItem(key);intent=stored?JSON.parse(stored) as Intent:{offerId:toHex(crypto.getRandomValues(new Uint8Array(32))),state:'prepared'};
   if(!/^0x[a-f0-9]{64}$/i.test(intent.offerId)||!['prepared','submitting','confirmed'].includes(intent.state))throw new Error('Saved request needs reconciliation.');
   if(intent.state==='submitting'){
    const existing=await client.readContract({address:pool,abi:marketAbi,functionName:'positionState',args:[intent.offerId]});check();
    if(existing[0].toLowerCase()===account.toLowerCase()){intent.state='confirmed';localStorage.setItem(key,JSON.stringify(intent));setStage('Offer confirmed. View its private balance in Positions.');await cache.invalidateQueries({queryKey:['supplied-positions']});return;}
    if(intent.hash){const receipt=await client.getTransactionReceipt({hash:intent.hash});if(receipt?.status==='reverted'){intent.state='prepared';localStorage.setItem(key,JSON.stringify(intent));}else throw new Error('A previous supply is pending. Check its transaction before trying again.');}
    else throw new Error('A previous wallet submission has an unknown outcome. Reconcile its offer before another send.');
   }
   if(intent.state==='confirmed'){setStage('Your last offer is in Positions. Choose “Create another offer” to begin a separate supply.');return;}
   localStorage.setItem(key,JSON.stringify(intent)); // Public IDs only, never amounts or proof/key material.
   const allowed=await client.readContract({address:market.token,abi:confidentialTokenAbi,functionName:'isOperator',args:[account,pool]});check();
   if(!allowed){setStage('Check your wallet…');const approval=await write.writeContractAsync({account,address:market.token,abi:confidentialTokenAbi,functionName:'setOperator',args:[pool,Number(now)+1800],chainId:11155111});setHash(approval);setStage('Confirming permission…');if((await client.waitForTransactionReceipt({hash:approval})).status!=='success')throw new Error('Token permission was not confirmed.');check();}
   setStage('Encrypting privately…');const encrypted=await encryptAmount(pool,account,amount);check();setStage('Check your wallet…');
   intent.state='submitting';localStorage.setItem(key,JSON.stringify(intent));
   let sent:Hex;
   try{sent=await write.writeContractAsync({account,address:pool,abi:marketAbi,functionName:'supply',args:[intent.offerId,encrypted.handle,encrypted.proof],chainId:11155111});}
   catch(error){
    // Only an explicit wallet rejection proves no transaction was submitted.
    // Timeouts and ambiguous RPC errors keep the intent frozen for reconciliation.
    if(error instanceof BaseError&&error.walk(cause=>cause instanceof UserRejectedRequestError) instanceof UserRejectedRequestError){intent.state='prepared';localStorage.setItem(key,JSON.stringify(intent));}
    throw error;
   }
   intent.hash=sent;localStorage.setItem(key,JSON.stringify(intent));setHash(sent);setStage('Confirming supply…');
   const receipt=await client.waitForTransactionReceipt({hash:sent});check();
   if(receipt.status!=='success'){intent.state='prepared';localStorage.setItem(key,JSON.stringify(intent));throw new Error('Supply transaction reverted. No supply was completed.');}
   intent.state='confirmed';localStorage.setItem(key,JSON.stringify(intent));setStage('Offer created. Open Positions and authorize private viewing to verify the tokens actually received.');await cache.invalidateQueries({queryKey:['supplied-positions']});
   });
  }catch(e){setStage('');setError(e instanceof Error&&e.message.length<220?e.message:'Supply was not verified. Check any submitted transaction before another request.');}
  finally{inFlight.current=false;setBusy(false);}
 }
 return <form noValidate onSubmit={e=>{e.preventDefault();void submit();}} className="space-y-3">
  <fieldset disabled={busy} className="rounded-[20px] border border-white/5 bg-[#121318] p-4">
   <label htmlFor="lend-amount" className="text-sm font-semibold text-[#bdc6d9]">You supply</label>
   <div className="mt-3 flex items-center gap-3"><input id="lend-amount" inputMode="decimal" autoComplete="off" maxLength={22} value={input} onChange={e=>setInput(e.target.value)} placeholder="0.00" className="min-w-0 w-full bg-transparent py-2 text-[36px] tracking-tight text-[#edf0f5] caret-[#99aaff] outline-none placeholder:text-[#666c7c]"/><AssetSelector asset={asset} role="lend" onSelect={a=>{if(a.id==='cusdc'||a.id==='demo-zama'){setAssetId(a.id);setInput('');setStage('');setError('');setHash(undefined);}}}/></div>
   <p className="mt-2 text-[11px] text-[#939db5]">Confidential test tokens · Sepolia</p>
  </fieldset>
  <dl className="space-y-2 px-2 py-2 text-xs"><div className="flex justify-between gap-4"><dt className="text-[#929db5]">Maximum per offer</dt><dd>{ceiling!==undefined?`${formatTokenAmount(ceiling,asset.decimals)} ${asset.symbol}`:'Not available yet'}</dd></div><div className="flex justify-between gap-4"><dt className="text-[#929db5]">Loan interest</dt><dd>{bps!==undefined?`${Number(bps)/100}% flat per completed loan`:'Market terms pending'}</dd></div></dl>
  <p className="px-2 text-xs leading-relaxed text-[#949eb5]">Each offer funds one loan. Interest is earned only on actual repayments; it is not an APY or a guaranteed return. Unmatched supply is withdrawable. Matched funds stay locked until verified settlement or default resolution.</p>
  <button type="submit" disabled={busy||isConnected&&chainId===11155111&&(!pool||terms.isPending||terms.isError)} className={primaryButton}>{!isConnected?'Connect wallet':chainId!==11155111?'Switch to Sepolia':busy?stage:!pool?'Market not available yet':'Supply confidential tokens'}</button>
  {stage&&!busy&&<p role="status" className="px-2 text-xs leading-relaxed text-[#b5c4f0]">{stage}</p>}
  {['Your last offer','Offer created.','Offer confirmed.'].some(text=>stage.startsWith(text))&&<button type="button" className={`min-h-10 rounded-full px-3 text-xs text-[#bac7f4] ${focusRing}`} onClick={()=>{if(address&&pool){localStorage.removeItem(`sicara:supply:${pool}:${address.toLowerCase()}`);setStage('');setHash(undefined);}}}>Create another offer</button>}
  {error&&<p role="alert" className="break-words px-2 text-xs leading-relaxed text-amber-200">{error}</p>}
  {terms.isError&&<p role="alert" className="px-2 text-xs text-amber-200">Could not load verified market terms. Refresh before supplying.</p>}
  {hash&&<a href={`https://sepolia.etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer" className={`inline-flex min-h-9 items-center rounded-lg px-2 text-xs text-[#b7c5f5] ${focusRing}`}>View transaction ↗</a>}
  <p className="px-2 pb-1 text-center text-[10px] leading-relaxed text-[#858fa5]">Valueless test assets only. cUSDC is not Circle-issued or redeemable USDC. Shielded borrower deposits are not enabled yet.</p>
 </form>;
}

"use client";
import {useRef,useState} from 'react';
import {useConfig,useConnection,usePublicClient,useReadContract,useWalletClient,useWriteContract} from 'wagmi';
import {getConnection} from 'wagmi/actions';
import {BaseError,UserRejectedRequestError,zeroHash,type Address,type Hex} from 'viem';
import {markets,marketAbi,confidentialTokenAbi} from '@/features/liquidity/config/market';
import {tokenUnits} from '@/features/liquidity/model/amount';
import {decryptLoanState,encryptAmount,settlementProof} from '@/features/privacy/lib/fhe-client';
import {focusRing,primaryButton} from '@/components/ui/control-styles';
import {formatTokenAmount} from '../model/quote';

type Intent={action:string;hash?:Hex};
/** Only manages a loan already registered by verified collateral admission.
 * It cannot allocate a deposit, attest collateral or authorize a Zcash release.
 */
export function RegisteredLoan(){
 const {address,chainId}=useConnection(),config=useConfig(),client=usePublicClient({chainId:11155111}),wallet=useWalletClient(),write=useWriteContract();
 const market=markets.cusdc,pool=market.pool!;
 const id=useReadContract({address:pool,abi:marketAbi,functionName:'loanByBorrower',args:[address??'0x0000000000000000000000000000000000000000'],chainId:11155111,query:{enabled:!!address&&chainId===11155111,refetchInterval:15_000}});
 const loanId=id.data,exists=!!loanId&&loanId!==zeroHash;
 const loan=useReadContract({address:pool,abi:marketAbi,functionName:'loanState',args:[loanId??zeroHash],chainId:11155111,query:{enabled:exists,refetchInterval:15_000}});
 const maximum=useReadContract({address:pool,abi:marketAbi,functionName:'maximumPrincipal',chainId:11155111,query:{enabled:exists}});
 const [view,setView]=useState<{owner:string;id:Hex;debt:bigint;borrowed:boolean;debtHandle:Hex;borrowedHandle:Hex}>(),[input,setInput]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[hash,setHash]=useState<Hex>();
 const running=useRef(false),own=!!address&&loan.data?.[0].toLowerCase()===address.toLowerCase();
 const visible=view&&view.owner===address?.toLowerCase()&&view.id===loanId&&view.debtHandle===loan.data?.[2]&&view.borrowedHandle===loan.data?.[3]?view:undefined;
 function check(owner:Address){const current=getConnection(config);if(current.address?.toLowerCase()!==owner.toLowerCase()||current.chainId!==11155111)throw new Error('Wallet changed. Reopen this loan with its borrower.');}
 async function privately(){if(!address||!wallet.data||!loan.data||!loanId||!own||running.current)return;const owner=address;running.current=true;setBusy('Authorize private viewing…');setError('');try{const current=await loan.refetch();if(!current.data)throw new Error('Loan state unavailable.');check(owner);const values=await decryptLoanState(wallet.data,pool,current.data[2],current.data[3]);check(owner);setView({owner:owner.toLowerCase(),id:loanId,debtHandle:current.data[2],borrowedHandle:current.data[3],...values});}catch{setError('Private loan viewing did not complete. Check your wallet and retry when the encrypted state is ready.');}finally{running.current=false;setBusy('');}}
 async function action(kind:'borrow'|'repay'|'request'|'finalize'){
  if(!address||!client||!loanId||!own||running.current)return;const owner=address,id=loanId,key=`sicara:loan-action:${pool}:${owner.toLowerCase()}:${id}`;
  running.current=true;setBusy('Checking loan…');setError('');
  try{
   if(!navigator.locks)throw new Error('This action requires a browser with Web Locks.');
   await navigator.locks.request(key,{ifAvailable:true},async lock=>{
    if(!lock)throw new Error('This loan has an action open in another tab.');check(owner);
    const pending=localStorage.getItem(key);
    if(pending){const saved=JSON.parse(pending) as Intent;if(!saved.hash)throw new Error('A wallet submission has an unknown outcome. Reconcile it before another action.');const r=await client.getTransactionReceipt({hash:saved.hash});if(!r||await client.getBlockNumber()<r.blockNumber+11n)throw new Error('The previous transaction still needs confirmations.');if((await client.getBlock({blockNumber:r.blockNumber})).hash!==r.blockHash)throw new Error('Previous transaction changed chain; reconcile first.');localStorage.removeItem(key);await loan.refetch();setView(undefined);throw new Error('Previous transaction reconciled. View the refreshed loan before choosing another action.');}
    async function send(action:string,build:()=>Promise<Hex>){
     check(owner);localStorage.setItem(key,JSON.stringify({action} satisfies Intent));let sent:Hex;
     try{sent=await build();}catch(e){if(e instanceof BaseError&&e.walk(c=>c instanceof UserRejectedRequestError) instanceof UserRejectedRequestError)localStorage.removeItem(key);throw e;}
     localStorage.setItem(key,JSON.stringify({action,hash:sent} satisfies Intent));setHash(sent);setBusy('Waiting for 12 confirmations…');const r=await client!.waitForTransactionReceipt({hash:sent,confirmations:12});check(owner);if((await client!.getBlock({blockNumber:r.blockNumber})).hash!==r.blockHash)throw new Error('Transaction reorganized; reconcile before retrying.');localStorage.removeItem(key);if(r.status!=='success')throw new Error('Transaction reverted. No completed action was verified.');
    }
    const current=await client.readContract({address:pool,abi:marketAbi,functionName:'loanState',args:[id]});check(owner);if(current[0].toLowerCase()!==owner.toLowerCase()||current[6])throw new Error('Loan is unavailable or already settled.');
    if(kind==='borrow'||kind==='repay'){
     if(!visible||visible.debtHandle!==current[2]||visible.borrowedHandle!==current[3])throw new Error('View the current private loan state first.');
     const amount=kind==='borrow'?tokenUnits(input,6):visible.debt;
     if(amount<=0n||kind==='borrow'&&(visible.borrowed||maximum.data===undefined||amount>maximum.data))throw new Error('Choose a positive principal within the approved limit. A loan can draw only once.');
     if(kind==='repay'){
      const allowed=await client.readContract({address:market.token,abi:confidentialTokenAbi,functionName:'isOperator',args:[owner,pool]});check(owner);
      if(!allowed){const now=Number((await client.getBlock()).timestamp);setBusy('Approve temporary token permission…');await send('repayment-permission',()=>write.writeContractAsync({account:owner,address:market.token,abi:confidentialTokenAbi,functionName:'setOperator',args:[pool,now+1800],chainId:11155111}));}
     }
     setBusy('Encrypting in your browser…');const encrypted=await encryptAmount(pool,owner,amount);check(owner);setBusy('Check your wallet…');
     await send(kind,()=>write.writeContractAsync({account:owner,address:pool,abi:marketAbi,functionName:kind,args:[id,encrypted.handle,encrypted.proof],chainId:11155111}));
    }else if(kind==='request'){
     if(!visible||visible.debt!==0n)throw new Error('Verify zero debt privately before requesting closure.');
     setBusy('Confirm loan closure request…');await send('request-settlement',()=>write.writeContractAsync({account:owner,address:pool,abi:marketAbi,functionName:'requestSettlement',args:[id],chainId:11155111}));
    }else{
     if(current[5]===zeroHash)throw new Error('Request a repayment outcome first.');setBusy('Verifying the repayment outcome…');const proof=await settlementProof(current[5]);check(owner);
     await send('finalize-settlement',()=>write.writeContractAsync({account:owner,address:pool,abi:marketAbi,functionName:'finalizeSettlement',args:[id,true,proof],chainId:11155111}));
    }
    setView(undefined);await loan.refetch();
   });
  }catch(e){setError(e instanceof Error&&e.message.length<240?e.message:'Action not verified. Check any submitted transaction before another request.');}
  finally{running.current=false;setBusy('');}
 }
 if(!address||chainId!==11155111)return null;
 if(id.isError||exists&&loan.isError)return <p role="alert" className="rounded-2xl bg-white/5 p-4 text-xs text-amber-200">Could not load your on-chain loan. Refresh before transacting.</p>;
 if(id.isPending||exists&&loan.isPending)return <p role="status" className="p-4 text-xs text-[#9aa7c2]">Checking your approved loan…</p>;
 if(!exists)return <p className="rounded-2xl border border-white/8 p-4 text-xs leading-relaxed text-[#9aa7c2]">No approved cUSDC loan for this wallet. Public ZEC deposits remain unavailable; a wallet connection alone does not authorize borrowing.</p>;
 return <article className="rounded-[20px] border border-white/8 bg-[#121318] p-4">
  <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold">Your cUSDC loan</h2><span className="text-[11px] text-[#a8b7d5]">{loan.data?.[6]?'Repayment verified':'Collateral authorization registered'}</span></div>
  <p className="mt-3 break-all font-mono text-[10px] text-[#929db5]">{loanId}</p>
  <dl className="mt-4 flex justify-between text-xs"><dt className="text-[#9da9c0]">Outstanding principal + interest</dt><dd>{visible?`${formatTokenAmount(visible.debt,6)} cUSDC`:'Encrypted'}</dd></dl>
  <button onClick={()=>void privately()} disabled={!!busy||!own||!wallet.data} className={`mt-3 min-h-10 rounded-full border border-white/10 px-4 text-xs font-bold disabled:opacity-40 ${focusRing}`}>View privately</button>
  {!loan.data?.[6]&&<div className="mt-3 space-y-3">
   {visible&&!visible.borrowed&&<div><label htmlFor="approved-loan-amount" className="text-xs text-[#aab6cd]">Principal to borrow · max {maximum.data!==undefined?formatTokenAmount(maximum.data,6):'…'} cUSDC</label><input id="approved-loan-amount" inputMode="decimal" value={input} onChange={e=>setInput(e.target.value)} maxLength={22} placeholder="0.00" className="mt-2 w-full rounded-xl border border-white/10 bg-white/3 px-3 py-2 text-xl outline-none"/><button onClick={()=>void action('borrow')} disabled={!!busy} className={`${primaryButton} mt-3`}>Borrow confidential cUSDC</button></div>}
   {visible&&visible.debt>0n&&<button onClick={()=>void action('repay')} disabled={!!busy} className={primaryButton}>Repay full private balance</button>}
   {visible&&visible.debt===0n&&loan.data?.[5]===zeroHash&&<div><p className="mb-2 text-[11px] leading-relaxed text-[#97a5be]">Closing the loan permanently stops further borrowing, including an undrawn loan.</p><button onClick={()=>void action('request')} disabled={!!busy} className={primaryButton}>Request loan closure</button></div>}
   {loan.data?.[5]&&loan.data[5]!==zeroHash&&<button onClick={()=>void action('finalize')} disabled={!!busy} className={primaryButton}>Verify repayment outcome</button>}
  </div>}
  <p className="mt-4 text-[11px] leading-relaxed text-[#97a5be]">{loan.data?.[6]?'Sepolia repayment is verified. The Zcash signing service must separately authorize and confirm your shielded return; this status does not prove ZEC was returned.':'Amounts decrypt in your browser after wallet authorization. Public deposit intake is still gated.'}</p>
  {busy&&<p role="status" className="mt-3 text-xs text-[#bac8f0]">{busy}</p>}{error&&<p role="alert" className="mt-3 text-xs leading-relaxed text-amber-200">{error}</p>}
  {hash&&<a href={`https://sepolia.etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer" className={`mt-2 inline-flex min-h-10 items-center text-xs text-[#becbf4] ${focusRing}`}>View transaction ↗</a>}
 </article>;
}

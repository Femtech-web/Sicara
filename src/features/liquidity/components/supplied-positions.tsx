"use client";
import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useConnection,useConfig,usePublicClient,useReadContract,useWalletClient,useWriteContract} from 'wagmi';
import {getConnection} from 'wagmi/actions';
import {zeroHash,parseAbiItem,type Address,type Hex} from 'viem';
import {assets,type BorrowAssetId} from '@/features/lending/model/assets';
import {TokenIcon} from '@/features/lending/components/token-icon';
import {formatTokenAmount} from '@/features/lending/model/quote';
import {useWalletDialog} from '@/features/wallet/hooks/use-wallet-dialog';
import {focusRing,primaryButton} from '@/components/ui/control-styles';
import {decryptValues} from '@/features/privacy/lib/fhe-client';
import {markets,marketAbi} from '../config/market';

function SuppliedPosition({offerId,assetId}:{offerId:Hex;assetId:BorrowAssetId}){
 const {address,chainId}=useConnection(),config=useConfig(),client=usePublicClient({chainId:11155111}),wallet=useWalletClient(),write=useWriteContract(),cache=useQueryClient();
 const [privateView,setPrivateView]=useState<{owner:string;available:bigint;earned:bigint}>(),[busy,setBusy]=useState(''),[error,setError]=useState(''),[tx,setTx]=useState<Hex>();
 const pool=markets[assetId].pool,asset=assets[assetId];
 const position=useReadContract({address:pool,abi:marketAbi,functionName:'positionState',args:[offerId],chainId:11155111,query:{enabled:!!pool&&!!address&&chainId===11155111,refetchInterval:30_000}});
 const loanId=position.data?.[1],matched=!!loanId&&loanId!==zeroHash;
 const loan=useReadContract({address:pool,abi:marketAbi,functionName:'loanState',args:[loanId??zeroHash],chainId:11155111,query:{enabled:!!pool&&matched,refetchInterval:30_000}});
 const resolution=useReadContract({address:pool,abi:marketAbi,functionName:'resolution',args:[loanId??zeroHash],chainId:11155111,query:{enabled:!!pool&&matched,refetchInterval:30_000}});
 const own=!!address&&position.data?.[0].toLowerCase()===address.toLowerCase();
 const unlocked=!matched||loan.data?.[6]===true||resolution.data!==undefined&&resolution.data!==0;
 const visible=privateView?.owner===address?.toLowerCase()?privateView:undefined;
 const check=(owner:Address)=>{const current=getConnection(config);if(current.address?.toLowerCase()!==owner.toLowerCase()||current.chainId!==11155111)throw new Error('Wallet changed. Open this position with its owner.');};
 async function view(){if(!pool||!address||!own||!wallet.data||!position.data)return;const account=address;setError('');setBusy('Authorize private viewing…');try{check(account);const values=await decryptValues(wallet.data,pool,[position.data[2],position.data[3]]);check(account);setPrivateView({owner:account.toLowerCase(),available:values[0],earned:values[1]});}catch{setError('Private viewing was not completed. Check the wallet request and try again when the encrypted state is ready.');}finally{setBusy('');}}
 async function withdraw(){if(!pool||!address||!own||!client||!unlocked)return;const account=address;setError('');setBusy('Preparing withdrawal…');try{check(account);setBusy('Confirm withdrawal in your wallet…');const hash=await write.writeContractAsync({account,address:pool,abi:marketAbi,functionName:'withdrawAll',args:[offerId],chainId:11155111});setTx(hash);setBusy('Confirming withdrawal…');const receipt=await client.waitForTransactionReceipt({hash});check(account);if(receipt.status!=='success')throw new Error('Withdrawal reverted.');setPrivateView(undefined);await position.refetch();await cache.invalidateQueries({queryKey:['supplied-positions']});}catch{setError('Withdrawal not verified. Check any submitted transaction before another request. A repeated full withdrawal cannot take another position’s funds.');}finally{setBusy('');}}
 return <article className="rounded-[20px] border border-white/8 bg-[#121318] p-4">
  <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><TokenIcon asset={assetId} compact/><h3 className="text-sm font-bold">{asset.symbol} supply</h3></div><span className="text-[11px] text-[#a7b2ca]">{matched?unlocked?'Resolved':'Matched · locked':'Unmatched'}</span></div>
  <p className="mt-3 font-mono text-[10px] text-[#8995b0]">{offerId.slice(0,12)}…{offerId.slice(-6)}</p>
  <dl className="mt-3 space-y-2 text-xs"><div className="flex justify-between"><dt className="text-[#939fb8]">Position balance</dt><dd>{visible?formatTokenAmount(visible.available,asset.decimals):'Encrypted'}</dd></div><div className="flex justify-between"><dt className="text-[#939fb8]">Interest received</dt><dd>{visible?formatTokenAmount(visible.earned,asset.decimals):'Encrypted'}</dd></div></dl>
  <div className="mt-3 flex flex-wrap gap-2"><button disabled={!!busy||!own||!wallet.data} onClick={()=>void view()} className={`min-h-10 rounded-full border border-white/10 px-3 text-xs font-bold text-[#c1cdf5] disabled:opacity-40 ${focusRing}`}>View privately</button><button disabled={!!busy||!own||!unlocked||position.isError} onClick={()=>void withdraw()} className={`min-h-10 rounded-full bg-[#e7eaff] px-3 text-xs font-bold text-[#181c33] disabled:bg-white/5 disabled:text-[#7c879e] ${focusRing}`}>Withdraw available</button></div>
  {matched&&!unlocked&&<p className="mt-3 text-[11px] leading-relaxed text-[#94a1bd]">Awaiting verified loan settlement or default resolution. There is no guaranteed return.</p>}
  {busy&&<p role="status" className="mt-3 text-xs text-[#b5c3e9]">{busy}</p>}{error&&<p role="alert" className="mt-3 text-xs leading-relaxed text-amber-200">{error}</p>}{position.isError&&<p role="alert" className="mt-3 text-xs text-amber-200">Position state unavailable. Refresh before transacting.</p>}
  {tx&&<a href={`https://sepolia.etherscan.io/tx/${tx}`} target="_blank" rel="noreferrer" className={`mt-2 inline-flex min-h-9 items-center rounded-lg text-xs text-[#becbf4] ${focusRing}`}>View withdrawal ↗</a>}
 </article>;
}
export function SuppliedPositions(){
 const {address,chainId,isConnected}=useConnection();const client=usePublicClient({chainId:11155111}),openWallet=useWalletDialog();
 const positions=useQuery({queryKey:['supplied-positions',address?.toLowerCase(),chainId],enabled:!!address&&chainId===11155111,refetchInterval:30_000,queryFn:async()=>{
  if(!client||!address)return [];const current=await client.getBlockNumber();const owned:{offerId:Hex;assetId:BorrowAssetId}[]=[];
  for(const assetId of ['cusdc','demo-zama'] as const){const market=markets[assetId];if(!market.pool||market.fromBlock<=0n)continue;
   if(current-market.fromBlock>100_000n)throw new Error('Position history needs a longer-range indexer. Do not assume there are no positions.');
   for(let from=market.fromBlock;from<=current;from+=2_000n){const to=from+1_999n<current?from+1_999n:current;const logs=await client.getLogs({address:market.pool,event:parseAbiItem('event Supplied(bytes32 indexed offerId,address indexed lender)'),args:{lender:address},fromBlock:from,toBlock:to});for(const log of logs)if(log.args.offerId)owned.push({offerId:log.args.offerId,assetId});}
  }return owned.reverse();
 },retry:false});
 if(!isConnected||chainId!==11155111)return <div className="rounded-2xl bg-[#121318] p-5 text-center"><p className="mb-4 text-sm text-[#a3aec6]">Your Sepolia wallet owns your lending positions.</p><button onClick={openWallet} className={primaryButton}>{isConnected?'Switch to Sepolia':'Connect wallet'}</button></div>;
 return <div className="space-y-3"><p className="px-1 text-xs leading-relaxed text-[#9aa7c2]">Balances and earnings decrypt only after your wallet authorizes private viewing. The app backend does not receive those numbers.</p>{positions.isPending?<p role="status" className="p-4 text-center text-sm text-[#97a4c2]">Finding your positions…</p>:positions.isError?<div role="alert" className="rounded-2xl bg-white/5 p-4 text-sm text-amber-200">Could not load your complete position history. <button className={`rounded px-2 underline ${focusRing}`} onClick={()=>void positions.refetch()}>Retry</button></div>:positions.data?.length?positions.data.map(p=><SuppliedPosition key={`${p.assetId}:${p.offerId}`} {...p}/>):<div className="rounded-2xl border border-dashed border-white/10 p-8 text-center"><h3 className="font-bold">No lending positions yet</h3><p className="mt-2 text-xs leading-relaxed text-[#96a3bf]">Create an offer in Lend. Confirm its private balance before treating it as funded.</p></div>}</div>;
}

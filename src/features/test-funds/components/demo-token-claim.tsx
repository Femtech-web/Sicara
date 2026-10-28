"use client";
import {useEffect,useState} from 'react';
import {useConnection,useReadContract,useWaitForTransactionReceipt,useWriteContract} from 'wagmi';
import {sepolia} from 'wagmi/chains';
import {useWalletDialog} from '@/features/wallet/hooks/use-wallet-dialog';
import {focusRing} from '@/components/ui/control-styles';
import {ExternalLink} from '@/components/ui/icons';
import {faucetAddresses,faucetAbi} from '../config/faucet';

export function DemoTokenClaim({assetId="demo-zama"}:{assetId?:"demo-zama"|"cusdc"}){
  const demoTokenFaucetAddress=faucetAddresses[assetId];
  const symbol=assetId==="cusdc"?"cUSDC":"Demo ZAMA";
  const {address,chainId,isConnected}=useConnection();const openWallet=useWalletDialog();
  const [submittedFor,setSubmittedFor]=useState<string>();
  const [now,setNow]=useState(()=>Math.floor(Date.now()/1000));
  useEffect(()=>{const timer=setInterval(()=>setNow(Math.floor(Date.now()/1000)),30_000);return()=>clearInterval(timer);},[]);
  const request=useWriteContract();const receipt=useWaitForTransactionReceipt({hash:request.data,chainId:sepolia.id});
  const cooldown=useReadContract({address:demoTokenFaucetAddress,abi:faucetAbi,functionName:'nextClaimAt',args:[address??'0x0000000000000000000000000000000000000000'],chainId:sepolia.id,query:{enabled:Boolean(demoTokenFaucetAddress&&address&&chainId===sepolia.id)}});
  const {refetch}=cooldown;
  useEffect(()=>{if(receipt.isSuccess)void refetch();},[receipt.isSuccess,refetch]);
  const waiting=request.isPending||receipt.isLoading;
  const cooldownActive=cooldown.data!==undefined&&cooldown.data>BigInt(now);
  async function claim(){
    if(!isConnected||!address||chainId!==sepolia.id){openWallet();return;}
    if(!demoTokenFaucetAddress)return;
    setSubmittedFor(address);request.reset();
    try{await request.writeContractAsync({account:address,address:demoTokenFaucetAddress,abi:faucetAbi,functionName:'claim',chainId:sepolia.id});}catch{/* wallet/client feedback below; no automatic retry */}
  }
  const ownRequest=submittedFor===address;
  return <div className="rounded-2xl border border-[#8798ff]/15 bg-[#8798ff]/[0.06] p-4">
    <p className="text-sm font-bold">Sicara · {symbol}</p>
    <p className="mt-2 text-xs leading-relaxed text-[#a5aabd]">Our valueless confidential test token. {assetId==="cusdc"&&"Not Circle-issued or redeemable USDC."} Request 10 tokens per wallet every 24 hours. Sepolia ETH pays gas; no collateral is needed.</p>
    <button type="button" onClick={()=>void claim()} disabled={!demoTokenFaucetAddress||waiting||isConnected&&chainId===sepolia.id&&cooldownActive} className={`mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-[#e7eaff] px-4 text-xs font-bold text-[#181c33] disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-[#8e95a9] ${focusRing}`}>
      {!demoTokenFaucetAddress?'Test-token faucet coming soon':waiting?'Confirming request…':!isConnected?'Connect to request tokens':chainId!==sepolia.id?'Switch to Sepolia':cooldownActive?'Available again after cooldown':`Request 10 ${symbol}`}
    </button>
    <div aria-live="polite" className="mt-2 text-[11px] leading-relaxed text-[#a5aabd]">
      {ownRequest&&(request.error||receipt.error||receipt.data?.status==='reverted')&&<p className="text-amber-200">Request not completed. Check Sepolia gas, cooldown and faucet availability. A submitted transaction should be checked before retrying.</p>}
      {ownRequest&&receipt.data?.status==='success'&&<p>Request confirmed. The transfer amount is confidential; receipt inclusion alone does not prove a funded transfer.</p>}
      {ownRequest&&request.data&&<a className={`mt-1 inline-flex min-h-8 items-center gap-1 rounded-md font-semibold text-[#becaff] ${focusRing}`} href={`https://sepolia.etherscan.io/tx/${request.data}`} target="_blank" rel="noopener noreferrer">View request<ExternalLink size={12}/></a>}
    </div>
    <p className="mt-2 text-[10px] leading-relaxed text-[#969db2]">Shared daily request limit: 1,000 tokens. If depleted, a request can transfer zero and still start your cooldown. Test tokens have no redemption value.</p>
  </div>;
}

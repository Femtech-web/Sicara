"use client";
import {useMemo,useState} from 'react';
import QRCode from 'qrcode';
import {Copy,ExternalLink} from '@/components/ui/icons';
import {focusRing} from '@/components/ui/control-styles';
import {shieldedPaymentUri} from '../model/payment';
/** Local ZIP321 QR, following Silicr's documented wallet funding pattern.
 * No third-party QR service receives the destination or payment amount. */
export function ShieldedPayment({address,zatoshis}:{address:string;zatoshis?:bigint}){
 const [notice,setNotice]=useState('');const uri=shieldedPaymentUri(address,zatoshis);
 const qr=useMemo(()=>{const q=QRCode.create(uri,{errorCorrectionLevel:'M'});let d='';for(let y=0;y<q.modules.size;y++)for(let x=0;x<q.modules.size;x++)if(q.modules.data[y*q.modules.size+x])d+=`M${x+4} ${y+4}h1v1h-1z`;return {d,size:q.modules.size+8};},[uri]);
 return <div className="space-y-4">
  <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="Shielded Zcash testnet payment request" className="mx-auto size-48 rounded-xl" shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} className="fill-white"/><path d={qr.d} className="fill-black"/></svg>
  <p className="text-center text-xs text-[#9ca7c1]">Scan using a wallet configured for Zcash Testnet. This requests a payment; it does not connect your wallet.</p>
  <p className="break-all rounded-xl bg-white/5 p-3 font-mono text-xs text-[#c9d0e2]">{address}</p>
  <div className="flex flex-wrap justify-center gap-3"><button type="button" className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 px-4 text-xs ${focusRing}`} onClick={async()=>{try{await navigator.clipboard.writeText(address);setNotice('Address copied.');}catch{setNotice('Select and copy the address above.');}}}><Copy size={15}/>Copy address</button><a href={uri} className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 px-4 text-xs ${focusRing}`}><ExternalLink size={15}/>Open Zcash wallet</a></div>
  <p role="status" className="text-center text-xs text-[#aab8dd]">{notice}</p>
 </div>;
}

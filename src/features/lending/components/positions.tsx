"use client";
import {useState} from 'react';
import {focusRing} from '@/components/ui/control-styles';
import {MyLoans} from './my-loans';
import {RegisteredLoan} from './registered-loan';
import {SuppliedPositions} from '@/features/liquidity/components/supplied-positions';
export function Positions({onBorrow}:{onBorrow:()=>void}){
 const [side,setSide]=useState<'borrowed'|'supplied'>('supplied');
 return <div><div className="mb-3 flex gap-2" role="group" aria-label="Position type">{([{id:'supplied',label:'Supplied'},{id:'borrowed',label:'Borrowed'}] as const).map(item=><button key={item.id} onClick={()=>setSide(item.id)} aria-pressed={side===item.id} className={`min-h-10 rounded-full px-4 text-xs font-bold ${focusRing} ${side===item.id?'bg-white/8 text-[#dce4f8]':'text-[#8f9bb6]'}`}>{item.label}</button>)}</div>{side==='supplied'?<SuppliedPositions/>:<div className="space-y-3"><RegisteredLoan/><details className="rounded-2xl border border-white/8 p-3"><summary className="cursor-pointer text-xs text-[#aab7cf]">Saved loan requests</summary><div className="mt-3"><MyLoans onBorrow={onBorrow}/></div></details></div>}</div>;
}

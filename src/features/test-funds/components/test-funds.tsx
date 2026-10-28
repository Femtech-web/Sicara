"use client";

import {useState} from "react";
import {Dialog} from "@/components/ui/dialog";
import {ExternalLink,FlaskConical} from "@/components/ui/icons";
import {focusRing} from "@/components/ui/control-styles";
import {DemoTokenClaim} from './demo-token-claim';

const faucets = [
  {name:"Zcash · TAZ",network:"Zcash Testnet",description:"Fund your own shielded testnet wallet, then send collateral from it. Use a utest1… address.",href:"https://fauzec.com/",action:"Get TAZ"},
  {name:"Sepolia · ETH",network:"Gas for Zama borrowing",description:"Use your connected Sepolia EVM address. Test ETH pays transaction fees; it is separate from cUSDC and Demo ZAMA.",href:"https://ethereum.org/developers/docs/networks/#sepolia",action:"Find ETH faucets"},
  {name:"NEAR · test NEAR",network:"For the planned NEAR integration",description:"Use a NEAR testnet account. NEAR routing is not enabled in Sicara yet.",href:"https://near-faucet.io/",action:"Get test NEAR"},
] as const;

export function TestFunds() {
  const [open,setOpen]=useState(false);
  return <>
    <button type="button" onClick={()=>setOpen(true)} className={`inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-[#a7b3d5] transition-colors hover:bg-white/5 hover:text-white ${focusRing}`}><FlaskConical size={13}/>Faucets</button>
    <Dialog open={open} onOpenChange={setOpen} title="Get test funds" description="Choose the network you need. All assets here are for testing and have no monetary value.">
      <div className="space-y-3">
        <DemoTokenClaim assetId="cusdc"/><DemoTokenClaim assetId="demo-zama"/>
        {faucets.map(faucet=><div key={faucet.name} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
          <p className="text-sm font-bold">{faucet.name}</p><p className="mt-0.5 text-[11px] font-medium text-[#9cabd2]">{faucet.network}</p>
          <p className="mt-2 text-xs leading-relaxed text-[#a5aabd]">{faucet.description}</p>
          <a href={faucet.href} target="_blank" rel="noopener noreferrer" className={`mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-lg text-xs font-bold text-[#becaff] hover:text-white ${focusRing}`}>{faucet.action}<ExternalLink size={13}/><span className="sr-only"> (opens in a new tab)</span></a>
        </div>)}
      </div>
      <p className="mt-4 text-[11px] leading-relaxed text-[#969db2]">External faucets may have cooldowns or human checks. Never enter a seed phrase or private key. Funding a wallet does not enable Sicara deposits.</p>
    </Dialog>
  </>;
}

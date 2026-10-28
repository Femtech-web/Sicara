"use client";

import { useState } from "react";
import { Check, ChevronDown, LockKeyhole } from "@/components/ui/icons";
import { Dialog } from "@/components/ui/dialog";
import { focusRing } from "@/components/ui/control-styles";
import { assets, type Asset } from "../model/assets";
import { TokenIcon } from "./token-icon";

export function AssetSelector({ asset, role, onSelect }: { asset: Asset; role: "collateral" | "borrow" | "lend"; onSelect?: (asset: Asset) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-label={`Select ${role} asset, currently ${asset.symbol} on ${asset.network}`} className={`group inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.035] px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.07] ${focusRing}`} onClick={() => setOpen(true)}>
        <TokenIcon asset={asset.id} compact />
        <span className="text-sm font-bold text-[#e6e9f2] sm:text-base">{asset.symbol}</span>
        <ChevronDown size={13} className="ml-0.5 text-[#8f95a7]" />
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={role === "collateral" ? "Choose collateral" : role === "lend" ? "Choose what to lend" : "Choose what to borrow"} description="Shielded ZEC collateral with confidential borrowing on Sepolia.">
        <div className="space-y-2">
          {Object.values(assets).filter(option => role === 'collateral' ? option.id === 'zec' || option.id === 'near' : option.id === 'cusdc' || option.id === 'demo-zama').map((option) => {
            const selected = option.id === asset.id;
            return <button key={option.id} disabled={!option.available} onClick={() => { onSelect?.(option); setOpen(false); }} className={`flex min-h-20 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left ${focusRing} ${selected ? "border-[#8a9aff]/30 bg-[#8a9aff]/5" : "border-white/5 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-45"}`}><TokenIcon asset={option.id} compact /><span className="min-w-0 flex-1"><span className="block font-bold">{option.symbol}</span><span className="block text-xs text-[#a1a5b3]">{option.network}</span></span>{selected ? <Check className="text-[#a3b1ff]" size={19} /> : <span className="flex items-center gap-1 text-[11px] font-bold text-[#a1a5b3]"><LockKeyhole size={11} />{option.available ? "Select" : "Later"}</span>}</button>;
          })}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-[#9b9fae]">cUSDC is a valueless Sicara test token, not Circle-issued USDC. Demo ZAMA is also a test token. Live collateral lending is not enabled yet.</p>
      </Dialog>
    </>
  );
}

"use client";

import { useState } from "react";
import { Clock3, FlaskConical, ShieldCheck } from "@/components/ui/icons";
import { Dialog } from "@/components/ui/dialog";
import { focusRing } from "@/components/ui/control-styles";
import { PageReveal } from "@/components/ui/page-reveal";
import { BorrowForm } from "./borrow-form";
import { MyLoans } from "./my-loans";
import { TestFunds } from "@/features/test-funds/components/test-funds";

export function LendingApp() {
  const [tab, setTab] = useState<"borrow" | "loans">("borrow");
  const [activityOpen, setActivityOpen] = useState(false);
  const [testnetOpen, setTestnetOpen] = useState(false);
  return (
    <div className="mx-auto w-full max-w-[520px]">
      <PageReveal>
        <div className="mb-4 px-1"><h1 className="text-[25px] font-bold tracking-[-0.04em] text-[#edf0f5] sm:text-[28px]">Borrow against your ZEC.</h1><p className="mt-1 text-[13px] leading-relaxed text-[#939db7]">Shielded collateral. Confidential borrowing.</p></div>
        <div className="mb-2 flex items-center justify-between px-1">
          <div className="flex items-center gap-1"><button onClick={() => setTestnetOpen(true)} className={`flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 text-[13px] font-bold text-[#c7cbd6] transition-colors hover:bg-white/5 ${focusRing}`}><FlaskConical size={14} />Testnet<span className="ml-0.5 size-1.5 rounded-full bg-[#8a9bff] shadow-[0_0_8px_#8a9bff60]" /></button><TestFunds/></div>
          <button onClick={() => setActivityOpen(true)} className={`flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 text-[13px] font-bold text-[#c7cbd6] transition-colors hover:bg-white/5 ${focusRing}`}>Activity <Clock3 size={15} /></button>
        </div>
        <section aria-label="Sicara lending" className="rounded-[28px] border border-white/[0.13] bg-[#080a10]/75 p-3 shadow-[0_24px_100px_-40px_#000000a0] backdrop-blur-xl">
          <div role="tablist" aria-label="Lending views" className="mb-3 flex items-center gap-1 px-1">
            {([{ id: "borrow", label: "Borrow" }, { id: "loans", label: "My Loans" }] as const).map((item) => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "borrow" : event.key === "End" ? "loans" : tab === "borrow" ? "loans" : "borrow"; setTab(next); document.getElementById(`tab-${next}`)?.focus(); } }} className={`min-h-10 rounded-full px-4 text-[13px] font-bold transition-colors ${focusRing} ${tab === item.id ? "bg-white/[0.07] text-[#edf0f5]" : "text-[#858b9d] hover:bg-white/[0.03] hover:text-[#c8cfe2]"}`}>{item.label}</button>)}
            
          </div>
          <div id="panel-borrow" role="tabpanel" aria-labelledby="tab-borrow" hidden={tab !== "borrow"} tabIndex={0} className="rounded-2xl focus-visible:outline-2 focus-visible:outline-[#8798ff]"><BorrowForm /></div>
          <div id="panel-loans" role="tabpanel" aria-labelledby="tab-loans" hidden={tab !== "loans"} tabIndex={0} className="rounded-2xl focus-visible:outline-2 focus-visible:outline-[#8798ff]"><MyLoans onBorrow={() => setTab("borrow")} /></div>
        </section>
        <div className="mt-4 flex items-center justify-center gap-2 text-xs font-semibold text-[#959fbc]"><ShieldCheck size={14} className="text-[#98a8db]" />Borrow what you need. Keep what you own.</div>
      </PageReveal>
      <Dialog open={activityOpen} onOpenChange={setActivityOpen} title="Your activity" description="Deposits, loans, repayments and collateral returns will appear here as they are confirmed."><div className="rounded-2xl border border-dashed border-white/10 px-5 py-10 text-center"><Clock3 size={27} className="mx-auto mb-3 text-[#8e9ccf]" /><p className="font-bold">Nothing to track yet</p><p className="mt-2 text-sm leading-relaxed text-[#9a9fb0]">The loan service is not connected. This preview has not submitted any blockchain transactions.</p></div></Dialog>
      <Dialog open={testnetOpen} onOpenChange={setTestnetOpen} title="A safe place to start" description="Sicara is being built on Zcash Testnet and Ethereum Sepolia. Use testnet assets only."><div className="space-y-4 text-sm leading-relaxed text-[#a6aec3]"><p>Right now you can connect an EVM wallet and explore loan estimates using fixed demo prices. Deposits and borrowing are not enabled.</p><p>cUSDC and Demo ZAMA are valueless demonstration tokens. cUSDC is not Circle-issued USDC. This prototype is experimental and unaudited.</p></div></Dialog>
    </div>
  );
}

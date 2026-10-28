import type { ReactNode } from "react";
import { SiteHeader } from "./site-header";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-x-clip bg-[#0b0b10]">
      <a href="#main-content" className="absolute left-4 top-4 z-50 -translate-y-24 rounded-full bg-[#e7eaff] px-5 py-3 font-bold text-[#181c33] focus:translate-y-0">Skip to lending</a>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute right-0 -top-[630px] h-[1250px] w-[1450px] translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,#2f48b8_0%,#202d6b66_30%,transparent_65%)] opacity-90" />
        <div className="absolute -bottom-[620px] -left-[700px] h-[1300px] w-[1700px] rounded-full bg-[radial-gradient(ellipse_at_center,#3451c88c_0%,#26396e66_30%,transparent_68%)]" />
        <div className="absolute -bottom-[640px] -right-[650px] h-[1100px] w-[1500px] rounded-full bg-[radial-gradient(ellipse_at_center,#2f48b885_0%,#1d28544d_32%,transparent_68%)]" />
      </div>
      <SiteHeader />
      <main id="main-content" className="relative z-0 flex flex-1 items-start justify-center px-3 pb-8 pt-4 sm:px-6 sm:pt-5 lg:pt-4">
        {children}
      </main>
      <footer className="relative z-0 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-6 pb-5 text-center text-[10px] font-semibold text-[#858fab]"><span>Zcash × Zama · NEAR planned</span><span aria-hidden="true" className="text-[#505a73]">·</span><span>Experimental testnet prototype</span></footer>
    </div>
  );
}

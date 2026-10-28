import Link from "next/link";
import { Brand } from "@/components/ui/brand";
import { WalletButton } from "@/features/wallet/components/wallet-button";

export function SiteHeader() {
  return <header className="relative z-10 flex min-h-[76px] flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:px-8 lg:px-10">
    <Brand />
    <nav aria-label="Main navigation" className="flex items-center gap-2 sm:gap-5">
      <Link href="/docs" className="inline-flex min-h-11 items-center rounded-lg px-1 text-xs font-semibold text-[#b6bed2] transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8798ff] sm:text-sm">How it works</Link>
      <WalletButton />
    </nav>
  </header>;
}

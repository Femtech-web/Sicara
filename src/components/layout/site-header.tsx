import { Brand } from "@/components/ui/brand";
import { WalletButton } from "@/features/wallet/components/wallet-button";

export function SiteHeader() {
  return <header className="relative z-10 flex h-[76px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
    <Brand />
    <nav aria-label="Wallet"><WalletButton /></nav>
  </header>;
}

"use client";

import { useConnection } from "wagmi";
import { Wallet } from "@/components/ui/icons";
import { useWalletDialog } from "../hooks/use-wallet-dialog";
import { focusRing } from "@/components/ui/control-styles";
import { useZcashWallet } from "@/features/zcash/hooks/use-zcash-wallet";

export function WalletButton() {
  const open = useWalletDialog();
  const { address, isConnected } = useConnection();
  const zcash = useZcashWallet();
  const label = isConnected && address ? `${address.slice(0, 6)}…${address.slice(-4)}` : zcash.status === 'connected' && zcash.address ? `${zcash.address.slice(0, 6)}…${zcash.address.slice(-4)}` : "Connect";
  return <button onClick={open} aria-label="Manage Sepolia and Zcash wallets" title="Sepolia and Zcash wallets" className={`inline-flex min-h-11 items-center gap-2.5 rounded-full border border-white/10 bg-[#0c1025]/55 px-4 text-sm font-extrabold text-[#dde1f2] transition-colors hover:bg-white/10 ${focusRing}`}><span>{label}</span><Wallet size={17} /></button>;
}

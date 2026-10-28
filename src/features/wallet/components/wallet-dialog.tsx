"use client";

import { useState } from "react";
import Link from "next/link";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { sepolia } from "wagmi/chains";
import { Check, Copy, ExternalLink, LoaderCircle, LogOut, ShieldCheck, Wallet } from "@/components/ui/icons";
import { Dialog } from "@/components/ui/dialog";
import { focusRing, primaryButton } from "@/components/ui/control-styles";

export function WalletDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { address, chainId, isConnected } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const wrongNetwork = isConnected && chainId !== sepolia.id;
  const error = connect.error || switchChain.error;

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setCopyError("");
    } catch { setCopyError("Copy unavailable. Select the address below to copy it manually."); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={isConnected ? "Your Sepolia wallet" : "Connect Sepolia wallet"} description={isConnected ? "Your Sepolia wallet supplies, receives and repays confidential test tokens." : "Connect an Ethereum wallet for confidential lending on Sepolia. Connecting does not move funds or request a signature."}>
      {isConnected && address ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[#9a9daa]">{wrongNetwork ? "Switch network to continue" : "Connected · Sepolia"}</p>
            <p className="break-all font-mono text-sm leading-relaxed">{address}</p>
            <button onClick={copyAddress} className={`mt-3 inline-flex items-center gap-2 rounded-lg text-sm text-[#b8c2ff] ${focusRing}`}>
              {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Address copied" : "Copy address"}
            </button>
            {copyError && <p role="status" className="mt-2 text-sm text-amber-200">{copyError}</p>}
          </div>
          {wrongNetwork && <button className={primaryButton} disabled={switchChain.isPending} onClick={() => switchChain.mutate({ chainId: sepolia.id })}>{switchChain.isPending ? "Switching…" : "Switch to Sepolia"}</button>}
          <button className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-white/10 text-sm font-bold text-[#c5c7d1] hover:bg-white/5 ${focusRing}`} onClick={() => { disconnect.mutate({}); onOpenChange(false); }}><LogOut size={16} /> Disconnect</button>
        </div>
      ) : (
        <div className="space-y-3">
          {connectors.map((connector) => (
            <button key={connector.uid} className={`flex min-h-16 w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 text-left font-bold hover:bg-white/[0.07] disabled:opacity-50 ${focusRing}`} disabled={connect.isPending} onClick={() => { setCopied(false); connect.mutate({ connector }); }}>
              <span className="flex items-center gap-3"><Wallet size={22} />{connector.name === "Injected" ? "Browser wallet" : connector.name}</span>
              {connect.isPending ? <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" /> : <span className="text-xs text-[#9fa2b1]">Connect</span>}
            </button>
          ))}
          <p className="text-xs leading-relaxed text-[#969aa9]">Use an installed browser wallet such as MetaMask or Rabby.</p>
          <a href="https://ethereum.org/wallets/find-wallet/" target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 rounded-lg text-sm font-bold text-[#b8c2ff] ${focusRing}`}>Need a wallet? <ExternalLink size={13} /></a>
        </div>
      )}
      <div className="mt-5 rounded-2xl border border-white/8 bg-white/[0.025] p-4 text-xs leading-relaxed text-[#a0a9bf]"><p className="font-bold text-[#d5dcec]">This connects your Sepolia wallet</p><p className="mt-1">Use it to supply, receive and repay confidential test tokens. It does not connect a Zcash wallet.</p><p className="mt-3 font-bold text-[#d5dcec]">Zcash · separate deposit step</p><p className="mt-1">The Zcash client integration is not available in the app yet. Once enabled, the deposit stage will show a shielded payment address and QR for a Zcash testnet wallet. Scanning a payment QR only sends a payment; it does not connect the wallet or complete private loan setup.</p><p className="mt-2">NEAR routing is planned. No NEAR connection is needed for this test route.</p><Link href="/docs#wallets" onClick={() => onOpenChange(false)} className={`mt-2 inline-flex min-h-10 items-center rounded-lg font-semibold text-[#b8c2ff] ${focusRing}`}>Read how the wallets work →</Link></div>
      {error && <p role="alert" className="mt-4 rounded-xl bg-amber-300/5 p-3 text-sm leading-relaxed text-amber-200">{error.message.includes("rejected") ? "Connection or network change declined. You can try again when ready." : "Could not connect or change networks. Check that your browser wallet is installed and unlocked, then try again."}</p>}
      <div className="mt-6 flex items-start gap-2 border-t border-white/8 pt-4 text-xs leading-relaxed text-[#9397a6]"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-[#8e9de8]" />Your keys stay in your wallet. Sicara will never ask for your recovery phrase.</div>
    </Dialog>
  );
}

"use client";
import Link from 'next/link';
import { useState } from 'react';
import { useZcashWallet } from '../hooks/use-zcash-wallet';
import { focusRing } from '@/components/ui/control-styles';
import { Copy, Check, Wallet } from '@/components/ui/icons';

export function ZcashWalletConnection({ onNavigate }: { onNavigate: () => void }) {
  const wallet = useZcashWallet(); const [notice, setNotice] = useState('');
  const connected = wallet.status === 'connected';
  return <section aria-labelledby="zcash-wallet-title" className="mt-5 rounded-2xl border border-white/10 bg-[#121318] p-4">
    <div className="flex items-center justify-between gap-3"><h3 id="zcash-wallet-title" className="text-sm font-bold">Zcash Testnet</h3><span className="text-[11px] text-[#a3aec5]">{connected ? 'Connected · Noir' : 'Separate wallet'}</span></div>
    <p className="mt-2 text-xs leading-6 text-[#a0a9bf]">Connect the testnet Noir extension for your Zcash account. Its address stays in this browser tab and is not linked to your Sepolia wallet by the app backend.</p>
    {connected && wallet.address && <div className="mt-3 rounded-xl bg-white/5 p-3"><p className="break-all font-mono text-xs leading-5 text-[#c9d1e4]">{wallet.address}</p><button type="button" className={`mt-1 inline-flex min-h-10 items-center gap-2 rounded-lg text-xs text-[#b8c2ff] ${focusRing}`} onClick={async () => { try { await navigator.clipboard.writeText(wallet.address!); setNotice('Address copied.'); } catch { setNotice('Select the address above to copy it.'); } }}>{notice === 'Address copied.' ? <Check size={14} /> : <Copy size={14} />}Copy address</button></div>}
    <button type="button" disabled={wallet.status === 'connecting'} className={`mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-white/10 px-4 text-xs font-bold text-[#d7ddf1] hover:bg-white/5 disabled:opacity-50 ${focusRing}`} onClick={async () => { setNotice(''); try { if (connected) await wallet.disconnect(); else await wallet.connect(); } catch (error) { setNotice(error instanceof Error ? error.message : 'Zcash connection unavailable.'); } }}><Wallet size={16} />{wallet.status === 'connecting' ? 'Approve in Noir…' : connected ? 'Disconnect Zcash' : 'Connect Zcash wallet'}</button>
    <p className="mt-3 text-[11px] leading-5 text-[#939fb8]">Connection does not lock ZEC or authorize a loan. Private collateral signing and deposits are still gated. No balance, payment or signing request is made here.</p>
    {(notice || wallet.error) && <p role="status" className="mt-2 text-xs leading-5 text-amber-200">{notice || wallet.error}</p>}
    <div className="mt-2 flex flex-wrap gap-x-4"><a href="https://zknoir.com" target="_blank" rel="noreferrer" className={`inline-flex min-h-10 items-center rounded-lg text-xs text-[#b8c2ff] ${focusRing}`}>Noir Wallet ↗</a><Link href="/docs#wallets" onClick={onNavigate} className={`inline-flex min-h-10 items-center rounded-lg text-xs text-[#b8c2ff] ${focusRing}`}>How the wallets work →</Link></div>
  </section>;
}

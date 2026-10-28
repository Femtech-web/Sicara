"use client";

import { Landmark, Wallet } from "@/components/ui/icons";
import { useConnection } from "wagmi";
import { useWalletDialog } from "@/features/wallet/hooks/use-wallet-dialog";
import { focusRing, primaryButton } from "@/components/ui/control-styles";
import { useQuery } from "@tanstack/react-query";
import { api, useWalletSession } from "@/features/wallet/hooks/use-wallet-session";

export function MyLoans({ onBorrow }: { onBorrow: () => void }) {
  const { isConnected, address, chainId } = useConnection();
  const openWallet = useWalletDialog();
  const { authenticated, signIn, signOut, query } = useWalletSession();
  const loans = useQuery({
    queryKey: ["loans", address?.toLowerCase()],
    queryFn: () => api<{ loans: { id: string; state: string; created_at: string }[] }>("/api/loans"),
    enabled: authenticated,
    retry: false,
    staleTime: 0,
  });
  const error = signIn.error || signOut.error || (authenticated ? loans.error : query.error);
  return (
    <div className="flex min-h-[450px] flex-col items-center justify-center rounded-[25px] bg-[#111215] px-7 py-10 text-center">
      <span className="mb-6 flex size-[72px] items-center justify-center rounded-[25px] border border-[#8c9bff]/15 bg-[#8c9bff]/5 text-[#b1bef4]"><Landmark size={29} /></span>
      <h2 className="text-xl font-extrabold tracking-tight">{authenticated ? "Your loans" : isConnected ? "A private place for your loans" : "Your ZEC. Your next move."}</h2>
      <p className="mt-3 max-w-[300px] text-sm leading-relaxed text-[#979eaf]">{authenticated ? "Your requests appear here as their status is confirmed." : isConnected ? "Sign a message to prove this wallet is yours and view your loan requests. Signing in is free and does not move funds." : "Connect your wallet, then sign in to manage your loans."}</p>
      <p className="mb-6 mt-4 rounded-full border border-white/8 px-3 py-1.5 text-[11px] font-bold text-[#9ea7c3]">Deposits and borrowing are not enabled yet</p>
      {authenticated && <div className="mb-6 w-full space-y-3 text-left" aria-live="polite">
        {loans.isPending ? <p className="text-center text-sm text-[#979eaf]">Loading your loans…</p> : loans.data?.loans.length === 0 ? <p className="text-center text-sm text-[#979eaf]">No loan requests yet.</p> : loans.data?.loans.map(loan => <div key={loan.id} className="rounded-2xl border border-white/10 p-4"><p className="text-sm font-bold capitalize">{loan.state.replaceAll("_", " ")}</p><p className="mt-1 break-all font-mono text-xs text-[#979eaf]">{loan.id}</p></div>)}
      </div>}
      {!isConnected || chainId !== 11155111 ? <button className={primaryButton} onClick={openWallet}><Wallet size={17} />{isConnected ? "Switch to Sepolia" : "Connect wallet"}</button> : !authenticated ? <button className={primaryButton} disabled={signIn.isPending || query.isFetching} onClick={() => signIn.mutate()}>{signIn.isPending ? "Check your wallet…" : query.isFetching ? "Checking sign-in…" : "Sign in with wallet"}</button> : <button className={`rounded-full px-5 py-3 text-sm font-extrabold text-[#c3cdff] hover:bg-white/5 ${focusRing}`} disabled={signOut.isPending} onClick={() => signOut.mutate()}>{signOut.isPending ? "Signing out…" : "Sign out"}</button>}
      {error && <p role="alert" className="mt-4 max-w-[320px] text-sm leading-relaxed text-amber-200">{signIn.error ? "Could not sign in. Check your wallet and try again. If the service is unavailable, finish the database setup first." : error.message}</p>}
      {authenticated && <button className={`mt-3 rounded-full px-5 py-3 text-sm font-bold text-[#c3cdff] hover:bg-white/5 ${focusRing}`} onClick={onBorrow}>Explore borrowing →</button>}
    </div>
  );
}

"use client";

import { useState } from "react";
import { ArrowRight, Info, LockKeyhole, Wallet } from "@/components/ui/icons";
import { useConnection, useReadContracts } from "wagmi";
import { markets, marketAbi } from "@/features/liquidity/config/market";
import { flatInterest, principalLimit } from "@/features/liquidity/model/amount";
import { sepolia } from "wagmi/chains";
import { focusRing, primaryButton } from "@/components/ui/control-styles";
import { useWalletDialog } from "@/features/wallet/hooks/use-wallet-dialog";
import { assets, lendingRoute, type BorrowAssetId } from "../model/assets";
import { previewQuote, formatMoney, formatTokenAmount, validateBorrowAmount } from "../model/quote";
import { AssetSelector } from "./asset-selector";
import { LoanTerms } from "./loan-terms";

const amountInput = "min-w-0 w-full rounded-lg bg-transparent py-1 text-[32px] font-medium leading-tight tracking-[-0.04em] text-[#edf0f5] caret-[#99aaff] outline-none placeholder:text-[#666c7c] sm:text-[36px]";

export function BorrowForm() {
  const [amount, setAmount] = useState("");
  const [requestedAmount, setRequestedAmount] = useState<string | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const [borrowAssetId,setBorrowAssetId] = useState<BorrowAssetId>("cusdc");
  const borrowed=assets[borrowAssetId];
  const formatAmount=(units:bigint)=>formatTokenAmount(units,borrowed.decimals);
  const { isConnected, chainId } = useConnection();
  const openWallet = useWalletDialog();
  const market = markets[borrowAssetId];
  const terms = useReadContracts({contracts:market.pool?[{address:market.pool,abi:marketAbi,functionName:'commonCeiling'},{address:market.pool,abi:marketAbi,functionName:'interestBps'},{address:market.pool,abi:marketAbi,functionName:'minimumCollateralZats'}]:[],allowFailure:false,chainId:11155111,query:{enabled:!!market.pool}});
  const interestBps = terms.data?.[1] ?? 0;
  const preview = previewQuote(amount || "0",borrowed.decimals);
  const debtCeiling = terms.data?.[0];
  const minimumCollateral = terms.data?.[2];
  const cap = debtCeiling !== undefined ? principalLimit(debtCeiling,BigInt(interestBps)) : undefined;
  const quote = preview.ok && cap !== undefined ? {...preview,borrowUnits:preview.borrowUnits < cap ? preview.borrowUnits : cap} : preview;
  const collateralInvalid = amount !== "" && !quote.ok;
  const maxUnits = quote.ok ? quote.borrowUnits : 0n;
  const borrowAmount = requestedAmount ?? (maxUnits > 0n ? formatAmount(maxUnits) : "");
  const loan = validateBorrowAmount(borrowAmount, maxUnits,borrowed.decimals);
  const borrowInvalid = requestedAmount !== null && requestedAmount !== "" && !loan.ok;
  const minimumMet = minimumCollateral === undefined || quote.ok && quote.collateralZatoshis >= minimumCollateral;
  const canReview = quote.ok && quote.maxBorrowCents > 0n && loan.ok && minimumMet;
  const wrongNetwork = isConnected && chainId !== sepolia.id;
  const loanValueCents = loan.ok ? loan.borrowUnits * lendingRoute.borrowPriceCents / (10n ** BigInt(borrowed.decimals)) : 0n;

  return (
    <>
      <form noValidate onSubmit={(event) => { event.preventDefault(); if (!isConnected || wrongNetwork) openWallet(); else if (canReview) setTermsOpen(true); }}>
        <div className="rounded-[20px] border border-white/[0.035] bg-[#121318] p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="collateral-amount" className="text-sm font-semibold text-[#bfc5d6]">Your collateral</label>
            <span className="flex items-center gap-1 text-[10px] font-medium text-[#9b9fab]"><LockKeyhole size={12} />Shielded</span>
          </div>
          <div className="flex items-center gap-3">
            <input id="collateral-amount" aria-describedby={collateralInvalid ? "collateral-error demo-price" : "demo-price"} aria-invalid={collateralInvalid} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="0.00" maxLength={22} className={amountInput} />
            <AssetSelector asset={lendingRoute.collateral} role="collateral" />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[#8f97ab]">
            <span>{quote.ok ? formatMoney(quote.collateralValueCents) : "—"} demo value</span><span>{lendingRoute.collateral.network}</span>
          </div>
          {!minimumMet && <p role="alert" className="mt-2 text-xs text-amber-200">The fixed test policy needs at least {minimumCollateral !== undefined ? formatTokenAmount(minimumCollateral,8) : "—"} ZEC. More collateral does not raise its common loan ceiling.</p>}
          {collateralInvalid && <p id="collateral-error" role="alert" className="mt-3 text-xs leading-relaxed text-amber-200">{quote.error}</p>}
        </div>

        <div className="mt-2 rounded-[20px] border border-white/[0.035] bg-[#121318] p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="borrow-amount" className="text-sm font-semibold text-[#bfc5d6]">You borrow</label>
            <span className="text-[10px] font-medium text-[#9b9fab]">Confidential demo token</span>
          </div>
          <div className="flex items-center gap-3">
            <input id="borrow-amount" aria-describedby={borrowInvalid ? "borrow-error borrow-limit" : "borrow-limit"} aria-invalid={borrowInvalid} value={borrowAmount} onChange={(event) => setRequestedAmount(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="0.00" maxLength={22} className={amountInput} />
            <AssetSelector asset={borrowed} role="borrow" onSelect={asset=>{if(asset.id==="cusdc"||asset.id==="demo-zama"){setBorrowAssetId(asset.id);setRequestedAmount(null);}}} />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[#8f97ab]">
            <span>{loan.ok || borrowAmount === "" ? formatMoney(loanValueCents) : "—"} demo value</span><span>{borrowed.network}</span>
          </div>
          {borrowInvalid && <p id="borrow-error" role="alert" className="mt-2 text-xs leading-relaxed text-amber-200">{loan.error}</p>}
        </div>

        <div className="px-1 pb-2 pt-3 sm:px-2">
          <div id="borrow-limit" className="flex items-center justify-between gap-2 text-[11px]">
            <p className="min-w-0 text-[#8f97ab]">Borrowing limit <span className="ml-1 break-all font-semibold text-[#d7deee]">{formatAmount(maxUnits)}</span></p>
            <button type="button" disabled={maxUnits === 0n} onClick={() => setRequestedAmount(formatAmount(maxUnits))} className={`inline-flex min-h-10 shrink-0 items-center rounded-lg px-2 font-bold text-[#aebdff] hover:bg-[#8798ff]/10 disabled:opacity-40 ${focusRing}`}>Use max</button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-[#8f97ab]">
            <p>Max LTV <span className="ml-1 font-semibold text-[#d7deee]">50%</span><span className="mx-2 text-white/15" aria-hidden="true">·</span>Interest <span className="ml-1 font-semibold text-[#d7deee]">{Number(interestBps)/100}%{interestBps > 0 ? " flat" : " preview"}</span></p>
            <button type="button" className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg px-1 text-[#a8b2cd] hover:text-white ${focusRing}`} onClick={() => setTermsOpen(true)}><Info size={13} />Terms & privacy<ArrowRight size={12} /></button>
          </div>
        </div>
        <button className={primaryButton} type="submit" disabled={isConnected && !wrongNetwork && !canReview}>
          {!isConnected ? <><Wallet size={18} />Connect wallet</> : wrongNetwork ? "Switch to Sepolia" : canReview ? <>Review loan <ArrowRight size={17} /></> : "Enter valid loan amounts"}
        </button>
        <p id="demo-price" className="px-2 pb-0.5 pt-2 text-center text-[10px] leading-relaxed text-[#858ca0]">Demo prices · ZEC deposits & borrowing not yet enabled</p>
      </form>
      <LoanTerms interestBps={BigInt(interestBps)} interestUnits={loan.ok ? flatInterest(loan.borrowUnits,BigInt(interestBps)) : 0n} borrowAsset={borrowed} open={termsOpen} onOpenChange={setTermsOpen} amount={amount} quote={quote} borrowUnits={loan.ok ? loan.borrowUnits : undefined} />
    </>
  );
}

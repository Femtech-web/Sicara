"use client";

import type { Asset } from "../model/assets";
import { Info, ShieldCheck } from "@/components/ui/icons";
import { Dialog } from "@/components/ui/dialog";
import { primaryButton } from "@/components/ui/control-styles";
import { formatMoney, formatTokenAmount, type PreviewQuote } from "../model/quote";

export function LoanTerms({ open, onOpenChange, amount, quote, borrowUnits, borrowAsset }: { open: boolean; onOpenChange: (open: boolean) => void; amount: string; quote: PreviewQuote; borrowUnits?: bigint; borrowAsset: Asset }) {
  const valid = quote.ok && quote.collateralZatoshis > 0n;
  const rows = [
    ["Collateral", valid ? `${amount} ZEC` : "Enter an amount"],
    ["Requested loan", borrowUnits !== undefined ? `${formatTokenAmount(borrowUnits,borrowAsset.decimals)} ${borrowAsset.symbol}` : "Enter a valid amount"],
    ["Maximum loan", valid ? `${formatTokenAmount(quote.borrowUnits,borrowAsset.decimals)} ${borrowAsset.symbol}` : "—"],
    ["Demo collateral value", valid ? formatMoney(quote.collateralValueCents) : "—"],
    ["Maximum loan-to-value", "50%"],
    ["Interest", "0% · testnet only"],
    ["Repayment", borrowUnits !== undefined ? `${formatTokenAmount(borrowUnits,borrowAsset.decimals)} ${borrowAsset.symbol}` : "—"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Your loan, at a glance" description="An illustrative estimate using fixed demo prices. This is not an executable quote or a request to deposit funds.">
      <dl className="space-y-3.5 rounded-2xl bg-white/[0.025] p-4 text-sm">
        {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-6"><dt className="text-[#a1a5b3]">{label}</dt><dd className="max-w-[58%] text-right font-bold text-[#e2e6f1]">{value}</dd></div>)}
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-[#a0a5b5]">Demo prices: 1 ZEC = $100; 1 {borrowAsset.symbol} = $1. Both borrowing assets are valueless test tokens; cUSDC is not Circle-issued USDC. Not market prices. Return-fee policy will be defined before deposits are enabled.</p>
      <div className="mt-5 flex gap-2.5 rounded-2xl border border-[#8b9bff]/15 bg-[#8b9bff]/5 p-4 text-sm leading-relaxed text-[#bbc4ea]"><ShieldCheck size={19} className="mt-0.5 shrink-0" /><p>Zcash shields settlement. Zama protects selected loan values. The testnet collateral operator still holds custody and can link the deposit to your EVM wallet.</p></div>
      <p className="my-5 flex items-start gap-2 text-xs leading-relaxed text-[#abaebb]"><Info size={15} className="mt-0.5 shrink-0" />Loan issuance, shielded deposits and repayment are being integrated. No funds can move from this preview.</p>
      <button className={primaryButton} onClick={() => onOpenChange(false)}>Back to borrowing</button>
    </Dialog>
  );
}

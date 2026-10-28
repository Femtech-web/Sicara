import { lendingRoute } from "./assets";

const ZATOSHIS = 100_000_000n;
const BASIS_POINTS = 10_000n;

export type PreviewQuote =
  | { ok: true; collateralZatoshis: bigint; collateralValueCents: bigint; maxBorrowCents: bigint; borrowUnits: bigint }
  | { ok: false; error: string };

/** Exact, deliberately non-authoritative preview. No RPC calls or real market prices. */
export function previewQuote(input: string, decimals = 8): PreviewQuote {
  if (![6,8].includes(decimals)) throw new Error("Unsupported borrowing precision");
  if (!/^(?:\d{1,12})(?:\.\d{0,8})?$/.test(input)) {
    return { ok: false, error: "Enter a valid ZEC amount with up to 8 decimal places." };
  }
  const [whole, fraction = ""] = input.split(".");
  const collateralZatoshis = BigInt(whole) * ZATOSHIS + BigInt(fraction.padEnd(8, "0"));
  const collateralValueCents = collateralZatoshis * lendingRoute.collateralPriceCents / ZATOSHIS;
  // Round down once after all factors, keeping fractional-cent intermediate precision.
  const maxBorrowCents = collateralZatoshis * lendingRoute.collateralPriceCents * lendingRoute.maxLtvBps / (ZATOSHIS * BASIS_POINTS);
  const borrowUnits = maxBorrowCents * (10n ** BigInt(decimals)) / lendingRoute.borrowPriceCents;
  return { ok: true, collateralZatoshis, collateralValueCents, maxBorrowCents, borrowUnits };
}

export function formatMoney(cents: bigint): string {
  const dollars = (cents / 100n).toLocaleString("en-US");
  return `$${dollars}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function formatTokenAmount(units: bigint, decimals = 8): string {
  const scale=10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export type BorrowValidation = { ok: true; borrowUnits: bigint } | { ok: false; error: string };

/** Validate a chosen loan amount against the already computed demo capacity. */
export function validateBorrowAmount(input: string, maxBorrowUnits: bigint, decimals = 8): BorrowValidation {
  if (![6,8].includes(decimals)) throw new Error("Unsupported borrowing precision");
  if (!(new RegExp(`^(?:\\d{1,12})(?:\\.\\d{0,${decimals}})?$`)).test(input)) {
    return { ok: false, error: `Enter a valid loan amount with up to ${decimals} decimal places.` };
  }
  const [whole, fraction = ""] = input.split(".");
  const borrowUnits = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, "0"));
  if (borrowUnits <= 0n) return { ok: false, error: "Enter a loan amount greater than zero." };
  if (borrowUnits > maxBorrowUnits) return { ok: false, error: "This amount exceeds your 50% borrowing limit. Lower the loan or add collateral." };
  return { ok: true, borrowUnits };
}

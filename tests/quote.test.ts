import assert from "node:assert/strict";
import { test } from "node:test";
import { previewQuote, formatMoney, formatTokenAmount } from "../src/features/lending/model/quote";
import {validateBorrowAmount} from '../src/features/lending/model/quote';

test('six-decimal cUSDC quotes do not mix with eight-decimal Demo ZAMA units',()=>{
 const usd=previewQuote('10',6),zama=previewQuote('10',8);
 assert.ok(usd.ok&&zama.ok);
 assert.equal(usd.borrowUnits,500_000_000n);
 assert.equal(zama.borrowUnits,50_000_000_000n);
 assert.equal(formatTokenAmount(usd.borrowUnits,6),'500');
 assert.equal(validateBorrowAmount('0.000001',usd.borrowUnits,6).ok,true);
 assert.equal(validateBorrowAmount('0.0000001',usd.borrowUnits,6).ok,false);
});

test("10 ZEC at the explicit $100 demo price gives a $500 borrowing limit", () => {
  const quote = previewQuote("10");
  assert.ok(quote.ok);
  assert.equal(quote.collateralZatoshis, 1_000_000_000n);
  assert.equal(quote.collateralValueCents, 100_000n);
  assert.equal(quote.maxBorrowCents, 50_000n);
  assert.equal(formatTokenAmount(quote.borrowUnits), "500");
});

test("fractional collateral rounds the borrowing limit down, never up", () => {
  const quote = previewQuote("0.00039999");
  assert.ok(quote.ok);
  assert.equal(quote.maxBorrowCents, 1n);
  assert.equal(formatTokenAmount(quote.borrowUnits), "0.01");
  const dust = previewQuote("0.00000001");
  assert.ok(dust.ok);
  assert.equal(dust.maxBorrowCents, 0n);
});

test("rejects negative, exponent, ambiguous, oversized and overprecision amounts", () => {
  for (const value of ["-1", "1e4", "NaN", "Infinity", "1,000", "0.123456789", "1.2.3", "", ".", " 1", "9999999999999"]) {
    assert.equal(previewQuote(value).ok, false, value);
  }
});

test("zero, trailing decimal and exact eight-decimal amounts are supported", () => {
  for (const value of ["0", "0.", "1.", "0001.00000001"]) assert.ok(previewQuote(value).ok, value);
  const quote = previewQuote("1.00000001");
  assert.ok(quote.ok);
  assert.equal(quote.collateralZatoshis, 100_000_001n);
  assert.equal(quote.maxBorrowCents, 5000n);
});

test("formatters retain base-unit precision without converting BigInt to Number", () => {
  assert.equal(formatMoney(123456789012345678901n), "$1,234,567,890,123,456,789.01");
  assert.equal(formatTokenAmount(100_000_001n), "1.00000001");
});

test("requested borrowing can stay below the maximum and must never exceed it", async () => {
  const { validateBorrowAmount } = await import("../src/features/lending/model/quote");
  assert.deepEqual(validateBorrowAmount("250", 50_000_000_000n), { ok: true, borrowUnits: 25_000_000_000n });
  assert.deepEqual(validateBorrowAmount("500", 50_000_000_000n), { ok: true, borrowUnits: 50_000_000_000n });
  assert.equal(validateBorrowAmount("500.00000001", 50_000_000_000n).ok, false);
  assert.equal(validateBorrowAmount("1", 0n).ok, false);
  for (const value of ["0", "-1", "1e3", "", "0.000000001"]) assert.equal(validateBorrowAmount(value, 50_000_000_000n).ok, false);
});

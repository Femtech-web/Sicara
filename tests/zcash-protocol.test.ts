import assert from "node:assert/strict";
import { test } from "node:test";
import { assessDeposit, parseDeposits, testnetAddress, zatoshis, type DepositNote } from "../services/zcash/protocol";
const address = "utest15re965qrdvxun9399eps75cca8n9cakfh6anznck7evwrdsvusj00r2kpr9eddzvadex8xx4yrlnk5ahemu0jf495yhz5zz7eqglrjmm";
const note: DepositNote = { txid: "a".repeat(64), index: 0, height: 100, address, zatoshis: 1_000_000n, valuePool: "ironwood", source: "wallet" };

test("deposit assessment requires ten mined confirmations and a fresh snapshot", () => {
  assert.equal(assessDeposit({ tip: 108, stale: false, notes: [note] }, address, 1_000_000n).status, "confirming");
  assert.equal(assessDeposit({ tip: 109, stale: false, notes: [note] }, address, 1_000_000n).status, "confirmed");
  assert.equal(assessDeposit({ tip: 109, stale: true, notes: [note] }, address, 1_000_000n).status, "stale");
  assert.equal(assessDeposit({ tip: 99, stale: false, notes: [note] }, address, 1_000_000n).status, "confirming");
  assert.equal(assessDeposit({ tip: 109, stale: false, notes: [{ ...note, source: "mempool" }] }, address, 1_000_000n).status, "confirming");
});
test("duplicate note identities cannot inflate collateral", () => {
  assert.throws(() => assessDeposit({ tip: 109, stale: false, notes: [note, note] }, address, 2_000_000n), /Duplicate/);
  const split = assessDeposit({ tip: 109, stale: false, notes: [note, { ...note, index: 1 }] }, address, 2_000_000n);
  assert.equal(split.status, "confirmed");
  assert.equal(split.noteIds.length, 2);
});
test("malformed, ambiguous, unsafe or legacy wallet data fails closed", () => {
  for (const value of [1, -1, "-1", "1e8", "2100000000000001"]) assert.throws(() => zatoshis(value));
  for (const value of ["u1abc", "tmTransparent", "ztestsapling1abc", "garbage"]) assert.throws(() => testnetAddress(value));
  assert.throws(() => parseDeposits({ tip: 1, notes: [], stale: undefined }));
  assert.throws(() => parseDeposits({ tip: 109, stale: false, notes: [{ txid: "a".repeat(64), index: 0, height: 100, toAddress: address, zats: "1000000", valuePool: "orchard", source: "wallet" }] }));
});

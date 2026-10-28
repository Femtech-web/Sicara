import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { WalletAuth, hashToken } from "../src/features/wallet/server/auth";
import { LoanRepository } from "../src/features/lending/server/loan-repository";
import type { DepositNote } from "../services/zcash/protocol";
import type { Database, Sql } from "../services/database/types";
import { applyMigrations } from "../services/database/migrate";

const address = "utest15re965qrdvxun9399eps75cca8n9cakfh6anznck7evwrdsvusj00r2kpr9eddzvadex8xx4yrlnk5ahemu0jf495yhz5zz7eqglrjmm";
const origin = "http://127.0.0.1:3000";
const migration = readFileSync(new URL("../services/database/migrations/001_wallet_loans.sql", import.meta.url), "utf8");
const note: DepositNote = { address, txid: "a".repeat(64), index: 0, height: 100, zatoshis: 1_000_000n, valuePool: "ironwood", source: "wallet" };
async function testDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "sicara-backend-"));
  const db = new PGlite(join(directory, "postgres"));
  const close = db.close.bind(db);
  db.close = async () => { await close(); await rm(directory, { recursive: true, force: true }); };
  return db;
}
async function fixture() {
  const db = await testDatabase();
  await db.exec(migration);
  for (const file of ['002_wallet_worker.sql','003_collateral_authorizations.sql','004_confirmed_borrow_retries.sql','005_settlement_release.sql']) await db.exec(readFileSync(new URL(`../services/database/migrations/${file}`, import.meta.url), 'utf8'));
  const backend: Database = {
    query: (text, values) => backend.transaction(sql => sql.query(text, values)),
    transaction: run => db.transaction(async tx => {
      await tx.query("SET LOCAL ROLE sicara_backend");
      return run(tx);
    }),
  };
  return { db, auth: new WalletAuth(backend, origin), loans: new LoanRepository(backend), account: privateKeyToAccount(generatePrivateKey()) };
}

test("SIWE is bound to domain, wallet, browser, expiry; session tokens are hashed and replay is atomic", async () => {
  const { db, auth, account } = await fixture();
  try {
    const challenge = await auth.challenge(account.address);
    await assert.rejects(new WalletAuth(db, "http://localhost:3000").verify(challenge.id, await account.signMessage({ message: challenge.message }), challenge.browserToken), /domain/);
    assert.match(challenge.message, /127.0.0.1:3000 wants you to sign in/);
    assert.match(challenge.message, /Chain ID: 11155111/);
    const signature = await account.signMessage({ message: challenge.message });
    await assert.rejects(auth.verify(challenge.id, signature, "b".repeat(64)), /expired|invalid/);
    const stranger = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(auth.verify(challenge.id, await stranger.signMessage({ message: challenge.message }), challenge.browserToken), /expired|invalid/);
    const attempts = await Promise.allSettled([
      auth.verify(challenge.id, signature, challenge.browserToken),
      auth.verify(challenge.id, signature, challenge.browserToken),
    ]);
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    const success = attempts.find(result => result.status === "fulfilled");
    assert(success?.status === "fulfilled");
    const session = success.value;
    assert.equal((await auth.session(session.token))?.wallet, account.address.toLowerCase());
    const stored = await db.query<{ token_hash: string }>("SELECT token_hash FROM sicara.sessions");
    assert.equal(stored.rows[0].token_hash, hashToken(session.token));
    assert.notEqual(stored.rows[0].token_hash, session.token);
    await auth.logout(session.token);
    assert.equal(await auth.session(session.token), null);
  } finally { await db.close(); }
});

test("expired challenges/sessions, changed domains and sign-in flooding fail closed", async () => {
  const { db, auth, account } = await fixture();
  try {
    const challenge = await auth.challenge(account.address);
    const signature = await account.signMessage({ message: challenge.message.replace("127.0.0.1:3000", "evil.example") });
    await assert.rejects(auth.verify(challenge.id, signature, challenge.browserToken));
    await db.query("UPDATE sicara.auth_challenges SET expires_at=clock_timestamp()-interval '1 second'");
    await assert.rejects(auth.verify(challenge.id, await account.signMessage({ message: challenge.message }), challenge.browserToken));
    const fresh = await auth.challenge(account.address);
    const session = await auth.verify(fresh.id, await account.signMessage({ message: fresh.message }), fresh.browserToken);
    await db.query("UPDATE sicara.sessions SET expires_at=clock_timestamp()-interval '1 second'");
    assert.equal(await auth.session(session.token), null);
    for (let i = 0; i < 3; i++) await auth.challenge(account.address);
    await assert.rejects(auth.challenge(account.address), /Too many/);
  } finally { await db.close(); }
});

test("loan preparation is idempotent, terms are immutable, only one open request and owner can access it", async () => {
  const { db, loans, account } = await fixture();
  try {
    const key = randomUUID();
    const results = await Promise.all([loans.prepare(account.address, key, address, 1_000_000n), loans.prepare(account.address, key, address, 1_000_000n)]);
    assert.equal(results[0].id, results[1].id);
    const id = results[0].id;
    await assert.rejects(db.query("UPDATE sicara.loans SET return_address=$2 WHERE id=$1", [id, address + "q"]), /immutable/);
    await assert.rejects(loans.prepare(account.address, key, address, 2_000_000n), /different terms/);
    await assert.rejects(loans.prepare(account.address, randomUUID(), address, 1n), /already open/);
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    await assert.rejects(loans.find(stranger, id), /not found/);
    await assert.rejects(loans.cancel(stranger, id), /not found/);
    assert.deepEqual(await loans.list(stranger), []);
    await assert.rejects(db.query("INSERT INTO sicara.loans(id,wallet,request_key,return_address,required_zatoshis,expires_at) VALUES($1,$2,$3,$4,1,clock_timestamp())", [randomUUID(), account.address.toLowerCase(), randomUUID(), address]), /one_open_loan/);
    await loans.cancel(account.address, id);
    await loans.cancel(account.address, id);
    const intents = await db.query<{ destination: string; state: string }>("SELECT destination,state FROM sicara.refund_intents");
    assert.equal(intents.rows.length, 1);
    assert.equal(intents.rows[0].destination, address);
    assert.equal(intents.rows[0].state, "reconciliation_required");
    await assert.rejects(loans.prepare(account.address, randomUUID(), address, 1n), /already open/);
  } finally { await db.close(); }
});

test("the migration runner commits once and safely skips already applied migrations", async () => {
  const db = await testDatabase();
  // PGlite's extended query protocol does not accept multi-statement migrations;
  // pg does when no parameters are supplied. Use exec for that same SQL only.
  const adapter: Sql = { query: async <T extends Record<string, unknown>>(text: string, values?: unknown[]) => {
    if (text.includes("CREATE SCHEMA sicara") || text.includes("CREATE TABLE sicara.wallet_worker") || text.includes("CREATE TABLE sicara.collateral_authorizations") || text.includes("ADD COLUMN attempt") || text.includes("CREATE TABLE sicara.release_intents")) { await db.exec(text); return { rows: [] }; }
    return db.query<T>(text, values);
  } };
  try {
    await db.exec("BEGIN");
    assert.equal(await applyMigrations(adapter), true);
    await db.exec("COMMIT");
    await db.exec("BEGIN");
    assert.equal(await applyMigrations(adapter), false);
    await db.exec("COMMIT");
    assert.equal((await db.query("SELECT * FROM public.sicara_migrations")).rows.length, 5);
  } finally { await db.close(); }
});

test("fresh confirmed notes reserve once; duplicates roll back; disappeared or reorganized funds require review", async () => {
  const { db, loans, account } = await fixture();
  try {
    const loan = await loans.prepare(account.address, randomUUID(), address, 1_000_000n);
    await assert.rejects(loans.observe(loan.id, { tip: 109, stale: false, notes: [note] }), /allocation incomplete/);
    // Test fixture stands in for a future native-validated wallet allocation job.
    await db.query("UPDATE sicara.loans SET state='awaiting_deposit',deposit_address=$2 WHERE id=$1", [loan.id, address]);
    await assert.rejects(loans.observe(loan.id, { tip: 109, stale: true, notes: [note] }), /Fresh/);
    assert.equal(await loans.observe(loan.id, { tip: 108, stale: false, notes: [note] }), "confirming");
    assert.equal(await loans.observe(loan.id, { tip: 109, stale: false, notes: [note] }), "collateral_verified");
    assert.equal(await loans.observe(loan.id, { tip: 110, stale: false, notes: [note] }), "collateral_verified");
    assert.equal((await db.query("SELECT * FROM sicara.collateral_reservations")).rows.length, 1);
    await assert.rejects(loans.observe(loan.id, { tip: 111, stale: false, notes: [note, note] }), /Duplicate/);
    assert.equal((await loans.find(account.address, loan.id)).state, "collateral_verified");
    assert.equal(await loans.observe(loan.id, { tip: 112, stale: false, notes: [] }), "reorg_review");
    assert.equal(await loans.observe(loan.id, { tip: 113, stale: false, notes: [note] }), "reorg_review");
    assert.equal((await db.query("SELECT * FROM sicara.collateral_reservations")).rows.length, 1);
  } finally { await db.close(); }
});

test("underpayment waits, overpayment and expiry journal refunds without pretending to send", async () => {
  const { db, loans, account } = await fixture();
  try {
    const loan = await loans.prepare(account.address, randomUUID(), address, 1_000_000n);
    await db.query("UPDATE sicara.loans SET state='awaiting_deposit',deposit_address=$2 WHERE id=$1", [loan.id, address]);
    assert.equal(await loans.observe(loan.id, { tip: 109, stale: false, notes: [{ ...note, zatoshis: 500_000n }] }), "awaiting_deposit");
    assert.equal(await loans.observe(loan.id, { tip: 109, stale: false, notes: [ { ...note, zatoshis: 500_000n }, { ...note, index: 1, zatoshis: 600_000n } ] }), "refund_pending");
    const intents = await db.query<{ reason: string; txid: string | null }>("SELECT reason,txid FROM sicara.refund_intents");
    assert.equal(intents.rows[0].reason, "overpayment");
    assert.equal(intents.rows[0].txid, null);
    // No new eligibility after cancellation or expiry.
    await assert.rejects(loans.observe(loan.id, { tip: 109, stale: false, notes: [note] }), /identity conflicts/);
    const other = privateKeyToAccount(generatePrivateKey());
    const expired = await loans.prepare(other.address, randomUUID(), address, 1_000_000n);
    await db.query("UPDATE sicara.loans SET state='awaiting_deposit',deposit_address=$2,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id, address.replace("utest1", "utest12")]);
    assert.equal(await loans.observe(expired.id, { tip: 109, stale: false, notes: [] }), "refund_pending");
    assert.equal((await db.query<{ reason: string }>("SELECT reason FROM sicara.refund_intents WHERE loan_id=$1", [expired.id])).rows[0].reason, "expired");
  } finally { await db.close(); }
});

test("a note cannot move to another loan or change value; anonymous DB roles cannot read private tables", async () => {
  const { db, loans, account } = await fixture();
  try {
    const loan = await loans.prepare(account.address, randomUUID(), address, 1_000_000n);
    await db.query("UPDATE sicara.loans SET state='awaiting_deposit',deposit_address=$2 WHERE id=$1", [loan.id, address]);
    await loans.observe(loan.id, { tip: 109, stale: false, notes: [note] });
    const other = await loans.prepare(privateKeyToAccount(generatePrivateKey()).address, randomUUID(), address, 1_000_000n);
    await assert.rejects(db.query("INSERT INTO sicara.collateral_reservations(note_id,loan_id) VALUES($1,$2)", [`${note.txid}:ironwood:0`, other.id]));
    await assert.rejects(loans.observe(loan.id, { tip: 110, stale: false, notes: [{ ...note, zatoshis: 999_999n }] }), /identity conflicts/);
    await db.exec("CREATE ROLE anonymous_test; SET ROLE anonymous_test");
    try { await assert.rejects(db.query("SELECT * FROM sicara.sessions"), /permission denied/); }
    finally { await db.exec("RESET ROLE"); }
    await db.exec("GRANT USAGE ON SCHEMA sicara TO anonymous_test; GRANT SELECT ON sicara.sessions, sicara.loans TO anonymous_test; SET ROLE anonymous_test");
    try {
      assert.equal((await db.query("SELECT * FROM sicara.sessions")).rows.length, 0);
      assert.equal((await db.query("SELECT * FROM sicara.loans")).rows.length, 0);
    } finally { await db.exec("RESET ROLE"); }
    await db.exec("SET ROLE sicara_backend");
    try { await assert.rejects(db.query("DELETE FROM sicara.loans"), /permission denied/); }
    finally { await db.exec("RESET ROLE"); }
  } finally { await db.close(); }
});

test("sessions, reservations and immutable refund obligations survive a database restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sicara-db-"));
  let db = new PGlite(dir);
  try {
    await db.exec(migration);
    for (const file of ["002_wallet_worker.sql","003_collateral_authorizations.sql", "004_confirmed_borrow_retries.sql", "005_settlement_release.sql"]) await db.exec(readFileSync(new URL(`../services/database/migrations/${file}`, import.meta.url), "utf8"));
    const account = privateKeyToAccount(generatePrivateKey());
    const auth = new WalletAuth(db, origin);
    const challenge = await auth.challenge(account.address);
    const session = await auth.verify(challenge.id, await account.signMessage({ message: challenge.message }), challenge.browserToken);
    const loans = new LoanRepository(db);
    const loan = await loans.prepare(account.address, randomUUID(), address, 1_000_000n);
    await db.query("UPDATE sicara.loans SET state='awaiting_deposit',deposit_address=$2 WHERE id=$1", [loan.id, address]);
    await loans.observe(loan.id, { tip: 109, stale: false, notes: [note] });
    await loans.cancel(account.address, loan.id);
    await db.close();
    db = new PGlite(dir);
    assert.equal((await new WalletAuth(db, origin).session(session.token))?.wallet, account.address.toLowerCase());
    assert.equal((await new LoanRepository(db).find(account.address, loan.id)).state, "refund_pending");
    assert.equal((await db.query("SELECT * FROM sicara.refund_intents")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM sicara.collateral_reservations")).rows.length, 1);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

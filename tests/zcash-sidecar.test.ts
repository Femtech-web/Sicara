import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TestnetWallet, OutcomeUnknownError } from "../services/zcash/sidecar-client";
import { SidecarWorkerWallet, refundMemo } from "../services/zcash/worker-wallet";
const binary = resolve("tests/fixtures/zec-sidecar.mjs");

test("testnet-only client correlates responses and reads wallet-owned deposits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sicara-sidecar-test-"));
  const wallet = await TestnetWallet.start({ binary, dataDir: directory, startupTimeoutMs: 2000 });
  try {
    assert.match(await wallet.address(), /^utest1/);
    assert.deepEqual(await wallet.deposits(), { notes: [], tip: 109, stale: false });
  } finally { await wallet.close(); await rm(directory, { recursive: true, force: true }); }
});

test("worker adapter requires a fully current scan and preserves the refund memo across stdio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sicara-worker-adapter-"));
  const wallet = await TestnetWallet.start({ binary, dataDir: directory, startupTimeoutMs: 2000 });
  try {
    const adapter = new SidecarWorkerWallet(wallet, "unused-offline-validator");
    assert.deepEqual(await adapter.scan(), { notes: [], tip: 109, stale: false });
    assert.equal(await adapter.spendable(), 100_000_000n);
    assert.deepEqual(await adapter.sent(), { payments: [], tip: 109 });
    const id = "8a222222-3333-4444-8888-111111111111";
    assert.equal(refundMemo(id).length, 1024);
    await assert.rejects(adapter.sendRefund(await wallet.address(), 100n, id), OutcomeUnknownError);
  } finally { await wallet.close(); await rm(directory, { recursive: true, force: true }); }
});

test("worker adapter rejects an old sync even when poll reports stale=false", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sicara-worker-adapter-"));
  const wallet = await TestnetWallet.start({ binary, dataDir: join(directory, "stale"), startupTimeoutMs: 2000 });
  try { await assert.rejects(new SidecarWorkerWallet(wallet, "unused").scan(), /stale/); }
  finally { await wallet.close(); await rm(directory, { recursive: true, force: true }); }
});
test("client rejects a sidecar reporting mainnet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sicara-sidecar-test-"));
  try { await assert.rejects(TestnetWallet.start({ binary, dataDir: join(directory, "wrong-network"), startupTimeoutMs: 2000 })); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test("a sidecar crash during send becomes outcome-unknown rather than a safe retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sicara-sidecar-test-"));
  const wallet = await TestnetWallet.start({ binary, dataDir: directory, startupTimeoutMs: 2000 });
  try {
    const recipient = await wallet.address();
    await assert.rejects(wallet.sendTestnet(recipient, 1n), OutcomeUnknownError);
    await assert.rejects(wallet.sendTestnet(recipient, 1n));
  } finally { await wallet.close(); await rm(directory, { recursive: true, force: true }); }
});

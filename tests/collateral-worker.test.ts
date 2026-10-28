import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Database } from "../services/database/types";
import { LoanRepository } from "../src/features/lending/server/loan-repository";
import { CollateralWorker } from "../services/zcash/collateral-worker";
import { OperationJournal, type Operation } from "../services/zcash/operation-journal";
import { returnMemo, type SentPayment, type WorkerWallet } from "../services/zcash/worker-wallet";
import type { DepositSnapshot } from "../services/zcash/protocol";
import {ReleaseWorker} from "../services/settlement/release-worker";
import {SettlementMismatch,type SettlementVerifier} from "../services/settlement/sepolia-settlement";
import { IssuanceTransactions } from "../services/issuance/transaction-repository";
import { AuthorizationRepository } from "../services/issuance/authorization-repository";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const custody = "utest15re965qrdvxun9399eps75cca8n9cakfh6anznck7evwrdsvusj00r2kpr9eddzvadex8xx4yrlnk5ahemu0jf495yhz5zz7eqglrjmm";
const recipient = "utest1lkt9l7y7u48dtv54uwgc7fnt9zx7yaxnyn8mu3x5kzsh839cpl545z7j3g0u863u54x0a5svfea2uru6mm7x8lm4670ygpeeysspvpjq";
const walletOwner = "0xcc886a72f79baed0098432704a65373f52131c54";

// Explicit protocol fixture: synthetic addresses/notes/sends, no cryptography or network.
class FakeWallet implements WorkerWallet {
  allocations = 0;
  sends: { kind?:"refund"|"release"; id: string; destination: string; amount: bigint; txid: string }[] = [];
  payments: SentPayment[] = [];
  snapshot: DepositSnapshot = { tip: 109, stale: false, notes: [] };
  funds = 100_000_000n;
  loseSendResponse = false;
  shielded = true;
  async address() { return custody; }
  async validate(address: string) {
    if (address.includes("invalid")) throw new Error("Fixture invalid receiver");
    return address;
  }
  async newAddress() { this.allocations++; return "utest1" + "q".repeat(98) + "23456789"[this.allocations - 1]; }
  async scan() { return this.snapshot; }
  async sent() { return { tip: this.snapshot.tip, payments: this.payments }; }
  async spendable() { return this.funds; }
  async inspectShielded() { return this.shielded; }
  async sendRefund(destination: string, amount: bigint, id: string) {
    const txid = (this.sends.length + 100).toString(16).padStart(64, "0");
    this.sends.push({ id, destination, amount, txid });
    if (this.loseSendResponse) throw new Error("Response lost after broadcast");
    return txid;
  }
  async sendRelease(destination:string,amount:bigint,id:string){try{return await this.sendRefund(destination,amount,id);}finally{const send=this.sends.at(-1);if(send?.id===id)send.kind="release";}}
  fund(address: string, amount: bigint, height: number | null = 100) {
    this.snapshot.notes.push({ txid: (this.snapshot.notes.length + 1).toString(16).padStart(64, "0"), index: 0, height, address, zatoshis: amount, valuePool: "ironwood", source: "wallet" });
  }
  mineLast(height = 100) {
    const send = this.sends.at(-1)!;
    this.payments.push({ txid: send.txid, height, destination: send.destination, amount: send.amount, memo: returnMemo(send.id,send.kind??"refund") });
  }
}

async function fixture(journalFactory?: (dir: string) => OperationJournal, owner = walletOwner) {
  const dir = await mkdtemp(join(tmpdir(), "sicara-worker-"));
  let raw = new PGlite(join(dir, "postgres"));
  for (const file of ["001_wallet_loans.sql", "002_wallet_worker.sql", "003_collateral_authorizations.sql", "004_confirmed_borrow_retries.sql", "005_settlement_release.sql"]) await raw.exec(await readFile(resolve("services/database/migrations", file), "utf8"));
  const db: Database = {
    query: (text, values) => db.transaction(sql => sql.query(text, values)),
    transaction: run => raw.transaction(async sql => { await sql.query("SET LOCAL ROLE sicara_worker"); return run(sql); }),
  };
  const wallet = new FakeWallet();
  const journalDir = join(dir, "journal");
  const journal = journalFactory?.(journalDir) ?? new OperationJournal(journalDir);
  const worker = new CollateralWorker(db, wallet, journal);
  await worker.initialize();
  const loans = new LoanRepository(db);
  const create = () => loans.prepare(owner, randomUUID(), recipient, 1_000_000n);
  const state = async (id: string) => (await loans.find(owner, id)).state;
  const allocated = async () => {
    const loan = await create();
    await worker.tick();
    const saved = await loans.find(owner, loan.id);
    assert(saved.deposit_address);
    return saved;
  };
  return { dir, get raw() { return raw; }, db, wallet, journal, worker, loans, create, allocated, state,
    reopenDatabase: async () => { await raw.close(); raw = new PGlite(join(dir, "postgres")); },
    restart: async () => {
      const restarted = new CollateralWorker(db, wallet, new OperationJournal(journalDir));
      await restarted.initialize();
      return restarted;
    },
    close: async () => { await raw.close(); await rm(dir, { recursive: true, force: true }); },
  };
}


test("allocation is persisted once and a restarted worker keeps the same per-loan address", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    const worker = await f.restart();
    await worker.tick();
    assert.equal(f.wallet.allocations, 1);
    assert.equal((await f.loans.find(walletOwner, loan.id)).deposit_address, loan.deposit_address);
    assert.equal((await stat(join(f.dir, "journal", `allocation-${loan.id}.json`))).mode & 0o777, 0o600);
    await f.raw.exec("SET ROLE sicara_backend");
    try { await assert.rejects(f.raw.query("SELECT * FROM sicara.refund_payments"), /permission denied/); }
    finally { await f.raw.exec("RESET ROLE"); }
  } finally { await f.close(); }
});

test("saved allocation response survives a DB interruption without another derivation", async () => {
  let failed = false;
  const f = await fixture(dir => new class extends OperationJournal {
    override async save(key: string, operation: Operation) {
      await super.save(key, operation);
      if (!failed && operation.state === 'allocated') { failed = true; throw new Error("Simulated DB interruption"); }
    }
  }(dir));
  try {
    const loan = await f.create();
    await assert.rejects(f.worker.tick(), /interruption/);
    const restarted = await f.restart();
    await restarted.tick();
    assert.equal(f.wallet.allocations, 1);
    assert.equal(await f.state(loan.id), "awaiting_deposit");
  } finally { await f.close(); }
});

test("lost derivation response blocks allocation and never hands out a guessed replacement", async () => {
  let failed = false;
  const f = await fixture(dir => new class extends OperationJournal {
    override async save(key: string, operation: Operation) {
      if (!failed && operation.state === 'allocated') { failed = true; throw new Error("Lost address response"); }
      await super.save(key, operation);
    }
  }(dir));
  try {
    const loan = await f.create();
    await assert.rejects(f.worker.tick());
    await (await f.restart()).tick();
    await f.worker.tick();
    assert.equal(f.wallet.allocations, 1);
    assert.equal((await f.loans.find(walletOwner, loan.id)).deposit_address, null);
    assert.equal((await f.db.query<{ state: string }>("SELECT state FROM sicara.address_allocations WHERE loan_id=$1", [loan.id])).rows[0].state, 'review');
  } finally { await f.close(); }
});

test("cancelled pre-issuance collateral refunds exactly once after ten confirmations", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    f.wallet.fund(loan.deposit_address!, 1_000_000n, 101);
    await f.loans.cancel(walletOwner, loan.id);
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 0); // nine confirmations
    f.wallet.snapshot.tip = 110;
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 1);
    assert.equal(f.wallet.sends[0].destination, recipient);
    assert.equal(f.wallet.sends[0].amount, 1_000_000n);
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 1); // broadcast is not completion
    assert.equal(await f.state(loan.id), "refund_pending");
    f.wallet.mineLast(101);
    await f.worker.tick();
    await (await f.restart()).tick();
    assert.equal(await f.state(loan.id), "refunded");
    assert.equal(f.wallet.sends.length, 1);
  } finally { await f.close(); }
});

test("lost send response is reconciled by its encrypted memo and never sent twice", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    f.wallet.fund(loan.deposit_address!, 1_000_000n);
    await f.loans.cancel(walletOwner, loan.id);
    f.wallet.loseSendResponse = true;
    await f.worker.tick();
    await f.reopenDatabase();
    const restarted = await f.restart();
    await restarted.tick();
    assert.equal(f.wallet.sends.length, 1);
    assert.equal((await f.db.query<{ state: string }>("SELECT state FROM sicara.refund_payments")).rows[0].state, "submitting");
    f.wallet.mineLast();
    await restarted.tick();
    await restarted.tick();
    assert.equal(await f.state(loan.id), "refunded");
    assert.equal(f.wallet.sends.length, 1);
  } finally { await f.close(); }
});

test("operator fee shortage and stale scans cannot spend customer principal", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    f.wallet.fund(loan.deposit_address!, 1_000_000n);
    await f.loans.cancel(walletOwner, loan.id);
    f.wallet.funds = 1_000_001n;
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 0);
    f.wallet.funds = 100_000_000n;
    f.wallet.snapshot.stale = true;
    await assert.rejects(f.worker.tick(), /stale/);
    assert.equal(f.wallet.sends.length, 0);
  } finally { await f.close(); }
});

test("late funds on a closed address refund separately without taking the newer loan's wallet slot", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    await f.loans.cancel(walletOwner, loan.id);
    await f.worker.tick();
    assert.equal(await f.state(loan.id), "refunded");
    const newer = await f.create();
    f.wallet.fund(loan.deposit_address!, 500_000n);
    await f.worker.tick();
    assert.equal(await f.state(newer.id), "awaiting_deposit");
    assert.equal(await f.state(loan.id), "late_refund_pending");
    assert.equal(f.wallet.sends.length, 1);
    f.wallet.mineLast();
    await f.worker.tick();
    await f.worker.tick();
    assert.equal(await f.state(loan.id), "refunded");
    assert.equal(await f.state(newer.id), "awaiting_deposit");
  } finally { await f.close(); }
});

test("overpayment returns all principal in bounded installments; contradictory or reorged receipts stop spending", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    f.wallet.fund(loan.deposit_address!, 1_500_000n);
    await f.worker.tick();
    assert.equal(f.wallet.sends[0].amount, 1_000_000n);
    f.wallet.mineLast();
    await f.worker.tick();
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 2);
    assert.equal(f.wallet.sends[1].amount, 500_000n);
    f.wallet.mineLast();
    await f.worker.tick();
    await f.worker.tick();
    assert.equal(await f.state(loan.id), "refunded");
    f.wallet.payments.shift(); // a previously confirmed return is reorganized out
    await f.worker.tick();
    assert.equal(await f.state(loan.id), "late_refund_pending");
    assert.equal((await f.db.query<{ state: string }>("SELECT state FROM sicara.refund_payments ORDER BY sequence")).rows[0].state, "review");
    assert.equal(f.wallet.sends.length, 2);
  } finally { await f.close(); }
});

test("a mismatched destination or non-shielded transaction cannot confirm a refund", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    f.wallet.fund(loan.deposit_address!, 1_000_000n);
    await f.loans.cancel(walletOwner, loan.id);
    await f.worker.tick();
    f.wallet.mineLast();
    f.wallet.shielded = false;
    await f.worker.tick();
    assert.equal((await f.db.query<{ state: string }>("SELECT state FROM sicara.refund_payments")).rows[0].state, 'review');
    assert.equal(await f.state(loan.id), "refund_pending");
    assert.equal(f.wallet.sends.length, 1);
  } finally { await f.close(); }
});

test("expired underpayment is returned in full rather than stranded below the requested amount", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    f.wallet.fund(loan.deposit_address!, 10_000n);
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 0);
    await f.db.query("UPDATE sicara.loans SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [loan.id]);
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 1);
    assert.equal(f.wallet.sends[0].amount, 10_000n);
  } finally { await f.close(); }
});

test("an unfunded request that expires before allocation closes without generating an address", async () => {
  const f = await fixture();
  try {
    const loan = await f.create();
    await f.db.query("UPDATE sicara.loans SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [loan.id]);
    await f.worker.tick();
    assert.equal(await f.state(loan.id), "refunded");
    assert.equal(f.wallet.allocations, 0);
    assert.equal(f.wallet.sends.length, 0);
  } finally { await f.close(); }
});

test("wallet/database mismatch and a restored DB missing journalled operations halt initialization", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated();
    f.wallet.address = async () => recipient;
    await assert.rejects(f.restart(), /different custody wallet/);
    f.wallet.address = async () => custody;
    await f.raw.query("DELETE FROM sicara.address_allocations WHERE loan_id=$1", [loan.id]);
    await assert.rejects(f.restart(), /operations missing/);
  } finally { await f.close(); }
});

test("one uncertain refund pauses new sends for other loans on the same custody wallet", async () => {
  const f = await fixture();
  try {
    const first = await f.allocated();
    f.wallet.fund(first.deposit_address!, 1_000_000n);
    await f.loans.cancel(walletOwner, first.id);
    f.wallet.loseSendResponse = true;
    await f.worker.tick();
    const otherOwner = "0x1111111111111111111111111111111111111111";
    const second = await f.loans.prepare(otherOwner, randomUUID(), recipient, 1_000_000n);
    await f.worker.tick();
    const address = (await f.loans.find(otherOwner, second.id)).deposit_address!;
    f.wallet.fund(address, 1_000_000n);
    await f.loans.cancel(otherOwner, second.id);
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 1);
    f.wallet.mineLast();
    f.wallet.loseSendResponse = false;
    await f.worker.tick();
    assert.equal(f.wallet.sends.length, 2);
  } finally { await f.close(); }
});

test("authorization freezes confirmed collateral before signing and persists immutable terms across restart", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated(); f.wallet.fund(loan.deposit_address!, 1_000_000n); await f.worker.tick();
    const repo = new AuthorizationRepository(f.db);
    const pool = '0x' + '1'.repeat(40);
    const authorization = await repo.reserve(loan.id, pool, 120);
    assert.equal(authorization.capacity_units, '50000000');
    assert.equal(await f.state(loan.id), 'issuance_pending');
    assert.equal(authorization.state, 'reserved');
    assert(Number(authorization.valid_until) - Date.now()/1000 < 121);
    await assert.rejects(f.loans.cancel(walletOwner, loan.id), /cannot be cancelled/);
    await assert.rejects(f.db.query("INSERT INTO sicara.refund_intents(loan_id,destination,reason) VALUES($1,$2,'cancelled')", [loan.id,recipient]), /cannot enter/);
    await assert.rejects(f.db.query("UPDATE sicara.loans SET state='refund_pending' WHERE id=$1", [loan.id]), /remains frozen/);
    await f.reopenDatabase();
    const reopened = new AuthorizationRepository(f.db);
    assert.equal((await reopened.reserve(loan.id, pool)).deposit_commitment, authorization.deposit_commitment);
    await assert.rejects(reopened.reserve(loan.id, '0x'+'2'.repeat(40)), /another deployment/);
    await assert.rejects(f.db.query("UPDATE sicara.collateral_authorizations SET capacity_units=1 WHERE loan_id=$1", [loan.id]), /immutable/);
  } finally { await f.close(); }
});

test("authorization refuses pending, cancelled, stale or contradictory collateral", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated(); const repo = new AuthorizationRepository(f.db); const pool='0x'+'1'.repeat(40);
    await assert.rejects(repo.reserve(loan.id,pool), /Confirmed/);
    f.wallet.fund(loan.deposit_address!,1_000_000n); await f.worker.tick();
    await f.db.query("UPDATE sicara.wallet_worker SET scanned_at=clock_timestamp()-interval '1 minute'");
    await assert.rejects(repo.reserve(loan.id,pool), /Fresh/);
    await f.worker.tick(); await f.loans.cancel(walletOwner,loan.id);
    await assert.rejects(repo.reserve(loan.id,pool), /Confirmed/);
    assert.equal((await f.db.query('SELECT * FROM sicara.collateral_authorizations')).rows.length,0);
  } finally { await f.close(); }
});

test("signed capacity proof cannot change and unrelated signatures are refused", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated(); f.wallet.fund(loan.deposit_address!,1_000_000n); await f.worker.tick();
    const repo = new AuthorizationRepository(f.db); const attestor=privateKeyToAccount(generatePrivateKey());
    await repo.reserve(loan.id,'0x'+'1'.repeat(40));
    await repo.prepare(loan.id,('0x'+'a'.repeat(64)) as `0x${string}`,'0x1234');
    const row=await repo.get(loan.id); const typed=repo.typedData(row);
    const wrong=await privateKeyToAccount(generatePrivateKey()).signTypedData(typed);
    await assert.rejects(repo.saveSignature(loan.id,wrong,attestor.address), /Invalid attestor/);
    const signature=await attestor.signTypedData(typed); await repo.saveSignature(loan.id,signature,attestor.address);
    assert.equal((await repo.get(loan.id)).state,'signed');
    await assert.rejects(repo.prepare(loan.id,('0x'+'b'.repeat(64)) as `0x${string}`,'0xabcd'), /already prepared/);
    await assert.rejects(f.db.query("UPDATE sicara.collateral_authorizations SET input_proof='0xabcd' WHERE loan_id=$1", [loan.id]), /immutable/);
  } finally { await f.close(); }
});

test("expiry, late overpayment and reorg after authorization never reopen refunds or issuance", async () => {
  const f = await fixture();
  try {
    const loan = await f.allocated(); f.wallet.fund(loan.deposit_address!,1_000_000n); await f.worker.tick();
    const repo=new AuthorizationRepository(f.db); await repo.reserve(loan.id,'0x'+'1'.repeat(40));
    await f.db.query("UPDATE sicara.loans SET expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[loan.id]);
    f.wallet.fund(loan.deposit_address!,1n); await (await f.restart()).tick();
    assert.equal(await f.state(loan.id),'issuance_pending'); assert.equal(f.wallet.sends.length,0);
    f.wallet.snapshot.notes=[]; await f.worker.tick();
    assert.equal(await f.state(loan.id),'issuance_review');
    await assert.rejects(f.loans.cancel(walletOwner,loan.id), /cannot be cancelled/);
    await assert.rejects(repo.prepare(loan.id,('0x'+'a'.repeat(64)) as `0x${string}`,'0x1234'), /frozen/);
    assert.equal((await f.db.query('SELECT * FROM sicara.refund_intents')).rows.length,0);
  } finally { await f.close(); }
});

test("signed Sepolia intents survive restart, reject changed bytes/domain and pin canonical receipts", async () => {
  const signer=privateKeyToAccount(generatePrivateKey());const f=await fixture(undefined,signer.address.toLowerCase());
  try {
    const loan=await f.allocated();f.wallet.fund(loan.deposit_address!,1_000_000n);await f.worker.tick();
    const pool=('0x'+'1'.repeat(40)) as `0x${string}`;const authorizations=new AuthorizationRepository(f.db);await authorizations.reserve(loan.id,pool);
    await authorizations.prepare(loan.id,('0x'+'a'.repeat(64)) as `0x${string}`,'0x1234');
    const typed=authorizations.typedData(await authorizations.get(loan.id));
    await authorizations.saveSignature(loan.id,await signer.signTypedData(typed),signer.address);
    const txs=new IssuanceTransactions(f.db);
    const transaction={type:'eip1559' as const,chainId:11155111,to:pool,data:'0x1234' as `0x${string}`,value:0n,nonce:1,gas:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n};
    const raw=await signer.signTransaction(transaction);
    await assert.rejects(txs.prepare(loan.id,'register',raw,'0xabcd'),/binding mismatch/);
    const wrongChain=await signer.signTransaction({...transaction,chainId:1});
    await assert.rejects(txs.prepare(loan.id,'register',wrongChain,'0x1234'),/binding mismatch/);
    const first=await txs.prepare(loan.id,'register',raw,'0x1234');
    await f.reopenDatabase();const reopened=new IssuanceTransactions(f.db);
    assert.equal((await reopened.get(loan.id,'register'))!.raw_transaction,raw);
    const replacement=await signer.signTransaction({...transaction,nonce:2});
    await assert.rejects(reopened.prepare(loan.id,'register',replacement,'0x1234'),/already prepared/);
    const blockHash=('0x'+'b'.repeat(64)) as `0x${string}`;
    await reopened.confirm(loan.id,'register',first.tx_hash,100,blockHash);
    await assert.rejects(reopened.confirm(loan.id,'register',first.tx_hash,101,('0x'+'c'.repeat(64)) as `0x${string}`),/Receipt changed/);
    assert.equal((await reopened.get(loan.id,'register'))!.block_hash,blockHash);
  }finally{await f.close();}
});

test("a wallet journal with an issuance missing from a restored DB blocks worker startup", async () => {
  const f=await fixture();
  try{
    const loan=await f.allocated();f.wallet.fund(loan.deposit_address!,1_000_000n);await f.worker.tick();
    const row=await new AuthorizationRepository(f.db).reserve(loan.id,'0x'+'1'.repeat(40));
    await f.journal.bind(`issuance-${loan.id}`,{kind:'issuance',loan:loan.id,pool:row.pool,commitment:row.deposit_commitment});
    await f.raw.query('DELETE FROM sicara.collateral_authorizations WHERE loan_id=$1',[loan.id]);
    await assert.rejects(f.restart(),/missing from the database/);
  }finally{await f.close();}
});

test("only a recorded canonical failed borrow permits a bounded new attempt; unknown intent cannot be replaced",async()=>{
  const signer=privateKeyToAccount(generatePrivateKey());const f=await fixture(undefined,signer.address.toLowerCase());
  try{
    const loan=await f.allocated();f.wallet.fund(loan.deposit_address!,1_000_000n);await f.worker.tick();
    const repo=new AuthorizationRepository(f.db);const pool=('0x'+'1'.repeat(40)) as `0x${string}`;
    await repo.reserve(loan.id,pool);await repo.prepare(loan.id,('0x'+'a'.repeat(64)) as `0x${string}`,'0x1234');
    await repo.saveSignature(loan.id,await signer.signTypedData(repo.typedData(await repo.get(loan.id))),signer.address);
    await f.db.query("UPDATE sicara.collateral_authorizations SET state='registered' WHERE loan_id=$1",[loan.id]);
    await f.db.query("UPDATE sicara.loans SET state='issuance_registered' WHERE id=$1",[loan.id]);
    const txs=new IssuanceTransactions(f.db);
    const transaction={type:'eip1559' as const,chainId:11155111,to:pool,data:'0x1234' as `0x${string}`,value:0n,nonce:1,gas:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n};
    const first=await txs.prepare(loan.id,'borrow',await signer.signTransaction(transaction),'0x1234');
    const secondRaw=await signer.signTransaction({...transaction,nonce:2});
    await assert.rejects(txs.prepare(loan.id,'borrow',secondRaw,'0x1234'),/already prepared/);
    await txs.failedBorrow(loan.id,first.tx_hash,100,('0x'+'b'.repeat(64)) as `0x${string}`);
    const second=await txs.prepare(loan.id,'borrow',secondRaw,'0x1234');assert.equal(second.attempt,2);
    const history=await f.db.query('SELECT state FROM sicara.sepolia_transactions WHERE loan_id=$1 ORDER BY attempt',[loan.id]);
    assert.deepEqual(history.rows.map(row=>row.state),['failed','prepared']);
    await assert.rejects(f.db.query("UPDATE sicara.sepolia_transactions SET state='prepared' WHERE loan_id=$1 AND attempt=1",[loan.id]),/immutable/);
  }finally{await f.close();}
});

async function releaseFixture(){
 const f=await fixture();const loan=await f.allocated();f.wallet.fund(loan.deposit_address!,1_000_000n);await f.worker.tick();
 const repo=new AuthorizationRepository(f.db);const attestor=privateKeyToAccount(generatePrivateKey());
 await repo.reserve(loan.id,'0x'+'1'.repeat(40));await repo.prepare(loan.id,('0x'+'a'.repeat(64)) as `0x${string}`,'0x1234');
 await repo.saveSignature(loan.id,await attestor.signTypedData(repo.typedData(await repo.get(loan.id))),attestor.address);
 await f.db.query("UPDATE sicara.collateral_authorizations SET state='registered',registration_tx=$2,registration_block_hash=$3 WHERE loan_id=$1",[loan.id,'0x'+'a'.repeat(64),'0x'+'b'.repeat(64)]);
 await f.db.query("UPDATE sicara.loans SET state='issuance_registered' WHERE id=$1",[loan.id]);
 let status:'pending'|'settled'|'reorg'|'offline'='pending';
 const verifier:SettlementVerifier={verify:async binding=>{
   if(status==='offline')throw new Error('RPC offline');
   if(status==='reorg')throw new SettlementMismatch('Canonical receipt changed');
   return status==='settled'?{tx:binding.settlement_tx,block:100,blockHash:('0x'+'d'.repeat(64)) as `0x${string}`}:null;
 }};
 const worker=()=>new ReleaseWorker(f.db,f.wallet,f.journal,verifier);
 const release=worker();await release.track(loan.id,('0x'+'c'.repeat(64)) as `0x${string}`);
 return {...f,loan,release,worker,setStatus:(value:typeof status)=>{status=value;}};
}

test('partial/unsettled repayment or unavailable finality never releases collateral',async()=>{
 const f=await releaseFixture();try{
  await f.release.tick();assert.equal(f.wallet.sends.length,0);
  assert.equal((await f.db.query('SELECT * FROM sicara.release_payments')).rows.length,0);
  f.setStatus('offline');await assert.rejects(f.release.tick(),/RPC offline/);assert.equal(f.wallet.sends.length,0);
  await assert.rejects(f.loans.cancel(walletOwner,f.loan.id),/cannot be cancelled/);
 }finally{await f.close();}
});

test('settlement-authorized shielded release recovers a lost send response after restart without duplicate sends',async()=>{
 const f=await releaseFixture();try{
  f.setStatus('settled');f.wallet.loseSendResponse=true;await f.release.tick();
  assert.equal(f.wallet.sends.length,1);assert.equal(f.wallet.sends[0].kind,'release');
  await f.reopenDatabase();f.wallet.mineLast();
  await f.worker().tick();await f.worker().tick();await f.worker().tick();
  assert.equal(await f.state(f.loan.id),'released');assert.equal(f.wallet.sends.length,1);
  assert.equal((await f.db.query("SELECT state FROM sicara.release_payments")).rows[0].state,'confirmed');
  await assert.rejects(f.release.track(f.loan.id,('0x'+'e'.repeat(64)) as `0x${string}`),/immutable/);
 }finally{await f.close();}
});

test('a reorged settlement or disappeared confirmed shielded release freezes recovery and cannot pay again',async()=>{
 const f=await releaseFixture();try{
  f.setStatus('settled');await f.release.tick();f.wallet.mineLast();await f.release.tick();await f.release.tick();
  assert.equal(await f.state(f.loan.id),'released');f.wallet.payments=[];await f.release.tick();
  assert.equal(await f.state(f.loan.id),'release_review');assert.equal(f.wallet.sends.length,1);
  f.setStatus('settled');await f.worker().tick();assert.equal(f.wallet.sends.length,1);
 }finally{await f.close();}
 const g=await releaseFixture();try{g.setStatus('reorg');await g.release.tick();assert.equal(await g.state(g.loan.id),'release_review');assert.equal(g.wallet.sends.length,0);}finally{await g.close();}
});

test('release requires bound receiver, full principal and separate operator fees',async()=>{
 const f=await releaseFixture();try{
  f.setStatus('settled');f.wallet.funds=1_000_000n;await f.release.tick();assert.equal(f.wallet.sends.length,0);
  f.wallet.funds=100_000_000n;f.wallet.snapshot.notes[0].height=105;await f.release.tick();assert.equal(await f.state(f.loan.id),'release_review');assert.equal(f.wallet.sends.length,0);
 }finally{await f.close();}
});

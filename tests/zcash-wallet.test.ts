import assert from 'node:assert/strict';
import test from 'node:test';
import { ZcashWalletSession, testnetUnifiedAddress, type ZcashProvider } from '../src/features/zcash/model/wallet-session';
const address = 'utest15re965qrdvxun9399eps75cca8n9cakfh6anznck7evwrdsvusj00r2kpr9eddzvadex8xx4yrlnk5ahemu0jf495yhz5zz7eqglrjmm';
class Provider implements ZcashProvider {
  disconnect?: () => Promise<void>;
  calls: string[] = []; handlers = new Map<string, (...args: unknown[]) => void>();
  response: unknown = { shielded: address }; pending?: Promise<unknown>;
  async request({ method }: { method: string }) { this.calls.push(method); return this.pending ?? this.response; }
  on(event: string, listener: (...args: unknown[]) => void) { this.handlers.set(event, listener); }
  removeListener(event: string) { this.handlers.delete(event); }
}
test('Zcash connection validates the testnet UA checksum without interpreting receiver capabilities', () => {
  assert.equal(testnetUnifiedAddress(address), address);
  for (const value of [address.slice(0, -1) + 'q', address.replace('utest1', 'u1'), 'tmSynthetic', address.toUpperCase(), { shielded: address }]) assert.throws(() => testnetUnifiedAddress(value));
});
test('injected connection requests accounts only; chain changes clear the session and events', async () => {
  const provider = new Provider(), session = new ZcashWalletSession();
  await session.connect(provider); assert.equal(session.getSnapshot().address, address);
  assert.deepEqual(provider.calls, ['zcash_requestAccounts']);
  provider.handlers.get('accountsChanged')?.({ shielded: 'u1mainnet' });
  assert.equal(session.getSnapshot().status, 'disconnected');
  provider.handlers.get('accountsChanged')?.({ shielded: address });
  assert.equal(session.getSnapshot().status, 'connected');
  provider.handlers.get('chainChanged')?.({ network: 'mainnet' });
  assert.equal(session.getSnapshot().status, 'disconnected'); assert.equal(provider.handlers.size, 0);
});
test('a delayed account response cannot reconnect after explicit disconnect, and malformed responses fail closed', async () => {
  const provider = new Provider(), session = new ZcashWalletSession();
  let resolve!: (value: unknown) => void;
  provider.pending = new Promise(done => { resolve = done; });
  const connecting = session.connect(provider);
  // A nonblocking mock disconnect models a real provider's independent RPC.
  provider.disconnect = async () => {};
  await session.disconnect(); resolve({ shielded: address }); await connecting;
  assert.equal(session.getSnapshot().status, 'disconnected'); assert.equal(provider.handlers.size, 0);
  provider.pending = undefined; provider.response = { shielded: 'u1mainnet' }; await session.connect(provider);
  assert.equal(session.getSnapshot().status, 'disconnected'); assert.ok(session.getSnapshot().error);
});

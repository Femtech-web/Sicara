/** Minimal injected Noir connector, based on upstream RPC documentation at
 * NoirWallet/zcash-wallet-adapter 2fc3f965c48153b467e204ad89b01dbd97cc91a6.
 * Connection state only: never requests balances, viewing keys or signatures,
 * never submits a payment and never sends an address to Sicara's backend.
 */
export interface ZcashProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  disconnect?(): Promise<void>;
}
type Snapshot = Readonly<{ status: 'disconnected' | 'connecting' | 'connected'; address?: string; error?: string }>;
export const disconnectedZcash: Snapshot = Object.freeze({ status: 'disconnected' });

/** UA network/checksum check only; receiver capabilities require native decoding.
 * Never use a connected address as collateral proof or as a validated receiver.
 */
export function testnetUnifiedAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 512 || value !== value.toLowerCase() || !value.startsWith('utest1')) throw new Error('Use a Zcash testnet wallet with a Unified Address. Mainnet wallets cannot switch through this app.');
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const hrp = 'utest';
  const data = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
  for (const c of value.slice(6)) { const n = alphabet.indexOf(c); if (n < 0) throw new Error('The wallet returned an invalid testnet address.'); data.push(n); }
  let checksum = 1;
  for (const n of data) {
    const high = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ n;
    for (let i = 0; i < 5; i++) if ((high >>> i) & 1) checksum ^= generators[i];
  }
  if ((checksum >>> 0) !== 0x2bc830a3) throw new Error('The wallet returned an invalid address checksum.');
  return value;
}

export class ZcashWalletSession {
  private snapshot: Snapshot = disconnectedZcash;
  private listeners = new Set<() => void>();
  private provider?: ZcashProvider;
  private generation = 0;
  private bindings: [string, (...args: unknown[]) => void][] = [];
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Snapshot) { this.snapshot = next; for (const listener of this.listeners) listener(); }
  private unbind() { for (const [event, listener] of this.bindings) this.provider?.removeListener?.(event, listener); this.bindings = []; }
  private address(result: unknown) { return testnetUnifiedAddress(result && typeof result === 'object' && 'shielded' in result ? result.shielded : undefined); }
  async connect(provider: ZcashProvider) {
    if (this.snapshot.status === 'connecting') return;
    this.unbind(); this.provider = provider; const generation = ++this.generation;
    this.publish({ status: 'connecting' });
    const changed = (...args: unknown[]) => {
      ++this.generation;
      try { this.publish({ status: 'connected', address: this.address(args[0]) }); }
      catch { this.publish({ status: 'disconnected', error: 'Wallet account changed or is not a shielded testnet account. Reconnect on Zcash Testnet.' }); }
    };
    const invalidate = () => { ++this.generation; this.unbind(); this.provider = undefined; this.publish(disconnectedZcash); };
    this.bindings = [['accountsChanged', changed], ['chainChanged', invalidate], ['disconnect', invalidate]];
    for (const [event, listener] of this.bindings) provider.on(event, listener);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        provider.request({ method: 'zcash_requestAccounts' }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Wallet request timed out')), 60_000); }),
      ]);
      if (generation !== this.generation || this.provider !== provider) return;
      this.publish({ status: 'connected', address: this.address(result) });
    } catch {
      if (generation !== this.generation) return;
      this.unbind(); this.provider = undefined;
      this.publish({ status: 'disconnected', error: 'Zcash connection was not completed. Approve access in the testnet Noir extension and check that it returns a valid testnet Unified Address.' });
    } finally { clearTimeout(timeout); }
  }
  async disconnect() {
    const provider = this.provider; const generation = ++this.generation; this.unbind(); this.provider = undefined; this.publish(disconnectedZcash);
    if (!provider) return;
    try { if (provider.disconnect) await provider.disconnect(); else await provider.request({ method: 'zcash_disconnect' }); }
    catch { if (this.generation === generation) this.publish({ status: 'disconnected', error: 'Disconnected in Sicara. If access remains listed in the wallet, revoke it there.' }); }
  }
}

export const zcashWallet = new ZcashWalletSession();

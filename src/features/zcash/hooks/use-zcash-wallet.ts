"use client";
import { useSyncExternalStore } from 'react';
import { disconnectedZcash, zcashWallet, type ZcashProvider } from '../model/wallet-session';

export function useZcashWallet() {
  const state = useSyncExternalStore(zcashWallet.subscribe, zcashWallet.getSnapshot, () => disconnectedZcash);
  return { ...state, connect: async () => {
    const provider = (window as Window & { noirwallet?: { zcash?: ZcashProvider } }).noirwallet?.zcash;
    if (!provider || typeof provider.request !== 'function' || typeof provider.on !== 'function') throw new Error('Install and unlock the Zcash testnet build of Noir Wallet, then try again.');
    await zcashWallet.connect(provider);
  }, disconnect: () => zcashWallet.disconnect() };
}

"use client";

import { createContext, useContext } from "react";

export const WalletDialogContext = createContext<(() => void) | null>(null);

export function useWalletDialog() {
  const open = useContext(WalletDialogContext);
  if (!open) throw new Error("useWalletDialog requires WalletProvider");
  return open;
}

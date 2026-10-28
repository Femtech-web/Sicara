"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { makeWalletConfig } from "../config/wagmi";
import { WalletDialogContext } from "../hooks/use-wallet-dialog";
import { WalletDialog } from "./wallet-dialog";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [config] = useState(makeWalletConfig);
  const [queryClient] = useState(() => new QueryClient());
  const [open, setOpen] = useState(false);
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <WalletDialogContext.Provider value={() => setOpen(true)}>
          {children}
          <WalletDialog open={open} onOpenChange={setOpen} />
        </WalletDialogContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

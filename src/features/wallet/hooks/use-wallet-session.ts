"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfig, useConnection, useSignMessage } from "wagmi";
import { getConnection } from "wagmi/actions";
import { parseSiweMessage } from "viem/siwe";

type Session = { wallet: string; expiresAt: string };
export async function api<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: payload === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed. Please try again.");
  return data;
}

export function useWalletSession() {
  const { address, chainId, isConnected } = useConnection();
  const config = useConfig();
  const signer = useSignMessage();
  const cache = useQueryClient();
  const key = ["wallet-session", address?.toLowerCase(), chainId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<{ session: Session | null }>("/api/auth/session"),
    enabled: isConnected && chainId === 11155111,
    retry: false, staleTime: 0, refetchInterval: 60_000,
  });
  const signIn = useMutation({
    mutationFn: async () => {
      if (!address || chainId !== 11155111) throw new Error("Connect your wallet to Sepolia first.");
      const stillConnected = () => {
        const current = getConnection(config);
        if (current.address?.toLowerCase() !== address.toLowerCase() || current.chainId !== 11155111) throw new Error("Your wallet changed. Start sign-in again.");
      };
      const challenge = await api<{ id: string; message: string }>("/api/auth/challenge", { address });
      // Check the exact request before showing the wallet prompt.
      const parsed = parseSiweMessage(challenge.message);
      if (parsed.address?.toLowerCase() !== address.toLowerCase() || parsed.chainId !== 11155111 || parsed.domain !== window.location.host || parsed.uri !== window.location.origin) throw new Error("Sign-in domain or wallet mismatch.");
      stillConnected();
      const signature = await signer.mutateAsync({ message: challenge.message, account: address });
      stillConnected();
      await api("/api/auth/verify", { id: challenge.id, signature });
      stillConnected();
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["wallet-session"] });
      await cache.invalidateQueries({ queryKey: ["loans"] });
    },
  });
  const signOut = useMutation({
    mutationFn: () => api("/api/auth/logout", {}),
    onSuccess: async () => {
      await cache.cancelQueries({ queryKey: ["wallet-session"] });
      await cache.cancelQueries({ queryKey: ["loans"] });
      cache.removeQueries({ queryKey: ["loans"] });
      cache.setQueriesData({ queryKey: ["wallet-session"] }, { session: null });
    },
  });
  const session = query.data?.session;
  const authenticated = !!session && isConnected && chainId === 11155111 && session.wallet.toLowerCase() === address?.toLowerCase();
  return { authenticated, signIn, signOut, query };
}

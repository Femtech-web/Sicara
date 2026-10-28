import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors/injected";

export function makeWalletConfig() {
  return createConfig({
    chains: [sepolia],
    connectors: [injected()],
    transports: { [sepolia.id]: http() },
    ssr: true,
  });
}

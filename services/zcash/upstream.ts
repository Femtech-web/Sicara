/** Reviewed source and reproducible build pin; never follow a floating branch for custody code. */
export const zcashUpstream = {
  repository: "https://github.com/mrnetwork0001/Silicr.git",
  commit: "0767b30f645be6e7083c1f4e3cb01c19728f1ef9",
  license: "MIT OR Apache-2.0",
  walletBackend: "zcash_client_backend 0.25.0",
  defaultServer: "testnet.zec.rocks:443",
} as const;

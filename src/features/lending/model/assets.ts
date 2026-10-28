export type AssetId = "zec" | "demo-zama" | "cusdc" | "near";
export type BorrowAssetId = "demo-zama" | "cusdc";

export type Asset = {
  id: AssetId;
  symbol: string;
  name: string;
  network: string;
  available: boolean;
  decimals: number;
};

export const assets: Record<AssetId, Asset> = {
  zec: { id: "zec", symbol: "ZEC", name: "Zcash", network: "Zcash Testnet", available: true, decimals:8 },
  "demo-zama": { id: "demo-zama", symbol: "Demo ZAMA", name: "Confidential demo token", network: "Sepolia", available: true, decimals:8 },
  cusdc: { id:"cusdc", symbol:"cUSDC", name:"Confidential test USD", network:"Sepolia", available:true, decimals:6 },
  near: { id: "near", symbol: "NEAR", name: "NEAR", network: "NEAR · Planned", available: false, decimals:24 },
};

export const lendingRoute = {
  collateral: assets.zec,
  borrowed: assets.cusdc,
  // UI preview only. Never use these prices to authorize a loan.
  collateralPriceCents: 10000n,
  borrowPriceCents: 100n,
  maxLtvBps: 5000n,
  interestBps: 0n,
} as const;

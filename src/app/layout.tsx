import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { WalletProvider } from "@/features/wallet/components/wallet-provider";
import { site } from "@/config/site";
import { publicSite } from "@/config/metadata";
import "./globals.css";

const satoshi = localFont({
  src: "./fonts/Satoshi-Variable.woff2",
  display: "swap",
  weight: "300 900",
});

const publicConfig = publicSite();
export const viewport: Viewport = { themeColor: '#0b0b10', width: 'device-width', initialScale: 1 };

export const metadata: Metadata = {
  metadataBase: new URL(publicConfig.origin ?? 'http://localhost:3000'),
  applicationName: site.name,
  title: { default: "Sicara — Borrow privately", template: "%s — Sicara" },
  description: site.description,
  keywords: ['Sicara', 'Zcash', 'shielded ZEC', 'confidential lending'],
  robots: { index: publicConfig.indexable, follow: publicConfig.indexable },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="scheme-dark"><body className={`${satoshi.className} bg-[#0b0b10] text-[#edf0f5] antialiased selection:bg-[#677df0]/40 selection:text-white`}><WalletProvider>{children}</WalletProvider></body></html>;
}

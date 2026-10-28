import type { Metadata } from "next";
import localFont from "next/font/local";
import { WalletProvider } from "@/features/wallet/components/wallet-provider";
import { site } from "@/config/site";
import "./globals.css";

const satoshi = localFont({
  src: "./fonts/Satoshi-Variable.woff2",
  display: "swap",
  weight: "300 900",
});

export const metadata: Metadata = {
  title: "Sicara — Borrow privately",
  description: site.description,
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="scheme-dark"><body className={`${satoshi.className} bg-[#0b0b10] text-[#edf0f5] antialiased selection:bg-[#677df0]/40 selection:text-white`}><WalletProvider>{children}</WalletProvider></body></html>;
}

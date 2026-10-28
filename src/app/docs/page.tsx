import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";
import { pageMetadata } from "@/config/metadata";

export const metadata = pageMetadata('/docs', 'How it works', 'A simple guide to borrowing against shielded ZEC, supplying confidential test tokens and managing your Sicara positions.');

const sections = [
  ["overview", "The idea"],
  ["borrow", "Borrow with ZEC"],
  ["lend", "Lend and earn"],
  ["wallets", "Your wallets"],
  ["privacy", "What stays private"],
  ["testnet", "Try the testnet"],
] as const;

const borrowSteps = [
  ["Review your loan", "Choose a confidential token and review the borrowing limit, interest and repayment deadline. The private-collateral pilot uses a common public ceiling rather than a limit that reveals your exact deposit."],
  ["Lock shielded ZEC", "The intended deposit stage gives your loan its own shielded receiver. Your Zcash wallet sends the collateral; confirmation and lock checks must complete before borrowing is allowed."],
  ["Receive confidential tokens", "Once collateral is approved, use your Sepolia wallet to borrow. Zama performs the supported loan calculations on encrypted values."],
  ["Repay, then recover your ZEC", "Repay the principal and interest before the deadline. After repayment is verified, the signing participants authorize the shielded collateral return. The return is complete only when its Zcash transaction confirms."],
];

const lendSteps = [
  ["Choose what to supply", "Select a supported confidential test token in Lend. Review the displayed interest and deadline before approving the token permission and supply transaction."],
  ["Fund a loan offer", "Your offer supplies confidential tokens for one eligible loan. Once matched, the funds are committed to that loan rather than being immediately withdrawable."],
  ["Track principal and interest", "Open Positions → Supplied. Authorize private viewing with your wallet to see the available balance and interest actually received. Interest comes from borrower repayments; it is not guaranteed yield."],
  ["Withdraw when available", "An unmatched offer can be withdrawn. A matched offer unlocks after the required settlement or recovery decision. Nonpayment follows the disclosed default process and can cause losses or delays."],
];

function Steps({ items }: { items: string[][] }) {
  return <ol className="mt-6 divide-y divide-white/8">
    {items.map(([title, description], index) => <li key={title} className="flex gap-4 py-5 first:pt-0">
      <span aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[#7e8aff]/10 text-xs font-bold text-[#b5bdff]">{index + 1}</span>
      <div><h3 className="text-base font-semibold text-[#edf0f5]">{title}</h3><p className="mt-2 text-sm leading-7 text-[#a1abc1]">{description}</p></div>
    </li>)}
  </ol>;
}

export default function DocsPage() {
  return <AppShell>
    <div className="mx-auto w-full max-w-[1040px] px-2 pb-12 pt-4 sm:px-6 sm:pt-9">
      <Link href="/" className="inline-flex min-h-11 items-center rounded-md text-sm text-[#b6bed2] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8798ff]">← Back to Sicara</Link>
      <div className="mt-6 grid items-start gap-10 md:grid-cols-[180px_minmax(0,1fr)] md:gap-14">
        <aside className="md:sticky md:top-8">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7f8ba7]">How it works</p>
          <nav aria-label="Guide contents" className="mt-3 flex flex-wrap gap-x-5 md:flex-col md:gap-0">
            {sections.map(([id, label]) => <a key={id} href={`#${id}`} className="inline-flex min-h-11 items-center rounded-md text-sm text-[#a1abc1] transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8798ff]">{label}</a>)}
          </nav>
        </aside>
        <article className="min-w-0">
          <section id="overview" aria-labelledby="overview-heading" className="scroll-mt-8">
            <p className="text-xs font-semibold text-[#aeb9ff]">The Sicara guide</p>
            <h1 id="overview-heading" className="mt-3 max-w-xl text-4xl font-bold leading-[1.14] tracking-[-0.045em] sm:text-5xl">Keep your ZEC.<br />Borrow privately.</h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-[#a1abc1]">Sicara is building lending around shielded ZEC collateral. Borrowers access confidential tokens, while lenders supply those tokens and earn interest from repayments.</p>
            <div className="mt-7 rounded-2xl border border-[#8798ff]/20 bg-[#8798ff]/5 p-5 text-sm leading-7 text-[#b6bed2]">
              <p className="font-semibold text-[#e0e4ff]">Experimental testnet</p>
              <p className="mt-1">Public ZEC deposits are currently disabled. The private loan signing, release and default flows are still being connected and tested. This guide describes the intended complete flow; an unavailable action in the app is not ready for funds.</p>
              <p className="mt-3">Verified so far: the original internal custodial pilot completed a real testnet deposit, confidential borrowing, repayment and shielded return. Separately, cUSDC lender supply and withdrawal were confirmed live, and a proof over a real confirmed Zcash note was verified. These checks were performed through internal tools; the complete private borrowing journey is not yet connected or verified in the browser.</p>
            </div>
            <div className="mt-7 grid grid-cols-3 gap-2 text-center text-xs font-semibold text-[#c3cbe0] sm:text-sm">
              {["Lock ZEC", "Borrow tokens", "Repay & recover"].map((step, index) => <div key={step} className="rounded-xl border border-white/8 bg-white/3 px-2 py-4"><span className="mb-2 block text-[10px] text-[#7f8ba7]">0{index + 1}</span>{step}</div>)}
            </div>
          </section>
          <section id="borrow" aria-labelledby="borrow-heading" className="mt-12 scroll-mt-8 border-t border-white/10 pt-8">
            <h2 id="borrow-heading" className="text-2xl font-semibold tracking-tight">Borrow with ZEC</h2>
            <Steps items={borrowSteps} />
            <p className="text-sm leading-7 text-[#a1abc1]">Use <strong className="font-semibold text-[#d3daeb]">Positions → Borrowed</strong> to follow your loan. Borrowing, repayment and collateral return are separate stages. Missing a fixed repayment deadline can trigger the agreed collateral recovery policy.</p>
          </section>
          <section id="lend" aria-labelledby="lend-heading" className="mt-12 scroll-mt-8 border-t border-white/10 pt-8">
            <h2 id="lend-heading" className="text-2xl font-semibold tracking-tight">Lend and earn</h2>
            <Steps items={lendSteps} />
            <p className="text-sm leading-7 text-[#a1abc1]">Lending requires a configured, verified market. Borrowers’ locked ZEC stays separate from lender token balances. Optional vault reinvestment is a later feature.</p>
          </section>
          <section id="wallets" aria-labelledby="wallets-heading" className="mt-12 scroll-mt-8 border-t border-white/10 pt-8">
            <h2 id="wallets-heading" className="text-2xl font-semibold tracking-tight">Two wallet roles. One loan.</h2>
            <dl className="mt-6 space-y-5 text-sm leading-7">
              <div><dt className="font-semibold text-[#d3daeb]">Sepolia wallet</dt><dd className="mt-1 text-[#a1abc1]">The Connect button connects a supported Ethereum browser wallet. It approves confidential token transactions and private viewing requests. You need Sepolia ETH for network fees.</dd></div>
              <div><dt className="font-semibold text-[#d3daeb]">Zcash testnet wallet</dt><dd className="mt-1 text-[#a1abc1]">Open Connect and choose Zcash Testnet to authorize a compatible testnet Noir extension. This only connects an account; it does not request a balance, sign a transaction or lock collateral. A payment QR is a separate send request. The native private collateral client and signing integration are still in development; connecting Noir does not replace them.</dd></div>
              <div><dt className="font-semibold text-[#d3daeb]">NEAR, later</dt><dd className="mt-1 text-[#a1abc1]">NEAR is a third ecosystem in the plan. Optional NEAR Intents routing would help users move between supported assets. It is not required for the current Zcash–Sepolia pilot and is not live in Sicara yet.</dd></div>
            </dl>
            <p className="mt-5 text-sm leading-7 text-[#a1abc1]">Never share a seed phrase or private key with Sicara. Testnet and mainnet Zcash addresses differ; only use the network shown in the app.</p>
          </section>
          <section id="privacy" aria-labelledby="privacy-heading" className="mt-12 scroll-mt-8 border-t border-white/10 pt-8">
            <h2 id="privacy-heading" className="text-2xl font-semibold tracking-tight">What each technology protects</h2>
            <dl className="mt-6 space-y-5 text-sm leading-7">
              <div><dt className="font-semibold text-[#d3daeb]">Zcash shields ZEC payments</dt><dd className="mt-1 text-[#a1abc1]">Shielded transactions hide their payment details from public observers. A recipient with the appropriate viewing key can still see what it receives. Sicara’s private-collateral design keeps that viewing material with the client rather than the ordinary app backend.</dd></div>
              <div><dt className="font-semibold text-[#d3daeb]">Zama protects supported token and loan values</dt><dd className="mt-1 text-[#a1abc1]">Confidential contracts calculate on encrypted values. Authorized wallet holders can decrypt their own supported balances. Transaction activity, addresses, loan matching and public policy terms can remain visible.</dd></div>
              <div><dt className="font-semibold text-[#d3daeb]">Privacy still needs verification across the whole flow</dt><dd className="mt-1 text-[#a1abc1]">Client-held keys, verified collateral locks and safe release must work together. Hiding the association between a Zcash deposit and an Ethereum borrower is separate work; full unlinkability is not established by this prototype.</dd></div>
            </dl>
          </section>
          <section id="testnet" aria-labelledby="testnet-heading" className="mt-12 scroll-mt-8 border-t border-white/10 pt-8">
            <h2 id="testnet-heading" className="text-2xl font-semibold tracking-tight">Try it with test assets</h2>
            <p className="mt-5 text-sm leading-7 text-[#a1abc1]">Open <strong className="font-semibold text-[#d3daeb]">Faucets</strong> beside the Testnet badge in the app for Zcash, Sepolia and NEAR test resources, plus Sicara’s confidential test token faucets.</p>
            <p className="mt-4 text-sm leading-7 text-[#a1abc1]">cUSDC and Demo ZAMA are self-issued, valueless demo tokens. cUSDC is not Circle-issued USDC and cannot be redeemed for dollars. Faucet availability and rate limits apply. Never send mainnet assets to a test address.</p>
            <Link href="/" className="mt-7 inline-flex min-h-11 items-center justify-center rounded-full bg-[#e7eaff] px-6 text-sm font-bold text-[#181c33] transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8798ff]">Open Sicara →</Link>
          </section>
        </article>
      </div>
    </div>
  </AppShell>;
}

# Sicara

A private cross-chain borrowing prototype, starting with shielded Zcash collateral and confidential demo-token loans on Sepolia.

## Run locally

Requires Node.js 22.8+ and pnpm 10.30.2.

```sh
pnpm install
pnpm fonts
pnpm dev
```

Open http://127.0.0.1:3000. The borrowing preview and wallet connection work without credentials. My Loans sign-in requires the database setup below. Connecting a wallet does not request a signature; clicking **Sign in with wallet** explicitly requests a free sign-in message on Sepolia. Contract wallets are not supported by this first authentication implementation.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Current behavior

The interface supports EVM browser-wallet connection, network switching, collateral and chosen loan amount inputs, borrowing-limit validation, exact demo-price estimates, asset selection, terms review, My Loans and Activity views. Only the ZEC → Demo ZAMA route is selectable. Preview amounts use fixed illustrative prices: ZEC $100 and Demo ZAMA $1, with 50% maximum LTV and zero demo interest. These are not market prices or executable quotes.

The public UI does not enable deposits, borrowing, repayment or collateral return. PostgreSQL-backed sign-in and loan reads are implemented. A persistent testnet worker connects native-validated allocation, full wallet scanning, reservations, refunds and settlement-authorized releases. Hosted migrations and the funded pre-issuance refund/restart proof pass. The combined internal loan has verified live attested borrowing and repayment; its shielded release verification is recorded below. Public intake remains gated by fee, recovery, privacy and UI acceptance work.

## Database and sign-in setup

1. Create a Supabase project. In its **Connect** panel copy the **Transaction pooler** URL for `DATABASE_URL`, and **Session pooler** URL for both `DATABASE_MIGRATION_URL` and `DATABASE_WORKER_URL`. Replace the password placeholder, percent-encoding reserved characters. These are private server connection strings, not the project URL or anon key. See [Supabase's connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).
2. Put the connection strings in root `.env` or `.env.local`, using `.env.example` as the template. Preserve an existing file rather than overwriting it. Next.js and the migration/worker commands support both; `.env.local` overrides `.env`. Keep `SICARA_APP_ORIGIN=http://127.0.0.1:3000` and open that exact origin during development. Production requires its exact HTTPS origin. No Supabase API key is needed.
3. The database clients require verified TLS even when the copied URLs omit SSL parameters. Supabase's CA is loaded from `.local/supabase-ca.crt` when present; download it from Database Settings on a fresh host. `DATABASE_SSL_CA_FILE` or a URL's `sslrootcert` can specify another CA path. The current host's official Supabase Root 2021 CA has SHA-256 fingerprint `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`. Only explicit localhost connections may disable TLS. [SSL configuration](https://supabase.com/docs/guides/platform/ssl-enforcement).
4. Run `pnpm db:migrate` from the root. It reads the root environment files, takes a migration lock and applies pending migrations 001–005 in one transaction. Rerunning skips applied migrations. Failure rolls back without logging credentials. Run it with the project database administrator; it creates restricted backend/worker roles and grants them to that connection user. Existing installations receive only pending migrations.
5. Run `pnpm dev`, connect your EVM wallet on Sepolia, open **My Loans**, then click **Sign in with wallet**. Approve the message in your wallet. A fresh account should display **No loan requests yet**. **Sign out** revokes the server session; disconnecting the wallet alone hides the records but does not revoke an existing eight-hour session.

No Supabase JavaScript client, browser database credential or public database API is used. All tables live in the private `sicara` schema with RLS and backend-only policies. The runtime uses parameterized queries and a small connection pool, and drops to the restricted role per transaction. Sign-in uses a five-minute, browser-bound, one-use SIWE challenge and a hashed opaque eight-hour session token in an HttpOnly, SameSite cookie. Write requests require the configured Origin. The first version verifies EOA signatures only. A changed browser account must match the authenticated session to display records.

`GET /api/loans` reads only the authenticated wallet's records. There is deliberately no public loan-creation, observation, allocation or send endpoint. Internal loan preparation initially records an `allocating` request; the persistent worker validates checksum, test network and shielded receiver before attaching a unique address. The browser cannot submit observations, allocate receivers or invoke refunds.

Candidate tracking uses ten confirmations, unique note ownership and permanent reservations. Full fresh wallet snapshots can place a request into reorg review; review never clears itself automatically. Underpayments can be topped up within a one-hour funding window. Expiry, cancellation and overpayment create refund obligations against the immutable bound destination. The worker returns all observed principal and closes an obligation only after confirmed shielded payments; request expiry does not erase incoming funds. Previously allocated addresses remain watched for late deposits, which use a separate recovery state without taking a newer request's active-wallet slot.

The database tests run real migrations and queries in temporary disk-backed PostgreSQL (PGlite), including restricted-role access, replay, ownership, uniqueness, rollback, refund recovery and disk reopen. Wallet effects in worker tests are explicit fixtures. `pnpm test:zcash-native` separately builds and exercises the actual offline Rust validator; its Rust unit tests and Clippy checks also pass. PGlite serializes connections; a separate hosted check verifies the worker's session lock against a second database connection. Root tests run files sequentially with bounded timeouts; disk-backed fixtures avoid an intermittent in-memory initialization stall on the local Node 23 runtime. Tests close handles and remove their temporary databases.

## Persistent collateral worker

Run these from Sicara's root on the host holding the protected custody wallet:

```sh
pnpm zcash:validator
pnpm db:migrate
pnpm worker --once
```

`pnpm worker:check` is a separate **unfunded internal canary**, limited to an otherwise empty loan database or its own saved request. It proves hosted signed sessions, application/worker database consistency, competing-worker exclusion, real receiver allocation and cancellation without a payment. It writes only an ephemeral test account's record, saves resumable evidence under `.local/evidence/worker-readiness.json`, and prevents send RPCs. It has completed on the current host; it does not prove a funded refund. The random canary account is unrelated to the user's connected wallet.

The worker requires `DATABASE_WORKER_URL` to be a direct/session connection, usually port 5432. It rejects the port-6543 transaction pooler because the session advisory lock must remain on one connection. It drops to `sicara_worker`, which inherits backend permissions and adds access to worker-only operation tables. An established database connection loss aborts its sidecar. No new wallet is silently created.

`--once` performs one pass and closes the sidecar/connection. `pnpm worker` runs every 15 seconds on a persistent host; Ctrl-C or SIGTERM stops it and closes its resources. Keep the worker separate from Next.js routes. Its session lock and the Rust wallet's OS file lock prevent competing workers on the same database/wallet. Operate one custody wallet on one persistent host; automated failover between independent wallet replicas is not implemented.

Address validation is an offline Rust CLI using locked `zcash_keys` 0.17.0 / `zcash_address` 0.14.0 / `zcash_protocol` 0.11.0. It accepts supported shielded testnet UAs and returns the canonical Orchard-only receiver used by the pinned Ironwood wallet. It rejects checksum damage, mainnet/transparent/Sapling-only receivers, expiry metadata and mandatory metadata it cannot preserve. It reads addresses from stdin without receiving application secrets or opening a wallet.

Every allocation and refund has a database record and a private fsynced write-ahead file under `.local/zcash/wallet/sicara-operations/`. Back up this directory with the wallet and application database. A manifest binds the network, custody wallet and database instance. Missing operation rows after a database restore halt startup. Allocation responses saved before a database interruption are reused; a derivation whose response was lost before journalling enters review without publishing or guessing an address.

Refunds are pre-issuance only. Each installment is capped at 0.01 TAZ, carries a unique encrypted memo, and is checked against its destination, amount, transaction ID and fully shielded Ironwood structure. Incoming funds and outgoing payments each need ten confirmations. Overpayments can require multiple installments; no next installment is sent while another payment is in flight or uncertain. A lost send response is reconciled from the wallet's mined outgoing ledger, never by submitting another transfer. If it never appears mined, it remains blocked for reconciliation; the pinned sidecar does not expose a general rebroadcast API. Reorganizations or contradictory receipts enter review and stop new sends.

`SICARA_OPERATOR_RESERVE_ZATS` defaults to 1,000,000 zatoshis (0.01 TAZ). The worker checks spendable funds against all tracked confirmed principal still owed plus that operator-funded cushion before a send. Refund principal is not reduced by the fee. This is a conservative balance preflight, not a proven upper bound on a proposal's transaction fee; a firm fee budget and funded end-to-end recovery verification remain requirements before enabling public intake. Existing operator faucet funds are not assigned to any user's loan by this worker.

The persistent worker verifies canonical settlement before post-issuance collateral return. Internal CLI scripts coordinate the signed collateral authorization and confidential contract lifecycle. Public deposits remain disabled; see the latest live evidence and recovery requirements below.

## Architecture

```text
src/
  app/                         Next.js routes, layout, metadata, Tailwind entry
  components/
    layout/                    Application shell, header and ambient background
    ui/                        Shared dialog, brand, controls and entrance motion
  config/                      Public application metadata
  features/
    lending/
      components/              Lending card, collateral input, selectors, terms, loans
      model/                   Asset definitions and pure exact-integer preview math
      server/                  Private loan repository and collateral candidate ledger
    wallet/
      components/              Wallet/query providers, connection dialog and controls
      config/                  Per-provider wagmi configuration
      hooks/                   Wallet dialog access
      server/                  SIWE challenges, sessions and HTTP authentication boundary
services/database/             PostgreSQL adapters, worker lock and versioned migrations
services/zcash/                Sidecar gateway, offline validator, journal and worker
tests/                         Preview, sidecar and embedded PostgreSQL integration tests
```

Routes compose features. Features own domain-specific UI, models and hooks. Shared components must not absorb loan or wallet business rules. Only add `server/` modules inside a feature when a server implementation exists; protect secret-bearing modules with `server-only`. Keep the future persistent Zcash service separate from Next.js request handlers. Do not use browser state as the authoritative loan ledger.

All authored styling uses Tailwind utilities. `globals.css` contains only the Tailwind import. There are no custom CSS selectors, CSS modules or authored inline style objects. GSAP is used only for a subtle entrance, with cleanup and reduced-motion support; its runtime transform/opacity attributes are animation output, not an alternative styling system. No Motion dependency is added because the current interaction does not need a second animation engine.

Satoshi, the font used in Parius, is self-hosted with `next/font/local`. Run `pnpm fonts` to obtain your own official Fontshare copy and its license before starting or building a fresh checkout. Font binaries and their downloaded license copy are git-ignored to avoid public font redistribution. Superbridge uses GT Maru, which requires a webfont license; we use the owner-authorized Satoshi fallback. Icons use the MIT-licensed Phosphor filled family through the shared UI icon module. No runtime font service is required. Radix Dialog supplies focus trapping and Escape handling; every visual style remains a Tailwind class.

The screenshot supplied by the project owner and https://testnets.superbridge.app/ guide the visual language; Sicara's arrangement serves collateralized lending instead of reproducing the bridge form. Sicara has its own branding and lending interactions.

## Next integration milestone

The independent live integration runs are recorded below. Native-validated allocation and a persistent scanner/refund worker now have local recovery tests and hosted unfunded verification. Next, verify a funded worker round trip and firm fee policy, then implement the trusted once-only collateral attestation bridge. The UI stays gated until the combined lifecycle is implemented. Never turn the UI preview calculation into an authorization source.

The planned MVP is testnet-only and operator-custodied. It is experimental, unaudited and not trustless. Private product notes are excluded by `.gitignore`; review all staged content before publishing a repository.

## Integration spikes

The frontend remains gated. Do not expose the spike CLI, wallet process or owner-only contract registration as public application APIs.

### Zcash wallet

`services/zcash/` holds the testnet-only JSON-lines adapter, protocol validation and read-only confirmation assessment. The unmodified [Silicr sidecar](https://github.com/mrnetwork0001/Silicr) is pinned to commit `0767b30f645be6e7083c1f4e3cb01c19728f1ef9`; its MIT license and provenance are retained beside the local binary. `zcash_client_backend` 0.25.0 / `zcash_client_sqlite` 0.23.0 handle real wallet scanning and proving. The current compatibility baseline is Ironwood value with Orchard receivers; legacy/cross-pool notes are rejected by the adapter. Recheck network support on upgrades.

```sh
pnpm zcash:prepare
pnpm zcash:spike init
pnpm zcash:spike status
pnpm zcash:spike address
pnpm zcash:spike deposit <testnet-UA> <required-zatoshis>
```

Preparing requires Git, Cargo and a compatible Rust toolchain. Seeds, SQLite wallet state, upstream checkout, binaries and private evidence remain under ignored `.local/`. Existing prepared wallet state must be retained; never delete it to fix a sync error. Back up its private seed securely without logging or publishing it.

The spike uses ten confirmations for incoming deposits. Stale scans, mempool notes and duplicate identities cannot authorize a loan. The worker now persists reservations, observation history and reorg/reconciliation state. TypeScript format checks are preliminary; the offline Rust validator checks destinations before allocation and the sidecar applies its own recipient guard before sending. The upstream OS file lock prevents two processes from opening one wallet.

To test a shielded return only after funding, use a separate test wallet/receiver and a unique intent ID:

```sh
pnpm zcash:spike return <unique-intent-id> <testnet-UA> <zatoshis>
pnpm zcash:spike inspect <txid>
```

Return sends are capped at 0.01 TAZ. An exclusive, fsynced intent is written before broadcast. A timeout/crash becomes outcome-unknown and must be reconciled; reusing an intent ID is refused, never silently retried. This spike is not the production repayment-authorized return worker. Funding and return fees require additional valueless TAZ. Set `SICARA_ZCASH_DATA_DIR`, `SICARA_ZCASH_BINARY` or `SICARA_ZCASH_SOURCE` only for explicit alternative local paths; only `init` creates a wallet.

### Confidential contracts

`contracts/` is a separate Hardhat 2 package, based on the FHEVM skill/template configuration. Use Node.js 22 LTS. Its dependencies and generated artifacts are isolated from Next.js. The tested set is FHEVM Solidity 0.11.1, Hardhat plugin/mock-utils 0.4.2, host-contracts 0.10.0, Relayer SDK 0.4.1 and OpenZeppelin confidential-contracts 0.5.3. The Relayer SDK is pinned to match the plugin's exact peer requirement; it is deprecated upstream, so live host contracts and relayer compatibility were verified on 2026-10-28, including a real encrypted-token loan and settlement cycle. Revalidate on upgrades.

```sh
pnpm --dir contracts install
pnpm --dir contracts compile
pnpm --dir contracts typecheck
pnpm --dir contracts test
pnpm --dir contracts check:sepolia
```

`DemoZama` is a real ERC-7984 confidential test token with eight decimals matching the UI preview. Its operator-only funding mint is public and has no mainnet ZAMA relationship. `ConfidentialLoanSpike` registers an operator-supplied encrypted capacity, checks an encrypted requested amount, transfers actual confidential tokens and tracks debt from the actual amount transferred. Partial repayments subtract only tokens received. The borrower grants an expiring ERC-7984 operator permission for repayment; the live script revokes it afterward. Token operators have access to the amounts they transfer.

A public settlement request discloses only a one-bit repayment result. Finalization verifies a KMS proof bound to the saved handle before marking the loan settled. This does not authorize a Zcash return yet. Addresses, loan IDs, registration, timing and settlement status remain public. The spike permits one registration per wallet for its lifetime and prevents all re-borrowing after issuance. Local FHEVM mocks validate behavior but do not prove live encrypted computation.

### Fast live-test setup

1. Request valueless TAZ at [Fauzec](https://fauzec.com/) for the address printed by `pnpm zcash:spike status`. Complete its human check yourself. The current Valar faucet rejected our Orchard-only UA.
2. Use a dedicated Ethereum Sepolia test account and obtain Sepolia ETH from a faucet for deployment/transaction gas. Do not fund it with real ETH.
3. Edit `contracts/.env` locally. A public Sepolia RPC is prefilled and was probed for chain ID 11155111. Set only `SEPOLIA_PRIVATE_KEY` initially, using the dedicated test account's `0x`-prefixed private key. Never put this key in chat or source control. `.env.example` documents the remaining optional fields.
4. `pnpm --dir contracts check:sepolia` checks the RPC, test account, gas balance and live FHEVM relayer without sending a transaction.
5. Once ready, deployment is `pnpm --dir contracts deploy:sepolia`; populate the returned token/pool addresses in `.env`, then run `pnpm --dir contracts spike:sepolia`. It can start a fresh spike or reconcile and resume its own saved run for the already registered borrower. The round trip writes transaction hashes and checked outcomes to ignored `.local/evidence/`. It uses the operator as the synthetic borrower solely for the integration spike. Known submitted hashes are reconciled before continuing; confirmed stages are not resubmitted. State reads are pinned to transaction receipt blocks to avoid stale `latest` responses from load-balanced RPCs. A bounded readiness wait handles coprocessor/KMS delay. A completed run exits without issuing another loan. Preserve the evidence file for recovery.

The independent network spikes are separate from the combined Sicara lending backend. The Zcash transfer below is a controlled test return, not a release authorized by a Sepolia loan.

### Live evidence — 2026-10-28

- Sepolia DemoZama: `0xbe3E89E7b21c6f47fD1E5AD54CfF1540f1779515`.
- Sepolia ConfidentialLoanSpike: `0x1A065c6e3588361FbAE9e8f71B04b816467C41B5`.
- Verified 40 Demo ZAMA issued and user-decrypted, fully repaid, and settled through KMS-proof verification. [Borrow transaction](https://sepolia.etherscan.io/tx/0x88c02c787887f3a5b40f2c65aaea15129920a13fb32a0c4ab3f7f2bedff70538), [repayment](https://sepolia.etherscan.io/tx/0x71d3d363a61d83856fcf5137a97cd27cd3818155886a7d42d5a92e56d3500035), [settlement](https://sepolia.etherscan.io/tx/0xb3e8a2d3e069ae7191ccd727e48639b9ab42d90b0b4f1afdba10664178b71808). Temporary repayment-operator permission was revoked afterward.
- The funded Zcash wallet received 1 TAZ. A separate locally generated test wallet received the 0.01 TAZ return in `a3117c0b14810ec5a9f2222a57412c514a7b2708a2809493c83628f76a87362a`. Exact sender-side inspection confirmed no transparent inputs/outputs, no Sapling or legacy-Orchard actions, and real Ironwood shielded actions. The receiving wallet verified ten confirmations after reopening/rescanning; completed evidence is stored in `.local/evidence/zcash-roundtrip.json`.
- Detailed transaction hashes, receipt blocks, decrypted synthetic assertions and wallet-owned receipt evidence stay in ignored `.local/evidence/`. Public explorer inclusion alone does not establish hidden amounts.

The current-run return checker is `node --import tsx scripts/check-zcash-roundtrip.ts --wait`. It only reopens/scans wallets and inspects the existing transaction; it never broadcasts a send. `contracts/scripts/inspect-spike.ts` reads the saved loan's final state and receipt statuses without issuing transactions.


### Funded worker recovery and attestation pilot

`pnpm worker:funded` is a resumable **testnet-only** integration proof, not a public deposit endpoint. It uses a synthetic internal borrower, the existing protected custody and return wallets, 10,000 zatoshis, and ignored `.local/evidence/funded-worker.json`. Preserve that file and both wallet journals. Its first run funds a unique loan address and exits. `--wait` confirms the deposit and cancels, then exits; the next invocation broadcasts the refund and simulates a lost response, then exits; another `--wait` reconciles the existing transaction and independently verifies receipt. A completed invocation only rechecks existing evidence and never starts another loan or send. It requires the prepared native validator, existing funded test wallets and worker session-pooler environment; do not run concurrently with another worker.

The funded cycle passed on 2026-10-28: funding `ecb4220eb0707197b297e4a049f48f44128993e2180850eb1c82b061f02f5e9c`, refund `7837074deab37c42be2caa8f4231af487837b9508795d0dc11b386fe5bc5674b`. Both are fully shielded. Full principal returned with ten confirmations, independent receiver verification, one matching outgoing refund memo, and cold restart verification. Observed fees were 10,000 zatoshis per send, paid separately from refund principal; this is not a guaranteed fee cap.

`AttestedLoanPilot` adds EIP-712 collateral authorization to the existing confidential engine and disables unsigned registration. It binds the borrower, encrypted capacity/proof, opaque loan/deposit commitment, policy, expiry, chain and deployment; deposits consume once. The pilot is deployed and used by the internal combined test below. Durable issuance reservations exclude cancellation/refund after authorization; settlement/release uses separate immutable intents and canonical receipt reconciliation. These internal checks do not enable public intake.

Sicara's three ecosystems are Zcash collateral, Zama/EVM confidential lending and planned NEAR Intents routing. The current test route needs an EVM connection; a separate Zcash wallet can fund a copyable shielded address. A NEAR connection will be requested only when the chosen action needs one. NEAR routing is disabled until its concrete assets/networks and quote/refund lifecycle are verified; swap completion never replaces Zcash collateral verification.

### Attested borrowing and test funds

The internal combined Sepolia pilot is `contracts/scripts/attested-issuance.ts` under Node 22. Apply root migrations first. `SICARA_ISSUANCE_STEP` selects explicit stages: `fund`, `prepare`, `register`, `borrow`, `verify`; `verify` is the safe default and does not broadcast. The protected `.local/evidence/attested-collateral.json` comes from `pnpm worker:funded --for-issuance`, then `--for-issuance --wait`. This internal proof uses the dedicated test account as both borrower and attestor; it is not a public intake endpoint. Preserve the wallet journal, SQL and `.local/issuance/` signed packets together. No secrets belong in browser configuration.

A fresh ten-confirmed exact deposit is reserved before the operator signs a 120-second authorization. Cancellation/expiry cannot refund an authorized loan. Twelve-confirmed canonical Sepolia receipts are reconciled by the original hashes across restarts. `recover-borrow` is an explicit bounded recovery for a canonical, twelve-confirmed **reverted** borrow with unchanged registration, fresh exact collateral, zero debt and no prior issuance; it retains failed history. Unknown/successful transactions cannot be replaced. Failed registrations, expired unconsumed authorizations and other review states do not automatically become refundable. Post-issuance repayment/release coordination is described below.

The real combined pilot verified 0.0001 TAZ collateral, 0.005 Demo ZAMA capacity and 0.0025 Demo ZAMA borrowed/decrypted. Pool: `0xDFf156604F0d7e542E64fE227faEa90FbCc09bA5`. Registration: `0xfc54dfa1b55a6cf2de9852e06674081ecea8fd03957699c840dded4c5571d96f`. Successful borrow: `0xb5bd7b116f3e5c44a7edf0861b3f1d119f84f1525e38310dc0fb57312f6707d3`. A separate cold process verified the same receipts and private borrower state. Evidence remains ignored/local; only synthetic test assertions are recorded. The same loan's completed repayment/release proof is described below.

**Faucets** sits beside the Testnet control. It links to [Fauzec TAZ](https://fauzec.com/), [Sepolia ETH faucet listings](https://ethereum.org/developers/docs/networks/#sepolia) and [NEAR testnet funds](https://near-faucet.io/). Availability/cooldowns/human checks belong to those providers; NEAR routing remains planned. Sicara's own `DemoTokenFaucet` distributes the existing valueless ERC-7984 Demo ZAMA from a separate prefunded token balance: 10 tokens per wallet per 24 hours and a 1,000-token aggregate UTC-day request cap. It has no mint authority, no custody credentials and no access to borrower collateral or refund reserves. Claimant address, fixed request amount and timing are public; balances use confidential-token permissions. A mined request is not proof of actual transfer if depleted, and can still consume cooldown. Local tests cover delivery/decryption, cooldown, global cap and depletion. Browser verification of this new UI is currently unavailable because browser use is disabled in Work settings.

The production build command uses Next's supported Webpack flag because this environment rejects Turbopack's compiler port binding. Wallet connector imports use the injected-only subpath to avoid pulling unused optional wallet SDKs into the build.

Own faucet deployed on Sepolia: `0x2C043ADE6bC458839235D3E4cd892e72fB0B899c`. Separately prefunded with 10,000 Demo ZAMA; a live claim and private balance difference verified receipt of 10 tokens in `0xa50ce19abcdd8e3044132f8c9bd86715ec52150eb740f3d53e809e63c02fa462`. The app's Faucet dialog uses this address and asks the user's EVM wallet to sign `claim()`. No server wallet key is exposed. `fund-faucet` and `claim-faucet` are explicit internal verification steps with their own saved signed packets; never remove those packets to retry.

Current checks: the existing 48 app/worker tests passed at the completed-loop checkpoint; 19 local contract tests now include the privacy-boundary counterexample and shared-hash experiment. Separate native-crypto and blind-credential checks pass. Root, contract and experiment typechecks, Rust Clippy and ESLint pass. The earlier production Webpack build remains the latest build result; the privacy experiment does not change frontend/runtime custody. Required lender interest follows core; only vault reinvestment is optional.

### Repayment-authorized shielded release

Migration 005 adds immutable release bindings and separate post-issuance payments. `ReleaseWorker` verifies the registered borrower, deposit commitment, policy, successful pool settlement event, contract settled state, canonical registration/settlement blocks and twelve Sepolia confirmations before authorizing a return. It rechecks all tracked releases before any new send. The wallet still requires fresh confirmed collateral, the previously bound canonical shielded receiver and operator-funded fee reserves. Reorgs and contradictions freeze the flow for review; no automatic replacement payment is made. The same shared send journal protects pre-issuance refunds and post-settlement releases, using distinct encrypted memo identities.

The internal Node-22 script `contracts/scripts/repay-release.ts` reconciles signed approve/repay/request-settlement/finalize/revoke transactions by their saved bytes/hashes. It targets the existing synthetic live loan only and verifies borrower-decrypted zero debt and revoked token permission. `SICARA_REPAY_VERIFY_ONLY=1` verifies existing receipts without broadcasting. It records a release candidate, never opens the Zcash wallet or sends collateral. Preserve `.local/issuance/`, SQL, wallet/journal and `.local/evidence/repaid-release.json` together.

`pnpm worker:release` verifies the chain proof again, submits the existing 10,000-zatoshi return and deliberately loses the response to test restart recovery, then exits. `pnpm worker:release --wait` reconciles the existing encrypted memo and requires ten confirmations plus a separate receiving-wallet scan. Once marked complete, the checker only inspects history. Run only on the protected test custody host, never concurrently with another worker. This is not a public withdrawal endpoint.

Live repayment `0x558e01d7df6b6faf70653e83a5ea6f5c4455d2a30ee493697246d7d27abec05f` and settlement `0xb6ebb39377e8bbc8b2ae086a66c6dc48ba7a63e67da0851c8c210aa4dd35f428` are confirmed; the borrower decrypted zero debt and spending permission was revoked. Shielded return `a481e0eda19aaddb9ff1b6f83bf99a34647d029feeda0ca5e8d1d392b46121fa` returned all 10,000 zatoshis. After a controlled lost response and process restart, the worker reconciled exactly one outgoing memo/transaction; SQL reached released/confirmed and an independent recipient scan verified the full amount with at least ten confirmations (fourteen at completion). This completes the synthetic combined loop, not public lending readiness. Public deposits remain disabled.

“Operator” means Sicara's custody and application services, which currently know incoming amounts and their loan/EVM association. An encrypted relay does not hide information from a receiving endpoint. [Silicr's threat model](https://github.com/mrnetwork0001/Silicr/blob/main/THREAT_MODEL.md) is a useful example of disclosing per-party knowledge, not an operator-blind lending implementation. Candidate unlinkable collateral credentials/proofs and their replay, settlement, custody and metadata requirements are recorded in `private-notes/impl-plan.md`; that redesign is not implemented or verified.

### Private-collateral feasibility experiment (offline; not ready for funds)

`experiments/private-collateral/` contains real cryptographic primitive experiments, isolated from the public app and live wallets. It tests client-held viewing material, 2-of-2 RedPallas FROST, a Halo2 private arithmetic/range proof, and RFC 9474 blind credentials with possession binding and journaled replay prevention. The native note is synthetic; issuance assumes synthetic eligibility. Passing these tests does not prove a funded collateral lock, equality between a Zcash amount and a Zama ciphertext, safe repayment-authorized release or end-to-end unlinkability. Public deposits remain disabled and no new funds were sent.

Setup and commands from the repository root (Node >=22.8, Rust >=1.89):

```sh
npm ci --prefix experiments/private-collateral --ignore-scripts --no-audit --no-fund
cargo fetch --locked --manifest-path experiments/private-collateral/native/Cargo.toml
pnpm privacy:typecheck
pnpm privacy:test
pnpm privacy:probe
pnpm privacy:probe --require-live
```

The last command must return status **2**: the complete private lifecycle is not implemented. The report at `.local/evidence/private-collateral-feasibility.json` separates passing primitives from missing integration gates and states `readyForFundedTest:false`. The runner loads no application env files, sends no transactions, passes no wallet credentials to native code and deletes temporary fixture credentials. It uses `.local/privacy-native-target` for builds; `SICARA_PRIVACY_TARGET_DIR` may point to an existing compatible Cargo cache. It is an experimental protocol/circuit, not audited production custody or an anonymous lending API.

The necessary next work is a canonical note/lock proof, cryptographic binding to the Zama input, and a verified blind-signing policy for release/default/recovery. Anonymous credential cryptography is a tested component, not a substitute for those checks. FROST alone cannot enforce them. `contracts/test/PrivacyFeasibility.ts` contains the local counterexample showing that FHE input validity does not prove external Zcash collateral.

A newer isolated candidate now tests shared-value binding: `contracts/test/HashBinding.ts` compares the public digest from a real native SHA256/Groth16 proof with a homomorphic SHA256 computation of the encrypted amount/salt. Set `SICARA_PRIVACY_PROBE_BIN` to the built native experiment binary to run the combined check; without it, only the local FHE/hash checks run. The native witness stays client-local, and no wallet or remote network is used. Wrong amounts/salts produce zero capacity. This still uses local FHE mocks and ephemeral ZK setup parameters, has no onchain ZK verifier or real Zcash-note constraints, and requires 18 transactions per job. It cannot authorize loans. Detailed limitations, reproduction steps and independent-review questions are in `private-notes/privacy-bridge-review.md`; local evidence is `.local/evidence/shared-commitment-binding.json`. Public deposits remain disabled.

`pnpm privacy:notes` separately reuses upstream Orchard note-commitment, recipient/key and Merkle-path gadgets for a real Halo2 note-eligibility proof. It tests fixed native verification, pinned synthetic snapshot policy, a claim identifier that survives reblinding/root changes, concurrent one-use admission and replay after journal reopening. Its notes/roots are fixtures: it does not authenticate live chain state, prove a current unspent lock, enforce a lending spend policy, or join its Poseidon commitment to the SHA256/FHE candidate. It loads no app env and opens no wallet. Proving uses two threads; temporary test claims are removed. `pnpm privacy:notes --require-live` intentionally returns 2. Evidence is `.local/evidence/note-eligibility-feasibility.json`.

The SHA256 cost review measured 124,587,544 global HCU / 34,666,608 gas for a complete successful local job, excluding deployment and negative test calls. Even regrouping that same computation needs at least seven transactions under the installed host's global HCU limit, before depth constraints. It is retained as a benchmark and is **not approved as the live lending integration**. A variable-limit research alternative is a masked-response binding: the v2 Halo2 note circuit proves `z = α·v + ρ mod 2^128`, with `α` derived onchain from the statement and ciphertext handles, and `EncryptedValueBindingProbe` recomputes `z` homomorphically. This joins the note value and the Zama ciphertext in one statement, in one transaction, for 1,778,064 HCU (`contracts/test/ValueBinding.ts`, evidence `.local/evidence/value-binding.json`). The Halo2 proof is still verified off-chain, roots are still fixtures, and it is not yet independently reviewed. Its stated 78-bit worst-case margin and one-use mask lifecycle require review; this is not a standardized Schnorr integration or an automatically supported custom Gateway proof. Current prototype reports remain explicitly `readyForFundedTest:false`; no new funds have been moved.

The owner approved a separate **common-ceiling** prototype: one public collateral minimum, the same demo borrowing ceiling for everyone, and private actual borrowing/debt. `CommonCeilingLoanProbe` derives that capacity from policy without accepting an encrypted collateral amount. The local integration test verifies a real native note proof over a synthetic root with an EVM-bound public context, then uses a trusted attestor's EIP-712 eligibility signature. Registration takes one transaction / 128 local HCU; claim/key replay and private borrowing/repayment tests pass. This is experimental and undeployed; it does not authenticate a live root or replace custody-policy enforcement. More collateral does not increase this prototype's ceiling. Interest remains required future core work, not implemented by the zero-interest spike.

`pnpm privacy:prepare` creates a private isolated test manifest and empty role directories with funding/broadcast disabled. It generates no keys, wallet or address. `pnpm privacy:lock` exercises real-format offline default/release transactions over fixture roots, now with durable pre-signing reservations and restart/input-reuse checks. The isolated `TimedCommonCeilingLoanProbe` adds repayment/settlement cutoffs and verified zero-debt cancellation that freezes subsequent draws. A read-only common-ceiling settlement verifier and durable release coordinator are tested, but native private-return verification and live signer-service wiring remain missing. Deadline buffers cannot guarantee release inclusion before an unconditional pre-signed default; that recovery risk remains open. See the latest checkpoint in `private-notes/privacy-bridge-review.md` before funding anything.

Latest isolated integration: Claude's native effect reader now drives TS release/escrow admission using real redacted PCZTs over synthetic notes; set `SICARA_LOCK_BIN` to the all-feature native binary when running `pnpm privacy:test` to enable that test. The public minimum goes into recovery escrow on default. New timed-pool KMS resolution distinguishes confirmed zero debt from confirmed outstanding debt after repayments close; pending proof is not default, and zero-debt recovery remains possible after the old settlement deadline. Escrow-to-loan bindings, authenticated exact-digest participant consent and durable one-decision records are required. Escrow recovery transactions do not expire. These paths are undeployed, with no live signing/broadcast service yet.

The owner approved **single pinned testnet RPC for the isolated valueless test only**. `pnpm privacy:chain --trusted-test-source` successfully obtains a live Ironwood root and writes separate test-only evidence; default strict independent-operator quorum checks still reject that report. The opt-in is not a public intake setting. `pnpm privacy:prepare --trusted-test-source` records that explicit trust policy and the three funded-test scenarios, but still creates no wallets or keys and keeps funding/broadcast disabled. See the latest review checkpoint for remaining live integration and anonymity limits.

`pnpm privacy:test` includes algebra regressions for the masked-response alternative, isolated co-signer admission, common-ceiling settlement checks and durable release admission. The original policy freezes amount-free bindings, checks two pinned checkpoint endorsements and reserves one immutable return digest. Its private transaction-policy verifier is a test seam: **no live co-signer key, FROST signature, or send API is connected**. It cannot be used as a live release verifier. Optional `pnpm privacy:chain` builds the read-only `chain-observer` feature and requires two of four pinned TLS testnet endpoints to agree on public Ironwood block/root observations, with a 90-second network deadline. Agreement is trusted RPC observation, not consensus/unspent proof; insufficient sources or disagreement produces no approval. The latest read-only attempt, including outside the network sandbox, failed to cross-check a snapshot. No app env or wallet files are read. Detailed remaining gates and the review of Claude's masked-response proposal are in `private-notes/privacy-bridge-review.md`.

The isolated client-local live-session CLI is `pnpm privacy:live create --trusted-test-source`, then `audit SESSION` or `scan SESSION funding` with the same explicit flag. It uses fresh keys and a pinned test-only source; client note values stay in private client files. A same-host harness is not independent custody or a completed anonymous lending integration. `prepare-return SESSION --trusted-test-source` prepares an ordinary funding-wallet shielded return without broadcasting. Preserve every session, share and pending intent. Do not fund a fixture address or delete an ambiguous operation to retry.

The owner-approved funding helper, `pnpm privacy:fund SESSION --check|--send`, requires the dedicated patched binary/checksum record, limits the single original funding debit including fee to 0.01 TAZ, and binds the grant to one session. The patch under `services/zcash/patches/isolated-funding-budget.patch` applies only to a separate copy of the pinned upstream `zec-sidecar` source; the original custody executable is unchanged. It checks the selected fee before signing. Fresh funding-wallet staging is separate from the still-incomplete three-scenario collateral runner.

cUSDC and Demo ZAMA are selectable preview assets with separate Sepolia faucets. cUSDC is a self-issued, valueless confidential test token with six decimals, **not Circle USDC or a redeemable wrapper**. cUSDC token: `0x6060Af7f2a5D02AA4ACD1183aC7182Ff1EdFe62A`; faucet: `0xE95D2095dA1d4aa487Dd730F8E75d1ED80049CC1`. Public collateral intake remains disabled.

Rebuild that dedicated helper with `pnpm privacy:funder /path/to/pristine-pinned-Silicr-checkout`; it verifies the pin, compares the complete copied source against the reviewed patch, builds offline with two jobs and records binary/patch checksums. Build the native session tool with `cargo build --offline --locked --release --all-features -j 2 --manifest-path experiments/private-collateral/native/Cargo.toml --target-dir .local/privacy-native-target` before using `privacy:live`.

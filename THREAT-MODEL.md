# Sicara threat model

This document distinguishes observed results from the intended private-collateral design. It is not an audit or a claim that public lending is ready.

## Scope and evidence

The original operator-custodied testnet pilot completed deposit, confidential borrowing, repayment and shielded return. The operator could read received ZEC amounts and associate them with borrowers.

The separate client-held experiment has verified a proof over a real confirmed note, funded fresh threshold receivers and prepared a signed timelocked default against an actual confirmed deposit. A matched cUSDC loan then borrowed, fully repaid and finalized its KMS settlement; the lender withdrew principal and earned interest. The shielded return is not confirmed. Local tests cover threshold signing, durable reservations, release construction and restart failures. These results do **not** establish a complete funded private loan, safe funded default/recovery, independent signing operators or borrower–deposit unlinkability. Public ZEC intake remains disabled.

## Assets and boundaries

- **Client secrets:** Zcash viewing material, note witnesses and the client's key share. The intended design keeps them outside the ordinary app backend. Compromising the client device defeats that boundary.
- **Signing authority:** fresh 2-of-3 shares for client, co-signer and lender, with separate custody and recovery-escrow groups. Two shares alone do not supply the private note witness needed to construct a spend. The client must not pre-authorize arbitrary alternative spends.
- **Loan values:** supported token balances, debt and lender earnings are encrypted by Zama. Contract ACLs authorize the relevant wallet and computation; encrypted handles are not plaintext balances.
- **Coordination:** Zcash collateral checks and Ethereum borrowing are joined by a trusted attestor. Ethereum does not directly verify Zcash consensus or the native Halo2 proof. This is not a trustless bridge.
- **Operational state:** durable input, custody-key, default, signing-nonce and release reservations must survive crashes. Restoring stale backups can defeat local safety records.

## What each party can learn

| Party | Information available |
| --- | --- |
| Public observers | EVM addresses, contract calls, matching, policy terms, settlement/default outcomes and timing. Shielded Zcash activity still exposes transaction structure, fees and timing. Cross-chain correlation is not eliminated. |
| Borrower/client | Its collateral amount, viewing material, note witnesses and authorized loan values. |
| Original custody operator | Received ZEC amounts and the deposit-to-borrower association. The completed custodial pilot does not provide privacy from that operator. |
| Ordinary backend in the intended client-held path | Public eligibility/loan identifiers and coordination data, without collateral viewing material or clear token amounts. Deposit-to-borrower association is not proven hidden. |
| Co-signer in the intended separated deployment | Redacted transaction effects, the frozen spend and signing policy. Amount-blind admission must be enforced by the actual service boundary. |
| Lender | Its authorized supply/earnings and the common public minimum received by recovery escrow; its own EVM identity and loan match remain public. |
| RPC/indexer providers | Request timing, network metadata and any publicly queried addresses or transactions. Client-local shielded scanning does not submit its viewing key or shielded receiver. Public lender UTXO lookups are identifiable. |

**Current test limitation:** the isolated client, co-signer and lender run on one host. Its operator can access the test roles' private files. Separate directories and subprocesses are not independently administered signers, and functional tests do not prove confidentiality against the host operator. Some Sepolia test roles also use the same operator-controlled account.

## Threats and current controls

| Threat | Control and remaining limit |
| --- | --- |
| Fabricated collateral or chain state | Native proof/signature and note membership checks; pinned network, anchors and block hashes; confirmation and reorg checks. The isolated test explicitly trusts one server. Strict public use requires independent source agreement; RPC agreement is still a trust assumption, not a consensus proof. |
| Early withdrawal or reuse of collateral | Fresh per-loan key, frozen default/nullifier, dedicated lender input and durable role reservations before signing/eligibility; on-chain claim/key replay protection. These depend on correct signing services, honest policy records and non-collusion. No standalone balance proof enforces a lock. |
| Default executable before maturity | The default needs a non-final transparent lender input to make the height lock effective. A shielded-only transaction's lock time is insufficient. Local transaction tests pass; funded early-rejection and maturity execution remain separate checks. |
| False repayment or premature release | Canonical successful Sepolia receipts, runtime pinning, registration binding, KMS-verified settlement and twelve confirmations precede release admission. Native signing must consume the exact admitted transaction. UI labels and caller-supplied paid flags are not authority. The complete funded service path remains under integration. |
| Late payment, missing worker or delayed KMS proof | Debt resolution stays pending until the required verified outcome arrives. Lack of a proof is not proof of default. Expiring direct release and recovery escrow are the proposed deadline mechanism; funded deadline recovery is not yet established. Block-height deadlines and Ethereum timestamps are different clocks. |
| Crash, duplicate send or nonce reuse | Write-ahead reservations, exact signed packets, persisted FROST rounds and hash reconciliation. Ambiguous outcomes stop rather than create a replacement transaction. This can sacrifice availability. Lost files, rollback and dishonest records remain risks. |
| Unauthorized decryption or key disclosure | Wallet-scoped FHE access, private viewing signatures, tab-memory values, private local files and server-only credentials. XSS, compromised extensions, malicious dependencies or a compromised signing host can bypass application-level protections. |
| Lender losses or false yield claims | Interest is credited from actual repayments, with isolated offer accounting. Matching and fixed terms are public. Defaults, fees, outages and recovery failure can cause losses; interest is not guaranteed. Valueless cUSDC is not Circle USDC. |

## Test-identifier correlation

One isolated loan used a test claim derived from its custody key and spend nullifier. That identifier can be correlated when the nullifier appears on Zcash; its already published transaction cannot be made private retroactively. New test authorizations use independent opaque random claims instead. This avoids that direct identifier construction but does not establish anonymous credentials, hide matching from the attestor or prevent timing correlation. Do not present the existing test as an unlinkability demonstration.

## Explicit non-goals and open gates

No verified borrower–deposit unlinkability, lender anonymity, traffic-analysis resistance, protection from a compromised client/host, trustless cross-chain verification or production security claim is made. NEAR Intents is planned routing, not an implemented privacy or collateral-verification mechanism. Borrower ZEC is not invested in yield strategies.

Before public ZEC intake: complete funded borrowing, repayment, release, default and deadline recovery; validate actual service admissions and independent role deployment; establish the public chain-state policy; verify the complete browser/client journey; and independently review the cryptographic and custody assumptions. An isolated successful transaction does not remove these gates.

For transaction receipts and implementation status, see [README verification](README.md#verification) and [recorded live evidence](README.md#recorded-live-evidence--2026-10-28).

/** Preparation only: creates no key, address, transaction, network request or send. */
import {mkdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

async function main(){
 const runId=randomUUID();
 const trustedTest=process.argv.includes('--trusted-test-source');
 const directory=resolve(import.meta.dirname,'../../.local/isolated-lock-test',runId);
 await mkdir(directory,{recursive:true,mode:0o700});
 for(const role of ['client','cosigner','lender','evidence'])await mkdir(join(directory,role),{mode:0o700});
 const plan={
  version:2,runId,network:'zcash-testnet',pool:'ironwood',ethereumNetwork:'sepolia',policy:'common-ceiling',
  chainTrust:trustedTest?'owner-approved-single-server-isolated-test-only':'independent-operator-quorum',
  rootEvidence:trustedTest?'testnet-trusted-test-snapshot.json':'testnet-chain-snapshot.json',
  source:'owner-authorized-existing-test-wallet-funding-only',existingCustodyWalletAccess:'funding-only-no-key-export',existingCustodyReusedForPrivateLocks:false,
  maximumTestFundingZats:1_000_000,budgetIncludesFundingFee:true,publicMinimumZats:100_000,
  roleDirectories:['client','cosigner','lender','evidence'],walletsCreated:false,depositAddress:null,
  notes:'Directories are preparation scaffolding, not independent operators or initialized wallets. Never fund an address copied from a fixture.',
  schedule:{deriveFromFreshLiveTip:true,minimumRegistrationAndSettlementConfirmations:12,minimumZcashDepositAndReleaseConfirmations:10,minimumReleaseAdmissionBufferBlocks:20,releaseExpiryBeforeMaturityBlocks:20,minimumEthereumSettlementBufferSeconds:120,oneMinuteMaturityAllowed:false},
  prerequisites:[
   trustedTest?'Fresh explicit test-only observation from pinned testnet.zec.rocks; never treat it as independent consensus verification.':'Fresh independent-operator two-source pinned TLS testnet root agreement.',
   'Independent client/co-signer/lender DKG with client-only viewing material, backed-up shares and signing journals.',
   'Fund and reserve a dedicated transparent lender input; check canonical UTXO availability immediately before borrowing.',
   'Bind native note eligibility, exact default spend/nullifier and FROST custody key to the same loan; no unrelated proofs.',
   'Deploy isolated timed common-ceiling Sepolia pool; pin runtime code hash, policy, claim/key and deadlines.',
   'Connect native recomputed effects and verified private return/fee policy to both durable signing services; fixture callback must reject live use.',
   'Certify separate escrow DKG shared viewing material (public minimum only), pin entitled participant authentication keys and freeze escrow-to-loan binding before eligibility.',
   'Require confirmed KMS resolution 1 (zero debt) or 2 (debt remains); pending or absent settlement is never a lender payout.',
  ],
  scenarios:[
   {id:'repayment-release',steps:['Fund fresh shielded collateral and wait for confirmations.','Prepare, verify and persist the default before granting borrowing; attempt early broadcast and require an explicit non-final rejection.','Borrow and repay before the cutoff; confirm Sepolia KMS settlement.','Prepare shielded release; persist intent before signatures, restart services, reconcile exact transaction without generating a replacement.','Mine release and wait for confirmations; attempt the saved default after maturity and require an explicit already-spent rejection.']},
   {id:'matured-default',steps:['Use a different loan, custody key, collateral note and reserved lender input.','Prepare and reserve default, grant borrowing, do not repay.','After maturity broadcast exact default to escrow and confirm its inclusion.','Request immutable post-cutoff debt resolution, verify KMS proof and twelve confirmations.','Authenticate lender consent to the exact escrow spend; reserve and sign the non-expiring claim. Verify the lender receives public minimum minus the recorded escrow fee, and client receives private excess.']},
   {id:'missed-release-recovery',steps:['Use a third distinct loan and escrow, repay before token cutoff.','Deliberately delay the resolution proof and ordinary release past their normal deadlines. Assert pending resolution cannot authorize lender recovery.','Allow the saved default to move the public minimum into escrow and private excess back to the client.','Publish the delayed zero-debt KMS resolution; authenticate client consent to the exact non-expiring escrow refund.','Restart services before broadcast, reconcile the exact intent, confirm shielded refund and reject duplicate or changed-loan requests.']},
  ],
  abortPolicy:'No funding or broadcasting while prerequisites are incomplete. On ambiguous signing/broadcast, preserve records and reconcile; never delete reservations or blindly resend. Pending KMS decision holds escrow. Recovery depends on honest available signers, participant viewing material/backups, accepted chain observations and actual network inclusion; it is not unconditional atomicity.',
  readyForFunding:false,broadcastEnabled:false,
 };
 const manifest=join(directory,'manifest.json');
 const file=await open(manifest,'wx',0o600);try{await file.writeFile(JSON.stringify(plan,null,2));await file.sync();}finally{await file.close();}
 const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
 console.log(JSON.stringify({manifest,walletsCreated:false,readyForFunding:false,broadcastEnabled:false},null,2));
}
void main().catch(()=>{console.error('Isolated preparation failed. No wallet access, funding or broadcast was attempted.');process.exitCode=1;});

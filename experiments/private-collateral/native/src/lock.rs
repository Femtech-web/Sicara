//! Per-loan collateral lock built from REAL v6 Ironwood transactions over a fixture tree.
//! Spend authority is 2-of-3 FROST (client, cosigner, lender) and only the client holds
//! nk/rivk, so no pair of signers can build a spend without the client. The default is
//! pre-signed before borrowing. Its lock time is consensus-enforceable only because the
//! lender adds a NON-FINAL transparent input: lock time is ignored when every transparent
//! input is final, which includes every shielded-only transaction. The cosigner signs
//! from redacted PCZT effects and never receives note values. FROST/PCZT usage follows
//! Silicr 0767b30 (MIT OR Apache-2.0). No wallet, network or broadcast is used here.
//!
//! The default pays the public minimum into a per-loan ESCROW (its own 2-of-3 key; the
//! viewing key is shared by client and lender, since the amount is public). Escrow goes to
//! the lender only if Sepolia shows the loan unsettled after its settlement cutoff, and back
//! to the client if it was settled. A missed release deadline then costs only fees.
use super::signing_journal::{FrozenDefault, SigningJournal};
use anyhow::{Result, anyhow, ensure};
use ff::PrimeField;
use incrementalmerkletree::{Hashable, Level};
use orchard::{
    Address, Anchor, Note,
    circuit::{OrchardCircuitVersion, VerifyingKey},
    keys::{FullViewingKey, IncomingViewingKey, Scope, SpendValidatingKey, SpendingKey},
    note::{ExtractedNoteCommitment, NoteVersion, Nullifier, RandomSeed, Rho},
    primitives::redpallas,
    tree::{MerkleHashOrchard, MerklePath},
    value::NoteValue,
};
use pczt::{
    Pczt,
    roles::{
        creator::Creator, io_finalizer::IoFinalizer, low_level_signer, prover::Prover,
        redactor::Redactor, signer::Signer, spend_finalizer::SpendFinalizer,
        tx_extractor::TransactionExtractor,
    },
};
use rand::{TryRng, rngs::SysRng};
use rand_core::UnwrapErr;
use reddsa_frost::frost::redpallas as frost;
use sha2::Digest;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;
use zcash_primitives::transaction::{
    Authorization, Transaction, TransactionData,
    builder::{BuildConfig, Builder, BundlePadding, cached_orchard_proving_key},
    fees::{fixed::FeeRule as FixedFeeRule, zip317::FeeRule},
    sighash::{PrecomputedSighashData, SignableInput},
};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, TEST_NETWORK},
    memo::MemoBytes,
    value::Zatoshis,
};
use zcash_transparent::{
    address::{Script, TransparentAddress},
    bundle::{self as tbundle, OutPoint, TxIn, TxOut},
    pczt as tpczt,
    sighash::TransparentAuthorizingContext,
};

use frost::keys::{EvenY, KeyPackage, PublicKeyPackage, dkg};

const CLIENT: usize = 0;
const COSIGNER: usize = 1;
const LENDER: usize = 2;
const NON_FINAL: u32 = 0xffff_fffe;
const MARGINAL_FEE: u64 = 5_000;
const TIP: u32 = 4_560_000;
const MATURITY: u32 = TIP + 100;
const RELEASE_CUTOFF: u32 = MATURITY - 30;
const LENDER_DUST: u64 = 10_000;

fn rng() -> UnwrapErr<SysRng> {
    UnwrapErr(SysRng)
}
fn bytes32() -> Result<[u8; 32]> {
    let mut b = [0; 32];
    SysRng.try_fill_bytes(&mut b)?;
    Ok(b)
}

/// 2-of-3 DKG among client, cosigner and lender; group key normalised to even y.
pub(super) fn dkg_three() -> Result<(Vec<KeyPackage>, PublicKeyPackage)> {
    let ids = (1..=3u16)
        .map(frost::Identifier::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    let mut secrets = BTreeMap::new();
    let mut round1 = BTreeMap::new();
    for id in &ids {
        let (s, p) = dkg::part1(*id, 3, 2, rand_core06::OsRng)?;
        secrets.insert(*id, s);
        round1.insert(*id, p);
    }
    let others = |me: &frost::Identifier| -> BTreeMap<_, _> {
        round1
            .iter()
            .filter(|(k, _)| *k != me)
            .map(|(k, v)| (*k, v.clone()))
            .collect()
    };
    let mut secrets2 = BTreeMap::new();
    let mut inbox: BTreeMap<frost::Identifier, BTreeMap<_, _>> = BTreeMap::new();
    for (me, secret) in secrets {
        let (s2, out) = dkg::part2(secret, &others(&me))?;
        secrets2.insert(me, s2);
        for (to, package) in out {
            inbox.entry(to).or_default().insert(me, package);
        }
    }
    let mut keys = Vec::new();
    let mut group = None;
    for (me, s2) in &secrets2 {
        let (key, public) = dkg::part3(s2, &others(me), &inbox.remove(me).unwrap_or_default())?;
        let even = public.has_even_y();
        let public = public.into_even_y(Some(even));
        ensure!(
            group.as_ref().is_none_or(|g| *g == public),
            "DKG disagreement"
        );
        group = Some(public);
        keys.push(key.into_even_y(Some(even)));
    }
    Ok((keys, group.ok_or_else(|| anyhow!("empty DKG"))?))
}

fn spending_key() -> Result<SpendingKey> {
    loop {
        if let Some(sk) = Option::<SpendingKey>::from(SpendingKey::from_bytes(bytes32()?)) {
            return Ok(sk);
        }
    }
}
fn note_to(recipient: Address, value: u64) -> Result<Note> {
    let rho = loop {
        if let Some(rho) = Option::<Rho>::from(Rho::from_bytes(&bytes32()?)) {
            break rho;
        }
    };
    loop {
        if let Some(seed) = Option::<RandomSeed>::from(RandomSeed::from_bytes(bytes32()?, &rho))
            && let Some(note) = Option::<Note>::from(Note::from_parts(
                recipient,
                NoteValue::from_raw(value),
                rho,
                seed,
                NoteVersion::V3,
            ))
        {
            return Ok(note);
        }
    }
}

/// A two-leaf fixture tree, so two notes share one anchor. NOT a chain observation.
struct FixtureTree {
    anchor: Anchor,
    paths: [MerklePath; 2],
}
fn fixture_tree(notes: [&Note; 2]) -> FixtureTree {
    let leaf =
        |n: &Note| MerkleHashOrchard::from_cmx(&ExtractedNoteCommitment::from(n.commitment()));
    let path = |position: u32, sibling: MerkleHashOrchard| {
        let mut auth = [MerkleHashOrchard::empty_leaf(); 32];
        auth[0] = sibling;
        for (level, node) in auth.iter_mut().enumerate().skip(1) {
            *node = MerkleHashOrchard::empty_root(Level::from(level as u8));
        }
        MerklePath::from_parts(position, auth)
    };
    let paths = [path(0, leaf(notes[1])), path(1, leaf(notes[0]))];
    let anchor = paths[0].root(ExtractedNoteCommitment::from(notes[0].commitment()));
    FixtureTree { anchor, paths }
}

struct Lender {
    shielded: SpendingKey,
    transparent: secp256k1::SecretKey,
    utxo: OutPoint,
}
impl Lender {
    fn new() -> Result<Self> {
        Ok(Self {
            shielded: spending_key()?,
            transparent: secp256k1::SecretKey::from_secret_bytes(bytes32()?)?,
            utxo: OutPoint::new(bytes32()?, 0),
        })
    }
    fn address(&self) -> Address {
        FullViewingKey::from(&self.shielded).address_at(0u32, Scope::External)
    }
    fn ivk(&self) -> IncomingViewingKey {
        FullViewingKey::from(&self.shielded).to_ivk(Scope::External)
    }
    fn pubkey(&self) -> secp256k1::PublicKey {
        secp256k1::PublicKey::from_secret_key(&self.transparent)
    }
    fn taddr(&self) -> TransparentAddress {
        TransparentAddress::from_pubkey(&self.pubkey())
    }
    fn coin(&self) -> Result<TxOut> {
        Ok(TxOut::new(
            Zatoshis::from_u64(LENDER_DUST)?,
            self.taddr().script().into(),
        ))
    }
}

/// ZIP 317 conventional fee for a padded Ironwood bundle plus transparent parts.
fn conventional_fee(spends: usize, outputs: usize, transparent: usize) -> u64 {
    MARGINAL_FEE * (spends.max(outputs).max(2) + transparent).max(2) as u64
}

/// Rebuilds the spend validating key from its 32-byte point encoding (the journal key
/// identifier). The nk/rivk filler only satisfies the FVK parser; it is never a real key.
fn ak_from_key(key: [u8; 32]) -> Result<SpendValidatingKey> {
    for filler in 1u64..64 {
        let mut raw = [0u8; 96];
        raw[..32].copy_from_slice(&key);
        raw[32..64].copy_from_slice(&pasta_curves::pallas::Base::from(filler).to_repr());
        raw[64..].copy_from_slice(&pasta_curves::pallas::Scalar::from(filler).to_repr());
        if let Some(fvk) = FullViewingKey::from_bytes(&raw) {
            let ak = SpendValidatingKey::from(fvk);
            ensure!(key_id(&ak) == key, "noncanonical custody key");
            return Ok(ak);
        }
    }
    Err(anyhow!("invalid custody key"))
}

struct Draft {
    pczt: Pczt,
    sighash: [u8; 32],
    alpha: pasta_curves::pallas::Scalar,
}

/// A transaction spending one custody note. `lock` adds the lender's transparent input
/// with the given sequence and makes the maturity height the lock time.
struct Spec<'a> {
    custody: &'a FullViewingKey,
    note: Note,
    path: MerklePath,
    anchor: Anchor,
    outputs: Vec<(Address, u64)>,
    lock: Option<(&'a Lender, u32)>,
    expiry: u32,
    // Only to model a malicious client builder; honest drafts use ZIP 317.
    fixed_fee: Option<u64>,
}
fn draft(spec: Spec<'_>) -> Result<Draft> {
    let mut builder = Builder::new(
        TEST_NETWORK,
        BlockHeight::from_u32(TIP + 1),
        BuildConfig::Standard {
            sapling_anchor: None,
            orchard_anchor: None,
            ironwood_anchor: Some(spec.anchor),
            orchard_padding: BundlePadding::DEFAULT,
            ironwood_padding: BundlePadding::DEFAULT,
        },
    );
    builder
        .add_ironwood_spend::<std::convert::Infallible>(spec.custody.clone(), spec.note, spec.path)
        .map_err(|e| anyhow!("spend: {e}"))?;
    for (to, value) in &spec.outputs {
        builder
            .add_ironwood_output::<std::convert::Infallible>(
                None,
                *to,
                Zatoshis::from_u64(*value)?,
                MemoBytes::empty(),
            )
            .map_err(|e| anyhow!("output: {e}"))?;
    }
    if let Some((lender, _)) = spec.lock {
        builder
            .add_transparent_p2pkh_input(lender.pubkey(), lender.utxo.clone(), lender.coin()?)
            .map_err(|e| anyhow!("lender input: {e:?}"))?;
        builder
            .add_transparent_output(&lender.taddr(), Zatoshis::from_u64(LENDER_DUST)?)
            .map_err(|e| anyhow!("lender output: {e:?}"))?;
    }
    let built = match spec.fixed_fee {
        None => builder
            .build_for_pczt(rng(), &FeeRule::standard())
            .map_err(|e| anyhow!("build: {e}")),
        Some(fee) => builder
            .build_for_pczt(rng(), &FixedFeeRule::non_standard(Zatoshis::from_u64(fee)?))
            .map_err(|e| anyhow!("build: {e}")),
    };
    let mut parts = built?.pczt_parts;
    parts.expiry_height = BlockHeight::from_u32(spec.expiry);
    if let Some((lender, sequence)) = spec.lock {
        parts.lock_time = MATURITY;
        ensure!(parts.transparent.is_some(), "transparent bundle missing");
        let coin = lender.coin()?;
        let refund = tpczt::Output::parse(
            LENDER_DUST,
            coin.script_pubkey().0.0.clone(),
            None,
            BTreeMap::new(),
            None,
            BTreeMap::new(),
        )
        .map_err(|e| anyhow!("lender refund: {e:?}"))?;
        let input = tpczt::Input::parse(
            *lender.utxo.hash(),
            lender.utxo.n(),
            Some(sequence),
            None,
            Some(MATURITY),
            None,
            LENDER_DUST,
            coin.script_pubkey().0.0.clone(),
            None,
            BTreeMap::new(),
            0x01,
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .map_err(|e| anyhow!("lender input: {e:?}"))?;
        parts.transparent = Some(
            tpczt::Bundle::parse(vec![input], vec![refund])
                .map_err(|e| anyhow!("transparent bundle: {e:?}"))?,
        );
    }
    let pczt = Creator::build_from_parts(parts).ok_or_else(|| anyhow!("PCZT creation"))?;
    let pczt = IoFinalizer::new(pczt)
        .finalize_io(rng())
        .map_err(|e| anyhow!("IO finalizer: {e:?}"))?;
    let pczt = Prover::new(pczt)
        .create_ironwood_proof(
            rng(),
            cached_orchard_proving_key(OrchardCircuitVersion::PostNu6_3),
        )
        .map_err(|e| anyhow!("prover: {e:?}"))?
        .finish();
    let sighash = Signer::new(pczt.clone())
        .map_err(|e| anyhow!("sighash: {e:?}"))?
        .shielded_sighash();
    let custody_ak = SpendValidatingKey::from(spec.custody.clone());
    let mut alpha = Vec::new();
    inspect(&pczt, |bundle| {
        for action in bundle.actions() {
            if let Some(a) = action.spend().alpha()
                && action.spend().spend_auth_sig().is_none()
                && custody_ak.randomize(a) == *action.spend().rk()
            {
                alpha.push(*a);
            }
        }
    })?;
    ensure!(alpha.len() == 1, "expected one custody spend");
    Ok(Draft {
        pczt,
        sighash,
        alpha: alpha[0],
    })
}

/// Read-only view of the Ironwood bundle; nothing is signed or changed.
fn inspect(pczt: &Pczt, mut f: impl FnMut(&orchard::pczt::Bundle)) -> Result<()> {
    low_level_signer::Signer::new(pczt.clone())
        .sign_ironwood_with::<low_level_signer::OrchardParseError, _>(|_, bundle, _| {
            f(bundle);
            Ok(())
        })
        .map(|_| ())
        .map_err(|e| anyhow!("inspect: {e:?}"))
}

/// What the cosigner receives: proven effects, alpha for FROST, no values/recipients/seeds.
fn redact(pczt: Pczt) -> Pczt {
    Redactor::new(pczt)
        .redact_ironwood_with(|mut r| {
            r.redact_actions(|mut a| {
                a.clear_spend_value();
                a.clear_spend_recipient();
                a.clear_spend_rho();
                a.clear_spend_rseed();
                a.clear_spend_fvk();
                a.clear_spend_witness();
                a.clear_spend_dummy_sk();
                a.clear_output_value();
                a.clear_output_recipient();
                a.clear_output_rseed();
                a.clear_output_ock();
                a.clear_rcv();
            });
            r.clear_bsk();
        })
        .finish()
}

struct Effects {
    sighash: [u8; 32],
    lock_time: u32,
    expiry: u32,
    sequences: Vec<(OutPoint, u32)>,
    custody_spends: Vec<Nullifier>,
    anchor: Anchor,
    plaintext_values_present: bool,
    shielded_only: bool,
    fee: i64,
    actions: usize,
}
impl Effects {
    /// Amount-blind return policy: spends exactly the frozen note, pays only the
    /// conventional fee (value is otherwise conserved by the binding signature), is
    /// shielded-only and unlocked. The destination is the rightful party's choice.
    fn returns_only(&self, frozen: &Nullifier) -> bool {
        !self.plaintext_values_present
            && self.shielded_only
            && self.lock_time == 0
            && self.custody_spends == [*frozen]
            && self.fee == (MARGINAL_FEE * self.actions.max(2) as u64) as i64
    }
}
fn effects(redacted: &Pczt, custody: &SpendValidatingKey) -> Result<Effects> {
    let mut plaintext_values_present = false;
    let mut custody_spends = Vec::new();
    inspect(redacted, |bundle| {
        for action in bundle.actions() {
            plaintext_values_present |= action.spend().value().is_some()
                || action.output().value().is_some()
                || action.spend().recipient().is_some()
                || action.output().recipient().is_some()
                || action.spend().fvk().is_some()
                || action.spend().rho().is_some()
                || action.spend().rseed().is_some()
                || action.spend().witness().is_some()
                || action.spend().dummy_sk().is_some()
                || action.output().rseed().is_some()
                || action.output().ock().is_some()
                || action.output().user_address().is_some()
                || !action.spend().proprietary().is_empty()
                || !action.output().proprietary().is_empty();
            if let Some(alpha) = action.spend().alpha()
                && custody.randomize(alpha) == *action.spend().rk()
            {
                custody_spends.push(*action.spend().nullifier());
            }
        }
    })?;
    let data = redacted
        .clone()
        .into_effects()
        .map_err(|e| anyhow!("effects: {e:?}"))?;
    let sequences = data
        .transparent_bundle()
        .map(|b| {
            b.vin
                .iter()
                .map(|i| (i.prevout().clone(), i.sequence()))
                .collect()
        })
        .unwrap_or_default();
    let ironwood = data
        .ironwood_bundle()
        .ok_or_else(|| anyhow!("no Ironwood bundle"))?;
    let anchor = *ironwood.anchor();
    let fee = i64::from(*ironwood.value_balance());
    let actions = ironwood.actions().len();
    let shielded_only = data.transparent_bundle().is_none()
        && data.sapling_bundle().is_none()
        && data.orchard_bundle().is_none();
    let (lock_time, expiry) = (data.lock_time(), u32::from(data.expiry_height()));
    // Computed by the cosigner from what it was shown, never taken from the client.
    let sighash = Signer::new(redacted.clone())
        .map_err(|e| anyhow!("cosigner sighash: {e:?}"))?
        .shielded_sighash();
    Ok(Effects {
        sighash,
        lock_time,
        expiry,
        sequences,
        custody_spends,
        anchor,
        plaintext_values_present,
        shielded_only,
        fee,
        actions,
    })
}

#[derive(Debug)]
enum SignError {
    Parse(
        #[expect(dead_code, reason = "reported through Debug")] low_level_signer::OrchardParseError,
    ),
    NotUnderRk,
}
impl From<low_level_signer::OrchardParseError> for SignError {
    fn from(e: low_level_signer::OrchardParseError) -> Self {
        Self::Parse(e)
    }
}
fn frost_sign(draft: Draft, signers: &[KeyPackage], group: &PublicKeyPackage) -> Result<Pczt> {
    let (sighash, alpha) = (draft.sighash, draft.alpha);
    let signature = super::sign(signers, group, &sighash, &alpha.to_repr())?;
    low_level_signer::Signer::new(draft.pczt)
        .sign_ironwood_with::<SignError, _>(|_, bundle, modifiable| {
            for action in bundle.actions_mut() {
                if *action.spend().alpha() == Some(alpha) {
                    action
                        .apply_signature(sighash, redpallas::Signature::from(signature))
                        .map_err(|_| SignError::NotUnderRk)?;
                }
            }
            *modifiable &= !(0b0000_0001 | 0b0000_0010 | 0b1000_0000);
            Ok(())
        })
        .map_err(|e| anyhow!("apply FROST signature: {e:?}"))
        .map(|s| s.finish())
}

fn finish(pczt: Pczt, lender: Option<&Lender>, vk: &VerifyingKey) -> Result<Transaction> {
    let pczt = match lender {
        Some(lender) => {
            let mut signer = Signer::new(pczt).map_err(|e| anyhow!("signer: {e:?}"))?;
            signer
                .sign_transparent(0, &lender.transparent)
                .map_err(|e| anyhow!("lender signature: {e:?}"))?;
            signer.finish()
        }
        None => pczt,
    };
    let pczt = SpendFinalizer::new(pczt)
        .finalize_spends()
        .map_err(|e| anyhow!("spend finalizer: {e:?}"))?;
    let sighash = Signer::new(pczt.clone())
        .map_err(|e| anyhow!("signer: {e:?}"))?
        .shielded_sighash();
    // The extractor batch-verifies the Ironwood proof and every signature.
    let tx = TransactionExtractor::new(pczt)
        .with_orchard(vk)
        .extract(rng())
        .map_err(|e| anyhow!("extract: {e:?}"))?;
    let inputs = lender.map(Lender::coin).transpose()?.into_iter().collect();
    ensure!(
        shielded_sighash(&tx, inputs)? == sighash,
        "independent sighash differs from the signed digest"
    );
    Ok(tx)
}

/// Consensus finality for a height lock: ignored when lock_time is 0 or every
/// transparent input is final; otherwise the lock time must be below the block height.
fn is_final(lock_time: u32, sequences: &[u32], height: u32) -> bool {
    lock_time == 0 || lock_time < height || sequences.iter().all(|s| *s == u32::MAX)
}

/// Cosigner: signs at most one default and one release per custody key, from effects only.
#[derive(Default)]
struct Cosigner {
    defaults: BTreeMap<[u8; 32], (Nullifier, [u8; 32])>,
    releases: BTreeSet<[u8; 32]>,
    escrows: BTreeSet<[u8; 32]>,
}
/// Authenticated Sepolia outcome; in the live coordinator this comes from the verifier.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Settled,
    UnsettledAfterCutoff,
}
fn key_id(ak: &SpendValidatingKey) -> [u8; 32] {
    group::GroupEncoding::to_bytes(&pasta_curves::pallas::Point::from(ak))
}
impl Cosigner {
    /// Only the custody spend's nullifier is frozen; the dummy padding spend is ignored.
    fn admit_default(
        &mut self,
        ak: &SpendValidatingKey,
        redacted: &Pczt,
        lender_utxo: &OutPoint,
        roots: &[Anchor],
    ) -> Result<Effects> {
        let e = effects(redacted, ak)?;
        ensure!(
            e.custody_spends.len() == 1,
            "default must spend one custody note"
        );
        ensure!(!e.plaintext_values_present, "cosigner received plaintext");
        ensure!(roots.contains(&e.anchor), "anchor is not an accepted root");
        ensure!(
            e.lock_time == MATURITY && e.expiry == 0,
            "default must lock to maturity and never expire"
        );
        ensure!(
            e.sequences
                .iter()
                .any(|(p, s)| p == lender_utxo && *s != u32::MAX),
            "lock time unenforceable: no non-final lender input"
        );
        if let Some((_, digest)) = self.defaults.get(&key_id(ak)) {
            ensure!(
                *digest == e.sighash,
                "a different default was already signed"
            );
        }
        Ok(e)
    }
    fn record_default(&mut self, ak: &SpendValidatingKey, e: &Effects) {
        self.defaults
            .insert(key_id(ak), (e.custody_spends[0], e.sighash));
    }
    fn admit_release(
        &mut self,
        ak: &SpendValidatingKey,
        redacted: &Pczt,
        repaid: bool,
        height: u32,
    ) -> Result<Effects> {
        let key = key_id(ak);
        let e = effects(redacted, ak)?;
        ensure!(!e.plaintext_values_present, "cosigner received plaintext");
        let (spent, _) = self
            .defaults
            .get(&key)
            .ok_or_else(|| anyhow!("no frozen lock for this key"))?;
        ensure!(repaid, "loan not settled");
        ensure!(height < RELEASE_CUTOFF, "release window closed");
        ensure!(
            e.lock_time == 0 && e.expiry > height && e.expiry <= RELEASE_CUTOFF,
            "release must expire before the default can mature"
        );
        ensure!(
            e.custody_spends.contains(spent),
            "release does not spend the locked note"
        );
        ensure!(e.returns_only(spent), "release policy not met");
        ensure!(self.releases.insert(key), "release already signed");
        Ok(e)
    }
    /// One decision per escrow note. The cosigner cannot see the destination, so it
    /// admits only a session with the party entitled under the outcome; that party
    /// built the transaction and chose where its own funds go.
    fn admit_escrow(
        &mut self,
        escrow: &SpendValidatingKey,
        redacted: &Pczt,
        note: &Nullifier,
        outcome: Outcome,
        partner: usize,
    ) -> Result<Effects> {
        let e = effects(redacted, escrow)?;
        let entitled = match outcome {
            Outcome::Settled => CLIENT,
            Outcome::UnsettledAfterCutoff => LENDER,
        };
        ensure!(
            partner == entitled,
            "partner not entitled under this outcome"
        );
        ensure!(e.returns_only(note), "escrow spend policy not met");
        ensure!(e.expiry == 0, "escrow recovery must not expire");
        ensure!(
            self.escrows.insert(note.to_bytes()),
            "escrow already decided"
        );
        Ok(e)
    }
}

/// The verifier supplies its own input's amount and script, which v6 shielded sighashes
/// commit to (the default's sighash is therefore NOT its txid). Mirrors upstream zip_0244.
#[derive(Debug)]
struct KnownInputs(Vec<TxOut>);
impl tbundle::Authorization for KnownInputs {
    type ScriptSig = Script;
}
impl TransparentAuthorizingContext for KnownInputs {
    fn input_amounts(&self) -> Vec<Zatoshis> {
        self.0.iter().map(TxOut::value).collect()
    }
    fn input_scriptpubkeys(&self) -> Vec<Script> {
        self.0.iter().map(|o| o.script_pubkey().clone()).collect()
    }
}
struct Verifying;
impl Authorization for Verifying {
    type TransparentAuth = KnownInputs;
    type SaplingAuth = sapling::bundle::Authorized;
    type OrchardAuth = orchard::bundle::Authorized;
}
fn shielded_sighash(tx: &Transaction, inputs: Vec<TxOut>) -> Result<[u8; 32]> {
    let transparent = tx.transparent_bundle().map(|b| tbundle::Bundle {
        vin: b
            .vin
            .iter()
            .map(|i| TxIn::from_parts(i.prevout().clone(), i.script_sig().clone(), i.sequence()))
            .collect(),
        vout: b.vout.clone(),
        authorization: KnownInputs(inputs),
    });
    let data = TransactionData::<Verifying>::from_parts_v6(
        tx.consensus_branch_id(),
        tx.lock_time(),
        tx.expiry_height(),
        transparent,
        tx.sapling_bundle().cloned(),
        tx.orchard_bundle().cloned(),
        tx.ironwood_bundle().cloned(),
    );
    Ok(*PrecomputedSighashData::new(data)
        .signature_hash(&SignableInput::Shielded)
        .as_ref())
}

/// Lender: verifies the final default bytes and decrypts only its own output.
struct DefaultCheck {
    lender_value: u64,
    nullifiers: Vec<Nullifier>,
    txid: String,
    escrow_note: Note,
}
fn lender_check(
    tx: &[u8],
    lender: &Lender,
    receiving: &IncomingViewingKey,
    roots: &[Anchor],
    minimum: u64,
    exact_common_payment: bool,
    vk: &VerifyingKey,
) -> Result<DefaultCheck> {
    let tx = Transaction::read(tx, BranchId::Nu7)?;
    let sequences: Vec<u32> = tx
        .transparent_bundle()
        .map(|b| b.vin.iter().map(|i| i.sequence()).collect())
        .unwrap_or_default();
    ensure!(
        tx.lock_time() == MATURITY && u32::from(tx.expiry_height()) == 0,
        "wrong default lock"
    );
    ensure!(
        !is_final(tx.lock_time(), &sequences, MATURITY),
        "default is spendable before maturity"
    );
    let txid = tx.txid().to_string();
    let sighash = shielded_sighash(&tx, vec![lender.coin()?])?;
    let ironwood = tx
        .ironwood_bundle()
        .ok_or_else(|| anyhow!("no Ironwood bundle"))?
        .clone();
    ensure!(
        roots.contains(ironwood.anchor()),
        "anchor is not an accepted root"
    );
    let mut validator = orchard::bundle::BatchValidator::new(vk);
    validator
        .add_bundle(&ironwood, sighash)
        .map_err(|_| anyhow!("malformed bundle"))?;
    ensure!(
        validator.validate(rng()),
        "default proof or signature invalid"
    );
    let mine = ironwood.decrypt_outputs_with_keys(std::slice::from_ref(receiving));
    ensure!(mine.len() == 1, "default must pay the lender exactly once");
    let lender_value = mine[0].2.value().inner();
    ensure!(lender_value >= minimum, "default underpays the lender");
    ensure!(
        !exact_common_payment || lender_value == minimum,
        "common default must pay exactly the public minimum"
    );
    Ok(DefaultCheck {
        lender_value,
        nullifiers: ironwood.actions().iter().map(|a| *a.nullifier()).collect(),
        txid,
        escrow_note: mine[0].2,
    })
}

fn serialize(tx: &Transaction) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    tx.write(&mut out)?;
    Ok(out)
}

pub fn probe() -> Result<()> {
    // Only fresh disposable fixture directories. No existing wallet/key state.
    let directory = std::env::temp_dir().join(format!("sicara-lock-{}", hex::encode(bytes32()?)));
    let result = probe_with_journals(&directory);
    if directory.exists() {
        std::fs::remove_dir_all(&directory)?;
    }
    result
}

fn probe_with_journals(directory: &std::path::Path) -> Result<()> {
    let started = Instant::now();
    let vk = VerifyingKey::build(OrchardCircuitVersion::PostNu6_3);
    let (keys, group) = dkg_three()?;
    let custody = super::client_fvk(&group)?;
    let ak = SpendValidatingKey::from(custody.clone());
    let custody_address = custody.address_at(0u32, Scope::External);
    // The FVK any signer could derive from the public group key is a different key.
    let public = super::upstream_public_fvk(&group)?;
    ensure!(
        public.to_bytes()[32..] != custody.to_bytes()[32..]
            && public.address_at(0u32, Scope::External) != custody_address,
        "signers could derive the client's viewing key"
    );
    let client_wallet = FullViewingKey::from(&spending_key()?).address_at(0u32, Scope::External);
    let lender = Lender::new()?;
    // Escrow: a second 2-of-3 group; its viewing key is shared by client and lender only.
    let (escrow_keys, escrow_group) = dkg_three()?;
    let escrow = super::client_fvk(&escrow_group)?;
    let escrow_ak = SpendValidatingKey::from(escrow.clone());
    let escrow_ivk = escrow.to_ivk(Scope::External);
    let both = |a: usize, b: usize| [keys[a].clone(), keys[b].clone()];

    let collateral = 250_000;
    let minimum = 100_000; // common ceiling: one public collateral requirement
    let collateral_note = note_to(custody_address, collateral)?;
    let second_note = note_to(custody_address, 20_000)?;
    let tree = fixture_tree([&collateral_note, &second_note]);
    let roots = [tree.anchor];

    // Setup: the client builds and proves the default; the cosigner sees effects only.
    let default_fee = conventional_fee(1, 2, 1);
    let default_spec = |sequence| Spec {
        custody: &custody,
        note: collateral_note,
        path: tree.paths[0].clone(),
        anchor: tree.anchor,
        outputs: vec![
            (escrow.address_at(0u32, Scope::External), minimum),
            (client_wallet, collateral - minimum - default_fee),
        ],
        lock: Some((&lender, sequence)),
        expiry: 0,
        fixed_fee: None,
    };
    let unlocked = draft(default_spec(u32::MAX))?;
    let mut cosigner = Cosigner::default();
    let final_sequence_rejected = cosigner
        .admit_default(&ak, &redact(unlocked.pczt), &lender.utxo, &roots)
        .is_err();
    let t0 = Instant::now();
    let proposal = draft(default_spec(NON_FINAL))?;
    let prove_ms = t0.elapsed().as_millis();
    let redacted_default = redact(proposal.pczt.clone());
    let admitted = cosigner.admit_default(&ak, &redacted_default, &lender.utxo, &roots)?;
    let mut outpoint = lender.utxo.hash().to_vec();
    outpoint.extend_from_slice(&lender.utxo.n().to_le_bytes());
    let frozen = FrozenDefault {
        version: 1,
        custody_key: hex::encode(key_id(&ak)),
        nullifier: hex::encode(admitted.custody_spends[0].to_bytes()),
        digest: hex::encode(admitted.sighash),
        lender_outpoint: hex::encode(sha2::Sha256::digest(&outpoint)),
        maturity: MATURITY,
        release_cutoff: RELEASE_CUTOFF,
    };
    let cosigner_path = directory.join("cosigner");
    let lender_path = directory.join("lender");
    // Both independent roles reserve BEFORE the first signing nonce. These
    // local fixture processes do not establish real operator independence.
    SigningJournal::open(&cosigner_path)?.reserve_default(&frozen)?;
    SigningJournal::open(&lender_path)?.reserve_default(&frozen)?;
    ensure!(
        admitted.sighash == proposal.sighash,
        "cosigner digest mismatch"
    );
    let unaccepted_root_rejected = Cosigner::default()
        .admit_default(
            &ak,
            &redacted_default,
            &lender.utxo,
            &[Anchor::empty_tree()],
        )
        .is_err();
    let single_signers_rejected = [CLIENT, COSIGNER, LENDER].iter().all(|&i| {
        super::sign(
            std::slice::from_ref(&keys[i]),
            &group,
            &proposal.sighash,
            &proposal.alpha.to_repr(),
        )
        .is_err()
    });
    let default_tx = finish(
        frost_sign(proposal, &both(CLIENT, COSIGNER), &group)?,
        Some(&lender),
        &vk,
    )?;
    let default_bytes = serialize(&default_tx)?;
    let check = lender_check(
        &default_bytes,
        &lender,
        &escrow_ivk,
        &roots,
        minimum,
        true,
        &vk,
    )?;
    let reopened = SigningJournal::open(&cosigner_path)?;
    ensure!(
        reopened.frozen(&frozen.custody_key)? == frozen,
        "default reservation lost"
    );
    let mut competing_key = frozen.clone();
    competing_key.custody_key = hex::encode(bytes32()?);
    let reused_lender_input_rejected = SigningJournal::open(&lender_path)?
        .reserve_default(&competing_key)
        .is_err();
    ensure!(reused_lender_input_rejected, "lender input reserved twice");
    ensure!(
        check.nullifiers.contains(&admitted.custody_spends[0]),
        "lender and cosigner see different spends"
    );
    cosigner.record_default(&ak, &admitted);
    let locked = admitted.custody_spends[0];
    let competing = draft(default_spec(NON_FINAL))?;
    let second_default_rejected = cosigner
        .admit_default(&ak, &redact(competing.pczt), &lender.utxo, &roots)
        .is_err();
    let underpayment_rejected = lender_check(
        &default_bytes,
        &lender,
        &escrow_ivk,
        &roots,
        minimum + 1,
        true,
        &vk,
    )
    .is_err();
    let overpayment_rejected = lender_check(
        &default_bytes,
        &lender,
        &escrow_ivk,
        &roots,
        minimum - 1,
        true,
        &vk,
    )
    .is_err();

    // Release: full collateral back to the client, expiring before the default matures.
    let release_spec = |note: Note, path: MerklePath, expiry: u32| {
        let value = note.value().inner() - conventional_fee(1, 1, 0);
        Spec {
            custody: &custody,
            note,
            path,
            anchor: tree.anchor,
            outputs: vec![(client_wallet, value)],
            lock: None,
            expiry,
            fixed_fee: None,
        }
    };
    let release = draft(release_spec(
        collateral_note,
        tree.paths[0].clone(),
        RELEASE_CUTOFF,
    ))?;
    let redacted_release = redact(release.pczt.clone());
    let fresh = || Cosigner {
        defaults: cosigner.defaults.clone(),
        ..Default::default()
    };
    let unpaid_rejected = fresh()
        .admit_release(&ak, &redacted_release, false, TIP + 5)
        .is_err();
    let after_cutoff_rejected = fresh()
        .admit_release(&ak, &redacted_release, true, RELEASE_CUTOFF)
        .is_err();
    let other = draft(release_spec(
        second_note,
        tree.paths[1].clone(),
        RELEASE_CUTOFF,
    ))?;
    let other_note_rejected = fresh()
        .admit_release(&ak, &redact(other.pczt), true, TIP + 5)
        .is_err();
    let late = draft(release_spec(
        collateral_note,
        tree.paths[0].clone(),
        MATURITY + 50,
    ))?;
    let expiry_beyond_maturity_rejected = fresh()
        .admit_release(&ak, &redact(late.pczt), true, TIP + 5)
        .is_err();
    let release_effects = cosigner.admit_release(&ak, &redacted_release, true, TIP + 5)?;
    // Still a SYNTHETIC settlement in this native fixture. The live coordinator
    // must authenticate a Sepolia checkpoint; a caller bool is not that proof.
    reopened.reserve_release(&frozen, &hex::encode(release_effects.sighash), TIP + 5)?;
    SigningJournal::open(&lender_path)?.reserve_release(
        &frozen,
        &hex::encode(release_effects.sighash),
        TIP + 5,
    )?;
    let restart_duplicate_rejected = SigningJournal::open(&cosigner_path)?
        .reserve_release(&frozen, &hex::encode(bytes32()?), TIP + 6)
        .is_err();
    ensure!(restart_duplicate_rejected, "release signing history lost");
    ensure!(
        release_effects.sighash == release.sighash,
        "release digest mismatch"
    );
    let duplicate_release_rejected = cosigner
        .admit_release(&ak, &redacted_release, true, TIP + 6)
        .is_err();
    // If the cosigner withholds, client + lender can sign the same release digest.
    let recovery_signs = super::sign(
        &both(CLIENT, LENDER),
        &group,
        &release.sighash,
        &release.alpha.to_repr(),
    )
    .is_ok();
    // Cosigner + lender share 2 of 3 FROST keys but cannot build any spend: the proof
    // needs nk/rivk, which only the client has. A signature alone moves nothing.
    let release_tx = finish(
        frost_sign(release, &both(CLIENT, COSIGNER), &group)?,
        None,
        &vk,
    )?;
    let release_bytes = serialize(&release_tx)?;
    let release_spends: Vec<_> = release_tx
        .ironwood_bundle()
        .map(|b| b.actions().iter().map(|a| *a.nullifier()).collect())
        .unwrap_or_default();
    let lender_sees_release = release_tx
        .ironwood_bundle()
        .is_some_and(|b| !b.decrypt_outputs_with_keys(&[lender.ivk()]).is_empty());

    // Deadline recovery: the default fired although the loan settled (a missed release).
    // Its escrow note goes back to the client; an unsettled loan's note goes to the lender.
    let escrow_note = check.escrow_note;
    let filler = note_to(client_wallet, 1)?;
    let escrow_tree = fixture_tree([&escrow_note, &filler]);
    let escrow_spec = |to: Address| Spec {
        custody: &escrow,
        note: escrow_note,
        path: escrow_tree.paths[0].clone(),
        anchor: escrow_tree.anchor,
        outputs: vec![(to, minimum - conventional_fee(1, 1, 0))],
        lock: None,
        expiry: 0,
        fixed_fee: None,
    };
    let escrow_nullifier = escrow_note.nullifier(&escrow);
    let refund = draft(escrow_spec(client_wallet))?;
    let redacted_refund = redact(refund.pczt.clone());
    let mut refunder = Cosigner::default();
    let refund_to_lender_rejected = refunder
        .admit_escrow(
            &escrow_ak,
            &redacted_refund,
            &escrow_nullifier,
            Outcome::Settled,
            LENDER,
        )
        .is_err();
    let settled_claim_rejected = refunder
        .admit_escrow(
            &escrow_ak,
            &redacted_refund,
            &escrow_nullifier,
            Outcome::UnsettledAfterCutoff,
            CLIENT,
        )
        .is_err();
    let refund_effects = refunder.admit_escrow(
        &escrow_ak,
        &redacted_refund,
        &escrow_nullifier,
        Outcome::Settled,
        CLIENT,
    )?;
    let escrow_id = hex::encode(escrow_nullifier.to_bytes());
    SigningJournal::open(&cosigner_path)?.reserve_escrow(
        &escrow_id,
        "settled-refund",
        &hex::encode(refund_effects.sighash),
    )?;
    let second_outcome_rejected = refunder
        .admit_escrow(
            &escrow_ak,
            &redacted_refund,
            &escrow_nullifier,
            Outcome::Settled,
            CLIENT,
        )
        .is_err()
        && SigningJournal::open(&cosigner_path)?
            .reserve_escrow(&escrow_id, "unsettled-claim", &hex::encode(bytes32()?))
            .is_err();
    let refund_tx = finish(
        frost_sign(
            refund,
            &[escrow_keys[CLIENT].clone(), escrow_keys[COSIGNER].clone()],
            &escrow_group,
        )?,
        None,
        &vk,
    )?;
    let refunded = refund_tx.ironwood_bundle().is_some_and(|b| {
        b.actions()
            .iter()
            .any(|a| *a.nullifier() == escrow_nullifier)
    });
    // Separate journal: the genuine-default branch of the same note.
    let claim = draft(escrow_spec(lender.address()))?;
    let redacted_claim = redact(claim.pczt.clone());
    let claim_effects = Cosigner::default().admit_escrow(
        &escrow_ak,
        &redacted_claim,
        &escrow_nullifier,
        Outcome::UnsettledAfterCutoff,
        LENDER,
    )?;
    let claim_tx = finish(
        frost_sign(
            claim,
            &[escrow_keys[LENDER].clone(), escrow_keys[COSIGNER].clone()],
            &escrow_group,
        )?,
        None,
        &vk,
    )?;
    let fee_skim = draft(Spec {
        outputs: vec![(client_wallet, minimum - conventional_fee(1, 1, 0) - 50_000)],
        fixed_fee: Some(conventional_fee(1, 1, 0) + 50_000),
        ..escrow_spec(client_wallet)
    })?;
    let fee_skim_rejected = Cosigner::default()
        .admit_escrow(
            &escrow_ak,
            &redact(fee_skim.pczt),
            &escrow_nullifier,
            Outcome::Settled,
            CLIENT,
        )
        .is_err();

    // Comparison: a variable limit must seize a collateral-dependent amount, and the
    // lender can only check that it covers the debt by decrypting that amount.
    let variable = draft(Spec {
        outputs: vec![(
            escrow.address_at(0u32, Scope::External),
            collateral - conventional_fee(1, 1, 1),
        )],
        ..default_spec(NON_FINAL)
    })?;
    let variable_tx = finish(
        frost_sign(variable, &both(CLIENT, COSIGNER), &group)?,
        Some(&lender),
        &vk,
    )?;
    let variable_value = lender_check(
        &serialize(&variable_tx)?,
        &lender,
        &escrow_ivk,
        &roots,
        1,
        false,
        &vk,
    )?
    .lender_value;

    let report = serde_json::json!({
        "scope":"real-v6-ironwood-transactions-over-fixture-tree",
        "consensusBranch":"Nu7","tip":TIP,"maturity":MATURITY,"releaseCutoff":RELEASE_CUTOFF,
        "custody":{"frost":"2-of-3","roles":["client","cosigner","lender"],"clientOnlyViewingKey":true,
            "publicGroupFvkDiffers":true,"singleSignersRejected":single_signers_rejected},
        "default":{"txid":check.txid,"bytes":default_bytes.len(),"lockTime":MATURITY,"expiryHeight":0,
            "lenderInputSequence":format!("{NON_FINAL:#x}"),"proofAndSignaturesVerified":true,
            "lenderLearns":check.lender_value,"underpaymentRejected":underpayment_rejected,
            "overpaymentRejected":overpayment_rejected,
            "finalAtMaturity":is_final(MATURITY,&[NON_FINAL],MATURITY),
            "finalAfterMaturity":is_final(MATURITY,&[NON_FINAL],MATURITY+1),
            "shieldedOnlyLockIgnored":is_final(MATURITY,&[],TIP+1),
            "finalSequenceRejected":final_sequence_rejected,"unacceptedRootRejected":unaccepted_root_rejected,
            "secondDefaultForKeyRejected":second_default_rejected,"cosignerSawPlaintext":admitted.plaintext_values_present},
        "release":{"txid":release_tx.txid().to_string(),"bytes":release_bytes.len(),"expiryHeight":RELEASE_CUTOFF,
            "proofAndSignaturesVerified":true,"cosignerSawPlaintext":release_effects.plaintext_values_present,
            "unpaidRejected":unpaid_rejected,"afterCutoffRejected":after_cutoff_rejected,"otherNoteRejected":other_note_rejected,
            "expiryBeyondMaturityRejected":expiry_beyond_maturity_rejected,"duplicateRejected":duplicate_release_rejected,
            "spendsLockedNoteSoDefaultBecomesInvalid":release_spends.contains(&locked),
            "clientPlusLenderRecoverySigns":recovery_signs,"lenderCanDecryptRelease":lender_sees_release},
        "policyComparison":{
            "commonCeiling":{"lenderLearns":check.lender_value,"isPublicPolicyValue":check.lender_value==minimum},
            "variableLimit":{"lenderLearns":variable_value,"isPublicPolicyValue":false,"revealsCollateral":variable_value + conventional_fee(1,1,1) == collateral}},
        "escrow":{"defaultPaysEscrowExactly":check.lender_value==minimum,"cosignerSawPlaintext":refund_effects.plaintext_values_present||claim_effects.plaintext_values_present,
            "missedDeadlineRefundVerified":refunded,"refundTxid":refund_tx.txid().to_string(),"genuineDefaultClaimTxid":claim_tx.txid().to_string(),
            "wrongPartnerRejected":refund_to_lender_rejected,"outcomeMismatchRejected":settled_claim_rejected,
            "secondOutcomeRejected":second_outcome_rejected,"excessFeeRejected":fee_skim_rejected,"recoveryCost":"two conventional fees"},
        "durability":{"separateRoleDirectories":true,"defaultReservedBeforeSigning":true,"releaseReservedBeforeSigning":true,"reopenPreservesDefault":true,"reusedLenderInputRejected":reused_lender_input_rejected,"restartDuplicateReleaseRejected":restart_duplicate_rejected,"independentOperatorsDemonstrated":false,"liveSettlementVerified":false},
        "provingMsPerTransaction":prove_ms,"elapsedMs":started.elapsed().as_millis(),
        "chainRootsAuthenticated":false,"consensusLockObservedLive":false,"broadcast":false,"readyForFundedTest":false,"newTransactions":0
    });
    let mut report = report;
    if std::env::args().any(|a| a == "--export-fixture") {
        let fixture = |key: &SpendValidatingKey,
                       nullifier: &Nullifier,
                       pczt: &Pczt,
                       expiry: u32,
                       digest: [u8; 32]|
         -> Result<serde_json::Value> {
            let bytes = pczt
                .clone()
                .serialize()
                .map_err(|e| anyhow!("PCZT encoding: {e:?}"))?;
            Ok(
                serde_json::json!({"custodyKey":hex::encode(key_id(key)),"nullifier":hex::encode(nullifier.to_bytes()),
                "pczt":hex::encode(bytes),"expiryHeight":expiry,"digest":hex::encode(digest)}),
            )
        };
        report["inspectorFixtures"] = serde_json::json!({
            "release":fixture(&ak,&locked,&redacted_release,RELEASE_CUTOFF,release_effects.sighash)?,
            "escrowRefund":fixture(&escrow_ak,&escrow_nullifier,&redacted_refund,0,refund_effects.sighash)?,
            "escrowClaim":fixture(&escrow_ak,&escrow_nullifier,&redacted_claim,0,claim_effects.sighash)?,
        });
    }
    println!("{report}");
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InspectRequest {
    custody_key: String,
    nullifier: String,
    pczt: String,
}
fn hex32(v: &str) -> Result<[u8; 32]> {
    hex::decode(v)?
        .try_into()
        .map_err(|_| anyhow!("expected 32 bytes"))
}
/// Signing-service effect reader: redacted PCZT in, self-computed digest and the
/// amount-blind return policy out. Rejects any PCZT that still carries plaintext.
pub fn inspect_request() -> Result<()> {
    use std::io::Read;
    let mut input = Vec::new();
    std::io::stdin().take(4_000_001).read_to_end(&mut input)?;
    ensure!(input.len() <= 4_000_000, "oversized request");
    let request: InspectRequest = serde_json::from_slice(&input)?;
    let ak = ak_from_key(hex32(&request.custody_key)?)?;
    let frozen = Option::<Nullifier>::from(Nullifier::from_bytes(&hex32(&request.nullifier)?))
        .ok_or_else(|| anyhow!("invalid nullifier"))?;
    let pczt = Pczt::parse(&hex::decode(&request.pczt)?).map_err(|e| anyhow!("PCZT: {e:?}"))?;
    let e = effects(&pczt, &ak)?;
    println!(
        "{}",
        serde_json::json!({"digest":hex::encode(e.sighash),"nullifier":e.custody_spends.first().map(|n| hex::encode(n.to_bytes())),
            "expiryHeight":e.expiry,"lockTime":e.lock_time,"shieldedOnly":e.shielded_only,"fee":e.fee,"actions":e.actions,
            "plaintextPresent":e.plaintext_values_present,"privateReturnPolicyVerified":e.returns_only(&frozen)})
    );
    Ok(())
}

//! Private collateral experiments: offline primitives and explicitly selected
//! client-local live session / read-only chain commands. This binary never broadcasts.
//! FROST API usage follows ZF reddsa and Silicr 0767b30 (MIT OR Apache-2.0);
//! unlike Silicr's public bond FVK, nk/rivk are randomly client-held here.
use anyhow::{Result, anyhow, ensure};
use ff::{FromUniformBytes, PrimeField};
use frost::{
    Identifier, SigningPackage,
    keys::{EvenY, KeyPackage, PublicKeyPackage, dkg},
};
use orchard::{
    Note,
    keys::{FullViewingKey, Scope, SpendValidatingKey, SpendingKey},
    note::{ExtractedNoteCommitment, NoteVersion, Nullifier, RandomSeed, Rho},
    note_encryption::{CompactAction, IronwoodDomain, IronwoodNoteEncryption},
    primitives::redpallas,
    value::NoteValue,
};
use rand::TryRng;
use rand_core06::OsRng;
use reddsa_frost::frost::redpallas as frost;
use std::collections::BTreeMap;
use zcash_note_encryption::{Domain, try_compact_note_decryption};
#[cfg(feature = "chain-observer")]
mod chain_snapshot;
mod eligibility;
#[cfg(feature = "live-runner")]
mod live_session;
#[cfg(feature = "live-runner")]
mod live_transfer;
#[cfg(feature = "lock-kit")]
mod lock;
mod note_eligibility;
mod sha_binding;
#[cfg(feature = "lock-kit")]
mod signing_journal;

fn dkg_pair() -> Result<(Vec<KeyPackage>, PublicKeyPackage)> {
    let one = Identifier::try_from(1u16)?;
    let two = Identifier::try_from(2u16)?;
    let (s1, p1) = dkg::part1(one, 2, 2, OsRng)?;
    let (s2, p2) = dkg::part1(two, 2, 2, OsRng)?;
    let r1 = BTreeMap::from([(two, p2)]);
    let r2 = BTreeMap::from([(one, p1)]);
    let (s1, o1) = dkg::part2(s1, &r1)?;
    let (s2, o2) = dkg::part2(s2, &r2)?;
    let (k1, g1) = dkg::part3(&s1, &r1, &BTreeMap::from([(two, o2[&one].clone())]))?;
    let (k2, g2) = dkg::part3(&s2, &r2, &BTreeMap::from([(one, o1[&two].clone())]))?;
    ensure!(g1 == g2, "DKG disagreement");
    let even = g1.has_even_y();
    Ok((
        vec![k1.into_even_y(Some(even)), k2.into_even_y(Some(even))],
        g1.into_even_y(Some(even)),
    ))
}

fn ak(group: &PublicKeyPackage) -> Result<[u8; 32]> {
    group
        .verifying_key()
        .serialize()?
        .try_into()
        .map_err(|_| anyhow!("invalid group key"))
}

fn client_fvk(group: &PublicKeyPackage) -> Result<FullViewingKey> {
    let mut rng = rand::rngs::SysRng;
    // The client alone generates this material. It is never sent to the co-signer.
    loop {
        let mut bytes = [0u8; 32];
        rng.try_fill_bytes(&mut bytes)?;
        if let Some(sk) = Option::<SpendingKey>::from(SpendingKey::from_bytes(bytes)) {
            let mut raw = FullViewingKey::from(&sk).to_bytes();
            raw[..32].copy_from_slice(&ak(group)?);
            if let Some(fvk) = FullViewingKey::from_bytes(&raw) {
                return Ok(fvk);
            }
        }
    }
}

/// Reproduces the PINNED upstream public-FVK derivation as a negative privacy control.
fn upstream_public_fvk(group: &PublicKeyPackage) -> Result<FullViewingKey> {
    let key = ak(group)?;
    let expand = |tag| {
        let digest = blake2b_simd::Params::new()
            .hash_length(64)
            .personal(b"Silicr_FROSTbond")
            .to_state()
            .update(&key)
            .update(&[tag])
            .finalize();
        let mut bytes = [0u8; 64];
        bytes.copy_from_slice(digest.as_bytes());
        bytes
    };
    let mut raw = [0u8; 96];
    raw[..32].copy_from_slice(&key);
    raw[32..64]
        .copy_from_slice(&pasta_curves::pallas::Base::from_uniform_bytes(&expand(1)).to_repr());
    raw[64..]
        .copy_from_slice(&pasta_curves::pallas::Scalar::from_uniform_bytes(&expand(2)).to_repr());
    FullViewingKey::from_bytes(&raw).ok_or_else(|| anyhow!("invalid upstream FVK"))
}

fn encrypted_fixture(fvk: &FullViewingKey, amount: u64) -> Result<CompactAction> {
    // A synthetic output built with the real current Ironwood encryption library.
    // It is NOT evidence of a funded/mined note or chain-enforced collateral lock.
    let mut rng = rand::rngs::SysRng;
    let mut nullifier_randomness = [0u8; 64];
    rng.try_fill_bytes(&mut nullifier_randomness)?;
    let nf = Option::<Nullifier>::from(Nullifier::from_bytes(
        &pasta_curves::pallas::Base::from_uniform_bytes(&nullifier_randomness).to_repr(),
    ))
    .ok_or_else(|| anyhow!("invalid fixture nullifier"))?;
    let rho = Option::<Rho>::from(Rho::from_bytes(&nf.to_bytes()))
        .ok_or_else(|| anyhow!("invalid rho"))?;
    let note = loop {
        let mut bytes = [0u8; 32];
        rng.try_fill_bytes(&mut bytes)?;
        if let Some(seed) = Option::<RandomSeed>::from(RandomSeed::from_bytes(bytes, &rho))
            && let Some(note) = Option::<Note>::from(Note::from_parts(
                fvk.address_at(0u32, Scope::External),
                NoteValue::from_raw(amount),
                rho,
                seed,
                NoteVersion::V3,
            ))
        {
            break note;
        }
    };
    let encryptor = IronwoodNoteEncryption::new(None, note, [0u8; 512]);
    let ciphertext = encryptor.encrypt_note_plaintext();
    Ok(CompactAction::from_parts(
        nf,
        ExtractedNoteCommitment::from(note.commitment()),
        IronwoodDomain::epk_bytes(encryptor.epk()),
        ciphertext.as_ref()[..52].try_into()?,
    ))
}

fn decrypt(fvk: &FullViewingKey, action: &CompactAction) -> Option<u64> {
    try_compact_note_decryption(
        &IronwoodDomain::for_compact_action(action),
        &fvk.to_ivk(Scope::External).prepare(),
        action,
    )
    .map(|(note, _)| note.value().inner())
}

fn sign(
    keys: &[KeyPackage],
    group: &PublicKeyPackage,
    message: &[u8; 32],
    alpha: &[u8; 32],
) -> Result<[u8; 64]> {
    let mut nonces = BTreeMap::new();
    let mut commitments = BTreeMap::new();
    for key in keys {
        let (nonce, commitment) = frost::round1::commit(key.signing_share(), &mut OsRng);
        nonces.insert(*key.identifier(), nonce);
        commitments.insert(*key.identifier(), commitment);
    }
    let package = SigningPackage::new(commitments, message);
    let randomizer = frost::rerandomized::Randomizer::deserialize(alpha)?;
    let mut shares = BTreeMap::new();
    for key in keys {
        // The transaction builder supplies alpha; this is the API for that randomizer.
        #[expect(
            deprecated,
            reason = "explicit Orchard action randomizer, as in pinned ZF/Silicr integration"
        )]
        let share = frost_rerandomized::sign(&package, &nonces[key.identifier()], key, randomizer)?;
        shares.insert(*key.identifier(), share);
    }
    let params =
        frost::rerandomized::RandomizedParams::from_randomizer(group.verifying_key(), randomizer);
    frost::rerandomized::aggregate(&package, &shares, group, &params)?
        .serialize()?
        .try_into()
        .map_err(|_| anyhow!("invalid signature"))
}

fn run() -> Result<()> {
    let (keys, group) = dkg_pair()?;
    let private = client_fvk(&group)?;
    let public = upstream_public_fvk(&group)?;
    let action = encrypted_fixture(&private, 10_000)?;
    ensure!(
        decrypt(&private, &action) == Some(10_000),
        "client cannot decrypt"
    );
    ensure!(
        decrypt(&public, &action).is_none(),
        "public derivation reveals private note"
    );
    ensure!(
        decrypt(&public, &encrypted_fixture(&public, 10_000)?) == Some(10_000),
        "negative control failed"
    );
    let alpha = pasta_curves::pallas::Scalar::from_uniform_bytes(&[9u8; 64]);
    let message = [7u8; 32];
    let signature = sign(&keys, &group, &message, &alpha.to_repr())?;
    // An independently valid value proof still verifies alongside a different-
    // value note: there is no equality relation yet. This blocks real funding.
    let proof_bytes = eligibility::probe()?;
    let different_note = encrypted_fixture(&private, 1)?;
    ensure!(
        decrypt(&private, &different_note) == Some(1),
        "different-value control failed"
    );
    let vk = SpendValidatingKey::from(private).randomize(&alpha);
    vk.verify(&message, &redpallas::Signature::from(signature))?;
    ensure!(
        sign(&keys[..1], &group, &message, &alpha.to_repr()).is_err(),
        "client signed alone"
    );
    ensure!(
        sign(&keys[1..], &group, &message, &alpha.to_repr()).is_err(),
        "operator signed alone"
    );
    ensure!(
        vk.verify(&[8u8; 32], &redpallas::Signature::from(signature))
            .is_err(),
        "signature not bound to digest"
    );
    println!(
        "{}",
        serde_json::json!({
            "scope":"offline-real-cryptography-synthetic-note", "clientDecrypts":true,
            "publicFvkDerivationDecryptsClientNote":false, "upstreamPublicFvkNegativeControl":true,
            "twoPartyDkgAndRedPallasSignature":true, "eitherPartySigningAloneRejected":true,
            "changedDigestRejected":true, "privateRangeProofVerified":true,
            "privateRangeProofBytes":proof_bytes, "rangeProofBoundToRealZcashNote":false,
            "independentNoteRangeMismatchDemonstrated":true,
            "realDepositLocked":false,
            "zkCollateralEligibilityProven":false, "fhePlaintextBindingProven":false,
            "proofGatedReleaseProven":false, "endToEndOperatorBlind":false
        })
    );
    Ok(())
}
fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        #[cfg(feature = "live-runner")]
        Some("--live-session") => live_session::command(),
        Some("--sha256-binding") => sha_binding::client_probe(),
        Some("--note-eligibility") => note_eligibility::probe(),
        Some("--verify-note-eligibility") => note_eligibility::verify_request(),
        Some("--value-binding") => note_eligibility::value_binding(),
        #[cfg(feature = "chain-observer")]
        Some("--chain-snapshot") => chain_snapshot::probe().map_err(|error| {
            // This command uses only hardcoded public endpoints; no app env or
            // credentials are read. Public network diagnostics are safe here.
            eprintln!("Public testnet observation failed: {error:#}");
            error
        }),
        #[cfg(feature = "lock-kit")]
        #[cfg(feature = "lock-kit")]
        Some("--inspect-lock") => lock::inspect_request(),
        #[cfg(feature = "lock-kit")]
        Some("--lock-kit") => lock::probe().map_err(|error| {
            // Offline fixture keys only; the message carries no key or note material.
            eprintln!("Lock kit failed: {error:#}");
            error
        }),
        None => run(),
        _ => Err(anyhow!("unknown experiment")),
    };
    if result.is_err() {
        eprintln!(
            "Private-collateral command failed; private diagnostics suppressed. Preserve local state; no automatic retry."
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn real_note_encryption_and_two_party_authorization_preserve_key_separation() {
        super::run().expect("offline crypto probe");
    }
    #[cfg(feature = "lock-kit")]
    #[test]
    fn lock_kit_default_release_and_policy_checks() {
        super::lock::probe().expect("offline lock kit");
    }
}

//! Client-only ordinary-key transaction builder for the isolated funding wallet.
//! Never accepts a threshold custody key. Does not broadcast or open the old wallet.
use anyhow::{Result, anyhow, ensure};
use orchard::{
    Address, Anchor, Note,
    circuit::{OrchardCircuitVersion, VerifyingKey},
    keys::{FullViewingKey, SpendAuthorizingKey, SpendValidatingKey, SpendingKey},
    note::{NoteVersion, RandomSeed, Rho},
    tree::{MerkleHashOrchard, MerklePath},
    value::NoteValue,
};
use pczt::roles::{
    creator::Creator, io_finalizer::IoFinalizer, prover::Prover, signer::Signer,
    spend_finalizer::SpendFinalizer, tx_extractor::TransactionExtractor,
};
use rand::rngs::SysRng;
use rand_core::UnwrapErr;
use serde_json::Value;
use zcash_primitives::transaction::{
    Transaction,
    builder::{BuildConfig, Builder, BundlePadding, cached_orchard_proving_key},
    fees::zip317::FeeRule,
};
use zcash_protocol::{
    consensus::{BlockHeight, TEST_NETWORK},
    memo::MemoBytes,
    value::Zatoshis,
};

fn array<const N: usize>(value: &Value) -> Result<[u8; N]> {
    hex::decode(
        value
            .as_str()
            .ok_or_else(|| anyhow!("missing encoded bytes"))?,
    )?
    .try_into()
    .map_err(|_| anyhow!("invalid encoded length"))
}
/// Reconstruct only a scanned V3 Ironwood note, checking owner, commitment path and nullifier.
pub(super) fn scanned_note(
    n: &Value,
    fvk: &FullViewingKey,
    anchor: Anchor,
) -> Result<(Note, MerklePath)> {
    ensure!(n["spent"] == false, "note already spent");
    let recipient =
        Option::<Address>::from(Address::from_raw_address_bytes(&array(&n["recipient"])?))
            .ok_or_else(|| anyhow!("invalid recipient"))?;
    let rho = Option::<Rho>::from(Rho::from_bytes(&array(&n["rho"])?))
        .ok_or_else(|| anyhow!("invalid rho"))?;
    let seed = Option::<RandomSeed>::from(RandomSeed::from_bytes(array(&n["rseed"])?, &rho))
        .ok_or_else(|| anyhow!("invalid random seed"))?;
    let amount = n["value"]
        .as_str()
        .ok_or_else(|| anyhow!("missing note value"))?
        .parse::<u64>()?;
    let note = Option::<Note>::from(Note::from_parts(
        recipient,
        NoteValue::from_raw(amount),
        rho,
        seed,
        NoteVersion::V3,
    ))
    .ok_or_else(|| anyhow!("invalid note"))?;
    ensure!(
        note.nullifier(fvk).to_bytes() == array::<32>(&n["nullifier"])?,
        "nullifier mismatch"
    );
    ensure!(
        fvk.scope_for_address(&recipient).is_some(),
        "note is not owned by client"
    );
    let position = u32::try_from(
        n["position"]
            .as_u64()
            .ok_or_else(|| anyhow!("missing position"))?,
    )?;
    let nodes = n["path"]
        .as_array()
        .ok_or_else(|| anyhow!("missing witness"))?;
    ensure!(nodes.len() == 32, "wrong witness length");
    let mut path = Vec::new();
    for node in nodes {
        path.push(
            Option::<MerkleHashOrchard>::from(MerkleHashOrchard::from_bytes(&array(node)?))
                .ok_or_else(|| anyhow!("invalid witness node"))?,
        );
    }
    let path = MerklePath::from_parts(
        position,
        path.try_into().map_err(|_| anyhow!("wrong path length"))?,
    );
    ensure!(
        path.root(orchard::note::ExtractedNoteCommitment::from(
            note.commitment()
        )) == anchor,
        "witness is not under scanned root"
    );
    Ok((note, path))
}
/// A full shielded return pays the entire ordinary funding note less ZIP317 fee.
/// Target/expiry are live heights, never the offline lock fixture's fixed heights.
pub(super) fn return_note(
    sk: &SpendingKey,
    note: Note,
    path: MerklePath,
    anchor: Anchor,
    to: Address,
    tip: u32,
) -> Result<Transaction> {
    ensure!(
        note.value().inner() > 10_000,
        "insufficient return fee reserve"
    );
    let fvk = FullViewingKey::from(sk);
    let mut builder = Builder::new(
        TEST_NETWORK,
        BlockHeight::from_u32(
            tip.checked_add(1)
                .ok_or_else(|| anyhow!("height overflow"))?,
        ),
        BuildConfig::Standard {
            sapling_anchor: None,
            orchard_anchor: None,
            ironwood_anchor: Some(anchor),
            orchard_padding: BundlePadding::DEFAULT,
            ironwood_padding: BundlePadding::DEFAULT,
        },
    );
    let amount = note.value().inner() - 10_000;
    builder
        .add_ironwood_spend::<std::convert::Infallible>(fvk.clone(), note, path)
        .map_err(|e| anyhow!("return spend: {e}"))?;
    builder
        .add_ironwood_output::<std::convert::Infallible>(
            None,
            to,
            Zatoshis::from_u64(amount)?,
            MemoBytes::empty(),
        )
        .map_err(|e| anyhow!("return output: {e}"))?;
    let mut parts = builder
        .build_for_pczt(UnwrapErr(SysRng), &FeeRule::standard())
        .map_err(|e| anyhow!("return proposal: {e}"))?
        .pczt_parts;
    parts.expiry_height = BlockHeight::from_u32(
        tip.checked_add(40)
            .ok_or_else(|| anyhow!("height overflow"))?,
    );
    let pczt = Creator::build_from_parts(parts).ok_or_else(|| anyhow!("return PCZT"))?;
    let pczt = IoFinalizer::new(pczt)
        .finalize_io(UnwrapErr(SysRng))
        .map_err(|e| anyhow!("return IO: {e:?}"))?;
    let pczt = Prover::new(pczt)
        .create_ironwood_proof(
            UnwrapErr(SysRng),
            cached_orchard_proving_key(OrchardCircuitVersion::PostNu6_3),
        )
        .map_err(|e| anyhow!("return proof: {e:?}"))?
        .finish();
    let ak = SpendValidatingKey::from(fvk);
    let mut indices = Vec::new();
    pczt::roles::low_level_signer::Signer::new(pczt.clone())
        .sign_ironwood_with::<pczt::roles::low_level_signer::OrchardParseError, _>(|_, b, _| {
            for (i, a) in b.actions().iter().enumerate() {
                if let Some(alpha) = a.spend().alpha()
                    && ak.randomize(alpha) == *a.spend().rk()
                    && a.spend().spend_auth_sig().is_none()
                {
                    indices.push(i);
                }
            }
            Ok(())
        })
        .map_err(|e| anyhow!("return inspection: {e:?}"))?;
    ensure!(indices.len() == 1, "expected one real funding spend");
    let mut signer = Signer::new(pczt).map_err(|e| anyhow!("return signer: {e:?}"))?;
    signer
        .sign_ironwood(
            UnwrapErr(SysRng),
            indices[0],
            &SpendAuthorizingKey::from(sk),
        )
        .map_err(|e| anyhow!("return signature: {e:?}"))?;
    let pczt = SpendFinalizer::new(signer.finish())
        .finalize_spends()
        .map_err(|e| anyhow!("return finalization: {e:?}"))?;
    let vk = VerifyingKey::build(OrchardCircuitVersion::PostNu6_3);
    let tx = TransactionExtractor::new(pczt)
        .with_orchard(&vk)
        .extract(UnwrapErr(SysRng))
        .map_err(|e| anyhow!("return verification: {e:?}"))?;
    ensure!(
        tx.transparent_bundle().is_none()
            && tx.orchard_bundle().is_none()
            && tx.sapling_bundle().is_none(),
        "unexpected public or legacy pool"
    );
    let bundle = tx
        .ironwood_bundle()
        .ok_or_else(|| anyhow!("missing private return"))?;
    ensure!(
        i64::from(*bundle.value_balance()) == 10_000 && bundle.actions().len() == 2,
        "unexpected return fee"
    );
    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use incrementalmerkletree::{frontier::CommitmentTree, witness::IncrementalWitness};
    use orchard::{keys::Scope, note::ExtractedNoteCommitment};
    use rand::TryRng;
    use serde_json::json;
    fn random() -> [u8; 32] {
        let mut b = [0; 32];
        SysRng.try_fill_bytes(&mut b).unwrap();
        b
    }
    #[test]
    fn ordinary_client_can_return_a_scanned_note_and_reject_wrong_witness() -> Result<()> {
        // Synthetic tree ONLY: verifies the client exit builder, not live collateral.
        let sk = loop {
            if let Some(sk) = Option::<SpendingKey>::from(SpendingKey::from_bytes(random())) {
                break sk;
            }
        };
        let fvk = FullViewingKey::from(&sk);
        let rho = loop {
            if let Some(r) = Option::<Rho>::from(Rho::from_bytes(&random())) {
                break r;
            }
        };
        let seed = loop {
            if let Some(s) = Option::<RandomSeed>::from(RandomSeed::from_bytes(random(), &rho)) {
                break s;
            }
        };
        let recipient = fvk.address_at(0u32, Scope::External);
        let note = Option::<Note>::from(Note::from_parts(
            recipient,
            NoteValue::from_raw(900_000),
            rho,
            seed,
            NoteVersion::V3,
        ))
        .unwrap();
        let leaf = MerkleHashOrchard::from_cmx(&ExtractedNoteCommitment::from(note.commitment()));
        let mut tree = CommitmentTree::<MerkleHashOrchard, 32>::empty();
        tree.append(leaf).unwrap();
        let witness = IncrementalWitness::from_tree(tree.clone()).unwrap();
        let path = witness.path().unwrap();
        let anchor: Anchor = tree.root().into();
        let record = json!({"value":"900000","recipient":hex::encode(recipient.to_raw_address_bytes()),"rho":hex::encode(rho.to_bytes()),"rseed":hex::encode(seed.as_bytes()),"nullifier":hex::encode(note.nullifier(&fvk).to_bytes()),"position":0,"path":path.path_elems().iter().map(|h|hex::encode(h.to_bytes())).collect::<Vec<_>>(),"spent":false});
        let (recovered, path) = scanned_note(&record, &fvk, anchor)?;
        let tx = return_note(&sk, recovered, path, anchor, recipient, 4_552_000)?;
        assert_eq!(u32::from(tx.expiry_height()), 4_552_040);
        assert!(
            tx.ironwood_bundle()
                .unwrap()
                .actions()
                .iter()
                .any(|a| a.nullifier() == &note.nullifier(&fvk))
        );
        let mut wrong = record.clone();
        wrong["value"] = json!("900001");
        assert!(scanned_note(&wrong, &fvk, anchor).is_err());
        wrong = record.clone();
        wrong["position"] = json!(1);
        assert!(scanned_note(&wrong, &fvk, anchor).is_err());
        wrong = record;
        wrong["spent"] = json!(true);
        assert!(scanned_note(&wrong, &fvk, anchor).is_err());
        Ok(())
    }
}

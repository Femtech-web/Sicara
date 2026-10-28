//! Client-local isolated session and compact-block scanner. No broadcasting.
//! Viewing material and decrypted notes are written ONLY under client/. This is
//! a one-machine test harness, not a claim of independent remote DKG parties.
use anyhow::{Result, anyhow, ensure};
use incrementalmerkletree::witness::IncrementalWitness;
use orchard::{
    keys::{FullViewingKey, Scope},
    note::{ExtractedNoteCommitment, Nullifier},
    note_encryption::{CompactAction, IronwoodDomain},
    tree::MerkleHashOrchard,
};
use rand::TryRng;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tonic::transport::{ClientTlsConfig, Endpoint};
use zcash_client_backend::proto::service::{
    BlockId, BlockRange, ChainSpec, Empty, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_keys::{address::UnifiedAddress, encoding::AddressCodec};
use zcash_note_encryption::{EphemeralKeyBytes, try_compact_note_decryption};
use zcash_protocol::consensus::TEST_NETWORK;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: String,
    session: Option<String>,
    scenario: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    version: u8,
    id: String,
    birthday: u32,
    trust: String,
    collateral_addresses: Vec<(String, String)>,
    lender_transparent_address: String,
}
fn bytes32() -> Result<[u8; 32]> {
    let mut b = [0; 32];
    rand::rngs::SysRng.try_fill_bytes(&mut b)?;
    Ok(b)
}
fn dir(p: &Path) -> Result<()> {
    let mut b = fs::DirBuilder::new();
    b.mode(0o700);
    b.create(p)?;
    File::open(p.parent().ok_or_else(|| anyhow!("missing parent"))?)?.sync_all()?;
    Ok(())
}
fn save(p: &Path, v: &impl Serialize) -> Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(p)?;
    f.write_all(&serde_json::to_vec(v)?)?;
    f.sync_all()?;
    File::open(p.parent().ok_or_else(|| anyhow!("missing parent"))?)?.sync_all()?;
    Ok(())
}
fn replace_private(p: &Path, v: &impl Serialize) -> Result<()> {
    let temp = p.with_extension(format!("{}.tmp", hex::encode(bytes32()?)));
    save(&temp, v)?;
    fs::rename(temp, p)?;
    File::open(p.parent().ok_or_else(|| anyhow!("missing parent"))?)?.sync_all()?;
    Ok(())
}
fn address(fvk: &FullViewingKey) -> Result<String> {
    Ok(UnifiedAddress::from_receivers(
        Some(fvk.address_at(0u32, Scope::External)),
        None,
        None,
        None,
        None,
    )
    .ok_or_else(|| anyhow!("invalid receiver"))?
    .encode(&TEST_NETWORK))
}
fn root_dir() -> Result<PathBuf> {
    ensure!(
        Path::new("experiments/private-collateral/native/Cargo.toml").is_file(),
        "run from Sicara root"
    );
    let p = PathBuf::from(".local/isolated-live");
    fs::create_dir_all(&p)?;
    fs::set_permissions(&p, fs::Permissions::from_mode(0o700))?;
    Ok(p)
}
fn session_dir(id: &str) -> Result<PathBuf> {
    ensure!(
        id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid session id"
    );
    Ok(root_dir()?.join(id))
}

async fn connect() -> Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    let channel = Endpoint::from_static("https://testnet.zec.rocks:443")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?
        .connect()
        .await?;
    let mut client = CompactTxStreamerClient::new(channel).max_decoding_message_size(4_000_000);
    ensure!(
        client
            .get_lightd_info(Empty {})
            .await?
            .into_inner()
            .chain_name
            == "test",
        "wrong network"
    );
    Ok(client)
}
async fn create() -> Result<Value> {
    let mut client = connect().await?;
    let tip = client
        .get_latest_block(ChainSpec {})
        .await?
        .into_inner()
        .height;
    ensure!((10..500_000_000).contains(&tip), "invalid testnet height");
    let id = hex::encode(&bytes32()?[..16]);
    let directory = session_dir(&id)?;
    dir(&directory)?;
    for role in ["client", "cosigner", "lender", "public"] {
        dir(&directory.join(role))?;
    }
    let mut receivers = Vec::new();
    let funding_key = loop {
        if let Some(sk) = Option::<orchard::keys::SpendingKey>::from(
            orchard::keys::SpendingKey::from_bytes(bytes32()?),
        ) {
            break sk;
        }
    };
    let funding_fvk = FullViewingKey::from(&funding_key);
    let funding_address = address(&funding_fvk)?;
    save(
        &directory.join("client/funding.json"),
        &json!({"version":1,"spendingKey":hex::encode(funding_key.to_bytes()),"fvk":hex::encode(funding_fvk.to_bytes())}),
    )?;
    save(
        &directory.join("public/funding.json"),
        &json!({"version":1,"address":funding_address,"birthday":tip.saturating_sub(2)}),
    )?;
    for scenario in ["release", "default", "recovery"] {
        let (keys, group) = super::lock::dkg_three()?;
        let fvk = super::client_fvk(&group)?;
        let (escrow_keys, escrow_group) = super::lock::dkg_three()?;
        let escrow = super::client_fvk(&escrow_group)?;
        let public = json!({"version":1,"network":"zcash-testnet","scenario":scenario,"group":hex::encode(group.serialize()?),"escrowGroup":hex::encode(escrow_group.serialize()?),"custodyKey":hex::encode(super::ak(&group)?),"escrowKey":hex::encode(super::ak(&escrow_group)?),"address":address(&fvk)?,"escrowAddress":address(&escrow)?,"birthday":tip.saturating_sub(2)});
        save(
            &directory.join("public").join(format!("{scenario}.json")),
            &public,
        )?;
        for (i, role) in ["client", "cosigner", "lender"].iter().enumerate() {
            let mut private = json!({"version":1,"scenario":scenario,"keyPackage":hex::encode(keys[i].serialize()?),"escrowKeyPackage":hex::encode(escrow_keys[i].serialize()?)});
            if i == 0 {
                private["fvk"] = json!(hex::encode(fvk.to_bytes()));
            }
            if i == 0 || i == 2 {
                private["escrowFvk"] = json!(hex::encode(escrow.to_bytes()));
            }
            save(
                &directory.join(role).join(format!("{scenario}.json")),
                &private,
            )?;
        }
        receivers.push((scenario.to_string(), address(&fvk)?));
    }
    let transparent = secp256k1::SecretKey::from_secret_bytes(bytes32()?)?;
    let public = secp256k1::PublicKey::from_secret_key(&transparent);
    let taddr =
        zcash_transparent::address::TransparentAddress::from_pubkey(&public).encode(&TEST_NETWORK);
    save(
        &directory.join("lender/transparent.json"),
        &json!({"network":"zcash-testnet","secretKey":hex::encode(transparent.to_secret_bytes())}),
    )?;
    let session = Session {
        version: 1,
        id: id.clone(),
        birthday: tip.saturating_sub(2) as u32,
        trust: "owner-approved-single-server-isolated-test-only".into(),
        collateral_addresses: receivers,
        lender_transparent_address: taddr,
    };
    save(&directory.join("session.json"), &session)?;
    Ok(
        json!({"session":id,"directory":directory,"state":"keys-created-not-funded","birthday":session.birthday,"fundingAddress":funding_address,"rolesSeparatedOnDisk":true,"independentOperators":false,"viewingMaterialPrinted":false,"fundingEnabled":false,"broadcastEnabled":false}),
    )
}
fn read_fvk(directory: &Path, scenario: &str) -> Result<FullViewingKey> {
    let v: Value = serde_json::from_slice(&fs::read(
        directory.join("client").join(format!("{scenario}.json")),
    )?)?;
    let bytes = hex::decode(
        v["fvk"]
            .as_str()
            .ok_or_else(|| anyhow!("client viewing key missing"))?,
    )?;
    FullViewingKey::from_bytes(
        &bytes
            .try_into()
            .map_err(|_| anyhow!("invalid viewing material"))?,
    )
    .ok_or_else(|| anyhow!("invalid viewing key"))
}
async fn scan(id: &str, scenario: &str) -> Result<Value> {
    ensure!(
        ["funding", "release", "default", "recovery"].contains(&scenario),
        "invalid scenario"
    );
    let directory = session_dir(id)?;
    let s: Session = serde_json::from_slice(&fs::read(directory.join("session.json"))?)?;
    ensure!(s.version == 1 && s.id == id, "session mismatch");
    let fvk = read_fvk(&directory, scenario)?;
    let ivk = fvk.to_ivk(Scope::External).prepare();
    let mut client = connect().await?;
    let tip = client
        .get_latest_block(ChainSpec {})
        .await?
        .into_inner()
        .height;
    let end = tip.checked_sub(9).ok_or_else(|| anyhow!("tip too low"))?;
    if end < u64::from(s.birthday) {
        return Ok(
            json!({"state":"awaiting-confirmations","session":id,"scenario":scenario,"tip":tip,"broadcastEnabled":false}),
        );
    }
    ensure!(
        end - u64::from(s.birthday) < 10_000,
        "scan window exceeded; do not silently change birthday"
    );
    let start = client
        .get_tree_state(BlockId {
            height: u64::from(s.birthday) - 1,
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(
        start.network == "test" && start.height == u64::from(s.birthday) - 1,
        "bad birthday state"
    );
    let mut tree = start.ironwood_tree()?;
    let mut prev = hex::decode(&start.hash)?;
    prev.reverse();
    let mut stream = client
        .get_block_range(BlockRange {
            start: Some(BlockId {
                height: u64::from(s.birthday),
                hash: vec![],
            }),
            end: Some(BlockId {
                height: end,
                hash: vec![],
            }),
            pool_types: vec![],
        })
        .await?
        .into_inner();
    let mut expected = u64::from(s.birthday);
    let mut found: Vec<(Value, IncrementalWitness<MerkleHashOrchard, 32>, [u8; 32])> = Vec::new();
    let mut spent = std::collections::BTreeSet::new();
    while let Some(block) = stream.message().await? {
        ensure!(
            block.height == expected && block.prev_hash == prev && block.hash.len() == 32,
            "compact chain discontinuity"
        );
        prev = block.hash;
        expected += 1;
        for tx in block.vtx {
            for (index, a) in tx.ironwood_actions.iter().enumerate() {
                let nf_bytes: [u8; 32] = a.nullifier.as_slice().try_into()?;
                spent.insert(nf_bytes);
                let nf = Option::<Nullifier>::from(Nullifier::from_bytes(&nf_bytes))
                    .ok_or_else(|| anyhow!("invalid nullifier"))?;
                let cmx = Option::<ExtractedNoteCommitment>::from(
                    ExtractedNoteCommitment::from_bytes(&a.cmx.as_slice().try_into()?),
                )
                .ok_or_else(|| anyhow!("invalid commitment"))?;
                let leaf = MerkleHashOrchard::from_cmx(&cmx);
                for (_, w, _) in &mut found {
                    w.append(leaf).map_err(|_| anyhow!("witness full"))?;
                }
                tree.append(leaf).map_err(|_| anyhow!("tree full"))?;
                let action = CompactAction::from_parts(
                    nf,
                    cmx,
                    EphemeralKeyBytes(a.ephemeral_key.as_slice().try_into()?),
                    a.ciphertext.as_slice().try_into()?,
                );
                if let Some((note, recipient)) = try_compact_note_decryption(
                    &IronwoodDomain::for_compact_action(&action),
                    &ivk,
                    &action,
                ) {
                    ensure!(
                        ExtractedNoteCommitment::from(note.commitment()) == cmx,
                        "decrypted commitment mismatch"
                    );
                    let nullifier = note.nullifier(&fvk).to_bytes();
                    let mut txid = tx.txid.clone();
                    txid.reverse();
                    let private = json!({"txid":hex::encode(txid),"action":index,"height":block.height,"value":note.value().inner().to_string(),"recipient":hex::encode(recipient.to_raw_address_bytes()),"rho":hex::encode(note.rho().to_bytes()),"rseed":hex::encode(note.rseed().as_bytes()),"nullifier":hex::encode(nullifier)});
                    found.push((
                        private,
                        IncrementalWitness::from_tree(tree.clone())
                            .ok_or_else(|| anyhow!("empty witness"))?,
                        nullifier,
                    ));
                }
            }
        }
    }
    ensure!(expected == end + 1, "incomplete compact stream");
    let final_state = client
        .get_tree_state(BlockId {
            height: end,
            hash: vec![],
        })
        .await?
        .into_inner();
    let mut hash = prev;
    hash.reverse();
    ensure!(
        final_state.height == end
            && final_state.network == "test"
            && final_state.hash.to_lowercase() == hex::encode(hash)
            && final_state.ironwood_tree()?.root() == tree.root(),
        "root/hash mismatch or observed reorg"
    );
    let mut notes = Vec::new();
    for (mut n, w, nf) in found {
        ensure!(w.root() == tree.root(), "witness root mismatch");
        let path = w.path().ok_or_else(|| anyhow!("missing note path"))?;
        n["position"] = json!(u64::from(path.position()));
        n["path"] = json!(
            path.path_elems()
                .iter()
                .map(|h| hex::encode(h.to_bytes()))
                .collect::<Vec<_>>()
        );
        n["spent"] = json!(spent.contains(&nf));
        notes.push(n);
    }
    let unspent = notes
        .iter()
        .filter(|n| n["spent"] == false && n["value"].as_str() != Some("0"))
        .count();
    let mut funding_verified = false;
    let mut funding_confirmations = 0;
    if scenario == "funding" {
        let receipt_path = directory.join("public/funding-receipt.json");
        if receipt_path.exists() {
            let receipt: Value = serde_json::from_slice(&fs::read(receipt_path)?)?;
            ensure!(
                receipt["session"] == id,
                "funding receipt identity mismatch"
            );
            let amount = receipt["amountZats"]
                .as_str()
                .ok_or_else(|| anyhow!("missing funding amount"))?
                .parse::<u64>()?;
            let fee = receipt["feeZats"]
                .as_str()
                .ok_or_else(|| anyhow!("missing funding fee"))?
                .parse::<u64>()?;
            ensure!(
                amount
                    .checked_add(fee)
                    .is_some_and(|total| total <= 1_000_000),
                "funding receipt exceeds grant"
            );
            let matches: Vec<_> = notes
                .iter()
                .filter(|n| {
                    n["txid"] == receipt["txid"]
                        && n["value"] == receipt["amountZats"]
                        && n["spent"] == false
                })
                .collect();
            ensure!(matches.len() <= 1, "ambiguous funding receipt");
            funding_verified = matches.len() == 1;
            if funding_verified {
                let received_height = matches[0]["height"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("missing deposit height"))?;
                funding_confirmations = tip - received_height + 1;
                ensure!(funding_confirmations >= 10, "funding is not confirmed");
            }
            replace_private(
                &directory.join("public/funding-observation.json"),
                &json!({"session":id,"txid":receipt["txid"],"confirmed":funding_verified,"confirmations":funding_confirmations,"tip":tip,"anchorHeight":end,"anchorHash":final_state.hash,"trust":"owner-approved-single-server-isolated-test-only","scope":"as-of-confirmed-anchor-not-current-unspent-proof"}),
            )?;
        }
    }

    replace_private(
        &directory
            .join("client")
            .join(format!("{scenario}-scan.json")),
        &json!({"version":1,"session":id,"scenario":scenario,"tip":tip,"anchorHeight":end,"blockHash":final_state.hash,"root":hex::encode(tree.root().to_bytes()),"notes":notes}),
    )?;
    Ok(
        json!({"session":id,"scenario":scenario,"state":if unspent>0{"confirmed-note-found"}else{"awaiting-deposit"},"confirmedUnspentNotes":unspent,"tip":tip,"anchorHeight":end,"root":hex::encode(tree.root().to_bytes()),"fundingReceiptVerified":funding_verified,"fundingConfirmations":funding_confirmations,"valuesPrinted":false,"broadcastEnabled":false}),
    )
}
fn audit_session(id: &str) -> Result<Value> {
    use reddsa_frost::frost::redpallas::keys::{KeyPackage, PublicKeyPackage};
    let directory = session_dir(id)?;
    let session: Session = serde_json::from_slice(&fs::read(directory.join("session.json"))?)?;
    ensure!(session.id == id && session.version == 1, "wrong session");
    let funding = read_fvk(&directory, "funding")?;
    let secret: Value = serde_json::from_slice(&fs::read(directory.join("client/funding.json"))?)?;
    let raw: [u8; 32] = hex::decode(
        secret["spendingKey"]
            .as_str()
            .ok_or_else(|| anyhow!("missing funding key"))?,
    )?
    .try_into()
    .map_err(|_| anyhow!("wrong funding key length"))?;
    let key =
        Option::<orchard::keys::SpendingKey>::from(orchard::keys::SpendingKey::from_bytes(raw))
            .ok_or_else(|| anyhow!("bad funding key"))?;
    let public: Value = serde_json::from_slice(&fs::read(directory.join("public/funding.json"))?)?;
    ensure!(
        FullViewingKey::from(&key) == funding && public["address"] == address(&funding)?,
        "funding key/receiver mismatch"
    );
    ensure!(
        fs::metadata(directory.join("client/funding.json"))?
            .permissions()
            .mode()
            & 0o077
            == 0,
        "insecure funding key permissions"
    );
    let mut custody_keys = std::collections::BTreeSet::new();
    for scenario in ["release", "default", "recovery"] {
        let public: Value = serde_json::from_slice(&fs::read(
            directory.join("public").join(format!("{scenario}.json")),
        )?)?;
        ensure!(
            public["fvk"].is_null()
                && public["escrowFvk"].is_null()
                && public["keyPackage"].is_null(),
            "private material in public metadata"
        );
        let decode = |name: &str| -> Result<PublicKeyPackage> {
            Ok(PublicKeyPackage::deserialize(&hex::decode(
                public[name]
                    .as_str()
                    .ok_or_else(|| anyhow!("missing public key"))?,
            )?)?)
        };
        let group = decode("group")?;
        let escrow_group = decode("escrowGroup")?;
        let fvk = read_fvk(&directory, scenario)?;
        ensure!(
            super::ak(&group)? == fvk.to_bytes()[..32],
            "viewing/spend key mismatch"
        );
        ensure!(
            public["address"] == address(&fvk)?,
            "deposit receiver mismatch"
        );
        ensure!(
            custody_keys.insert(hex::encode(super::ak(&group)?)),
            "reused custody key"
        );
        ensure!(
            super::ak(&group)? != super::ak(&escrow_group)?,
            "custody and escrow keys reused"
        );
        let mut seen = std::collections::BTreeSet::new();
        for role in ["client", "cosigner", "lender"] {
            let file = directory.join(role).join(format!("{scenario}.json"));
            ensure!(
                fs::symlink_metadata(&file)?.is_file()
                    && fs::metadata(&file)?.permissions().mode() & 0o077 == 0,
                "insecure share permissions"
            );
            let private: Value = serde_json::from_slice(&fs::read(file)?)?;
            ensure!(
                role == "client" || private["fvk"].is_null(),
                "collateral viewing key outside client"
            );
            ensure!(
                role != "cosigner" || private["escrowFvk"].is_null(),
                "escrow viewing key sent to cosigner"
            );
            let key = KeyPackage::deserialize(&hex::decode(
                private["keyPackage"]
                    .as_str()
                    .ok_or_else(|| anyhow!("missing share"))?,
            )?)?;
            let escrow = KeyPackage::deserialize(&hex::decode(
                private["escrowKeyPackage"]
                    .as_str()
                    .ok_or_else(|| anyhow!("missing escrow share"))?,
            )?)?;
            ensure!(
                key.verifying_key() == group.verifying_key()
                    && group.verifying_shares().get(key.identifier())
                        == Some(key.verifying_share()),
                "share/group mismatch"
            );
            ensure!(
                escrow.verifying_key() == escrow_group.verifying_key()
                    && escrow_group.verifying_shares().get(escrow.identifier())
                        == Some(escrow.verifying_share()),
                "escrow share/group mismatch"
            );
            ensure!(
                seen.insert(hex::encode(key.identifier().serialize())),
                "reused signer identifier"
            );
            if role != "cosigner" {
                let raw: [u8; 96] = hex::decode(
                    private["escrowFvk"]
                        .as_str()
                        .ok_or_else(|| anyhow!("missing escrow viewing key"))?,
                )?
                .try_into()
                .map_err(|_| anyhow!("wrong escrow key length"))?;
                let escrow_fvk = FullViewingKey::from_bytes(&raw)
                    .ok_or_else(|| anyhow!("bad escrow viewing key"))?;
                ensure!(
                    super::ak(&escrow_group)? == escrow_fvk.to_bytes()[..32]
                        && public["escrowAddress"] == address(&escrow_fvk)?,
                    "escrow receiver mismatch"
                );
            }
        }
    }
    Ok(
        json!({"session":id,"state":"local-key-audit-passed","scenarios":3,"collateralViewingKeyClientOnly":true,"independentOperators":false,"readyForFundedLock":false,"broadcastEnabled":false}),
    )
}
fn audit_funding_note(id: &str) -> Result<Value> {
    audit_session(id)?;
    let directory = session_dir(id)?;
    let scan: Value =
        serde_json::from_slice(&fs::read(directory.join("client/funding-scan.json"))?)?;
    let receipt: Value =
        serde_json::from_slice(&fs::read(directory.join("public/funding-receipt.json"))?)?;
    ensure!(
        scan["session"] == id && scan["scenario"] == "funding" && receipt["session"] == id,
        "funding witness identity mismatch"
    );
    let root: [u8; 32] = hex::decode(
        scan["root"]
            .as_str()
            .ok_or_else(|| anyhow!("missing root"))?,
    )?
    .try_into()
    .map_err(|_| anyhow!("wrong root length"))?;
    let anchor = Option::<orchard::Anchor>::from(orchard::Anchor::from_bytes(root))
        .ok_or_else(|| anyhow!("invalid anchor"))?;
    let tip = scan["tip"].as_u64().ok_or_else(|| anyhow!("missing tip"))?;
    let anchor_height = scan["anchorHeight"]
        .as_u64()
        .ok_or_else(|| anyhow!("missing anchor height"))?;
    ensure!(
        anchor_height.checked_add(9) == Some(tip),
        "invalid confirmation boundary"
    );
    let notes = scan["notes"]
        .as_array()
        .ok_or_else(|| anyhow!("missing notes"))?;
    let matches: Vec<_> = notes
        .iter()
        .filter(|n| {
            n["txid"] == receipt["txid"]
                && n["spent"] == false
                && n["value"] == receipt["amountZats"]
        })
        .collect();
    ensure!(matches.len() == 1, "one confirmed funding note required");
    let received_height = matches[0]["height"]
        .as_u64()
        .ok_or_else(|| anyhow!("missing note height"))?;
    ensure!(
        received_height <= anchor_height,
        "note not under confirmed anchor"
    );
    let (note, _) =
        super::live_transfer::scanned_note(matches[0], &read_fvk(&directory, "funding")?, anchor)?;
    ensure!(
        note.value().inner() == 900_000,
        "unexpected authorized funding note"
    );
    let report = json!({"session":id,"state":"live-funding-witness-audit-passed","txid":receipt["txid"],"anchorHeight":anchor_height,"confirmationsAtScan":tip-received_height+1,"commitmentPathAndOwnerVerified":true,"valuesPrinted":false,"readyForFundedLock":false,"broadcastEnabled":false,"scope":"client-funding-note-under-previously-observed-test-root; not-a-collateral-lock-or-fresh-unspent-proof"});
    replace_private(
        &directory.join("public/funding-witness-audit.json"),
        &report,
    )?;
    Ok(report)
}
async fn prepare_return(id: &str) -> Result<Value> {
    let directory = session_dir(id)?;
    let auth: Value = serde_json::from_slice(&fs::read(
        directory.join("public/funding-authorization.json"),
    )?)?;
    ensure!(
        auth["session"] == id && auth["network"] == "zcash-testnet",
        "funding authorization mismatch"
    );
    let destination = UnifiedAddress::decode(
        &TEST_NETWORK,
        auth["returnAddress"]
            .as_str()
            .ok_or_else(|| anyhow!("missing return address"))?,
    )?;
    let to = *destination
        .orchard()
        .ok_or_else(|| anyhow!("shielded return receiver required"))?;
    let scan: Value =
        serde_json::from_slice(&fs::read(directory.join("client/funding-scan.json"))?)?;
    ensure!(
        scan["session"] == id && scan["scenario"] == "funding",
        "scan identity mismatch"
    );
    let scan_tip = scan["tip"]
        .as_u64()
        .ok_or_else(|| anyhow!("missing scan tip"))?;
    let height = scan["anchorHeight"]
        .as_u64()
        .ok_or_else(|| anyhow!("missing anchor height"))?;
    ensure!(
        height.checked_add(9) == Some(scan_tip),
        "insufficient confirmations"
    );
    let mut client = connect().await?;
    let tip = client
        .get_latest_block(ChainSpec {})
        .await?
        .into_inner()
        .height;
    ensure!(
        tip >= scan_tip && tip <= scan_tip + 2,
        "rescan before preparing a return"
    );
    let state = client
        .get_tree_state(BlockId {
            height,
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(
        state.network == "test"
            && state.height == height
            && scan["blockHash"] == state.hash
            && scan["root"] == hex::encode(state.ironwood_tree()?.root().to_bytes()),
        "return anchor changed"
    );
    let fvk = read_fvk(&directory, "funding")?;
    let secret: Value = serde_json::from_slice(&fs::read(directory.join("client/funding.json"))?)?;
    let key: [u8; 32] = hex::decode(
        secret["spendingKey"]
            .as_str()
            .ok_or_else(|| anyhow!("missing client key"))?,
    )?
    .try_into()
    .map_err(|_| anyhow!("invalid client key length"))?;
    let sk =
        Option::<orchard::keys::SpendingKey>::from(orchard::keys::SpendingKey::from_bytes(key))
            .ok_or_else(|| anyhow!("invalid client key"))?;
    ensure!(FullViewingKey::from(&sk) == fvk, "client key mismatch");
    let notes = scan["notes"]
        .as_array()
        .ok_or_else(|| anyhow!("missing scanned notes"))?;
    let unspent: Vec<_> = notes
        .iter()
        .filter(|n| n["spent"] == false && n["value"].as_str() != Some("0"))
        .collect();
    ensure!(
        unspent.len() == 1,
        "expected one funding note; manual reconciliation required"
    );
    let root = state.ironwood_tree()?.root().into();
    let (note, path) = super::live_transfer::scanned_note(unspent[0], &fvk, root)?;
    ensure!(
        note.value().inner() <= 1_000_000,
        "funding note exceeds authorized budget"
    );
    // Write-ahead single-input decision. A crash blocks a replacement builder;
    // reconcile this intent instead of creating another signed transaction.
    save(
        &directory.join("client/funding-spend-intent.json"),
        &json!({"version":1,"session":id,"kind":"return","nullifier":unspent[0]["nullifier"],"destination":auth["returnAddress"],"anchorHeight":height,"anchorHash":state.hash}),
    )?;
    let tx = super::live_transfer::return_note(&sk, note, path, root, to, u32::try_from(tip)?)?;
    let mut raw = Vec::new();
    tx.write(&mut raw)?;
    save(
        &directory.join("client/funding-return.json"),
        &json!({"version":1,"session":id,"network":"zcash-testnet","txid":tx.txid().to_string(),"rawTransaction":hex::encode(raw),"expiryHeight":u32::from(tx.expiry_height()),"anchorHeight":height,"anchorHash":state.hash}),
    )?;
    Ok(
        json!({"session":id,"state":"shielded-return-prepared-not-broadcast","txid":tx.txid().to_string(),"expiryHeight":u32::from(tx.expiry_height()),"broadcastEnabled":false,"valuesPrinted":false}),
    )
}
pub fn command() -> Result<()> {
    ensure!(
        std::env::args().any(|a| a == "--trusted-test-source"),
        "explicit isolated-test trust flag required"
    );
    let mut input = Vec::new();
    std::io::stdin().take(4097).read_to_end(&mut input)?;
    ensure!(input.len() <= 4096, "oversized request");
    let request: Request = serde_json::from_slice(&input)?;
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(120), async {
                match request.action.as_str() {
                    "create" => create().await,
                    "scan" => {
                        scan(
                            request
                                .session
                                .as_deref()
                                .ok_or_else(|| anyhow!("session required"))?,
                            request
                                .scenario
                                .as_deref()
                                .ok_or_else(|| anyhow!("scenario required"))?,
                        )
                        .await
                    }
                    "audit-note" => audit_funding_note(
                        request
                            .session
                            .as_deref()
                            .ok_or_else(|| anyhow!("session required"))?,
                    ),
                    "audit" => audit_session(
                        request
                            .session
                            .as_deref()
                            .ok_or_else(|| anyhow!("session required"))?,
                    ),
                    "prepare-return" => {
                        prepare_return(
                            request
                                .session
                                .as_deref()
                                .ok_or_else(|| anyhow!("session required"))?,
                        )
                        .await
                    }
                    _ => Err(anyhow!("unsupported live stage")),
                }
            })
            .await
            .map_err(|_| anyhow!("bounded live operation timed out"))?
        })?;
    println!("{result}");
    Ok(())
}

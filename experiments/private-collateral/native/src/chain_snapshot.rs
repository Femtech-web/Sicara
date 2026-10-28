//! Read-only, pinned TLS lightwalletd observations. This is NOT a consensus proof.
//! No wallet, viewing material, note identifiers, addresses or send RPCs are used.
use anyhow::{Result, ensure};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use zcash_client_backend::proto::service::{
    BlockId, ChainSpec, Empty, TreeState, compact_tx_streamer_client::CompactTxStreamerClient,
};

// Pinned sources: (endpoint, operator, indexer stack). A quorum must agree and ANY
// responding disagreement fails closed; an unreachable source is reported, never
// replaced by a client-supplied endpoint. Endpoints of one operator are never
// counted as independent: they only cross-check implementations.
const SERVERS: [(&str, &str, &str); 6] = [
    ("https://testnet.zec.rocks:443", "zec.rocks", "lightwalletd"),
    (
        "https://zaino.testnet.unsafe.zec.rocks:443",
        "zec.rocks",
        "zaino",
    ),
    (
        "https://lightwalletd.testnet.electriccoin.co:9067",
        "ecc",
        "lightwalletd",
    ),
    ("https://lwd.testnet.zec.pro:443", "zec.pro", "lightwalletd"),
    (
        "https://zcash-testnet.chainsafe.dev:443",
        "chainsafe",
        "lightwalletd",
    ),
    // Operator-published testnet endpoint: github.com/Kenbak/zecblock README.
    (
        "https://lightwalletd.testnet.cipherscan.app:443",
        "cipherscan",
        "lightwalletd",
    ),
];
const QUORUM: usize = 2;
type Client = CompactTxStreamerClient<Channel>;
async fn connect(server: &'static str) -> Result<Client> {
    let channel = Endpoint::from_static(server)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(10))
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?
        .connect()
        .await?;
    Ok(CompactTxStreamerClient::new(channel).max_decoding_message_size(2_000_000))
}
async fn tip(client: &mut Client) -> Result<u64> {
    let info = client.get_lightd_info(Empty {}).await?.into_inner();
    ensure!(info.chain_name == "test", "wrong observer network");
    ensure!(
        info.block_height >= 10 && info.estimated_height.saturating_sub(info.block_height) < 10,
        "observer not synced"
    );
    let tip = client.get_latest_block(ChainSpec {}).await?.into_inner();
    ensure!(
        tip.height.abs_diff(info.block_height) <= 10,
        "unstable observer tip"
    );
    Ok(tip.height)
}
async fn tree(client: &mut Client, height: u64) -> Result<TreeState> {
    let tree = client
        .get_tree_state(BlockId {
            height,
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(
        tree.network == "test" && tree.height == height,
        "wrong tree network or height"
    );
    ensure!(
        tree.hash.len() == 64 && hex::decode(&tree.hash)?.len() == 32,
        "invalid tree block hash"
    );
    ensure!(!tree.ironwood_tree.is_empty(), "active pool tree missing");
    Ok(tree)
}
/// Observe quorum agreement at a shared confirmed height, then re-read the same block.
pub fn probe() -> Result<()> {
    // Explicit owner-approved TEST mode, never an automatic quorum fallback.
    let trusted_test = std::env::args().any(|a| a == "--trusted-test-source");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(90), async {
                let mut live = Vec::new();
                let mut unavailable = Vec::new();
                let mut attempts = tokio::task::JoinSet::new();
                for (server, operator, stack) in SERVERS {
                    if trusted_test && server != "https://testnet.zec.rocks:443" { continue; }
                    attempts.spawn(async move {
                    let attempt = tokio::time::timeout(Duration::from_secs(15), async {
                        let mut client = connect(server).await?;
                        let height = tip(&mut client).await?;
                        Ok::<_, anyhow::Error>((client, height))
                    })
                    .await;
                    (server, operator, stack, attempt)
                    });
                }
                while let Some(result) = attempts.join_next().await {
                    let (server, operator, stack, attempt) = result?;
                    match attempt {
                        Ok(Ok((client, height))) => live.push((server, client, height, operator, stack)),
                        Ok(Err(e)) => unavailable.push(serde_json::json!({"source":server,"reason":format!("{e:#}")})),
                        Err(_) => unavailable.push(serde_json::json!({"source":server,"reason":"deadline"})),
                    }
                }
                live.sort_by_key(|l| l.0);
                ensure!(
                    live.len() >= if trusted_test { 1 } else { QUORUM },
                    "fewer than {QUORUM} pinned sources reachable: {}",
                    serde_json::Value::from(unavailable)
                );
                let low = live.iter().map(|l| l.2).min().unwrap_or_default();
                let high = live.iter().map(|l| l.2).max().unwrap_or_default();
                let tips: Vec<_> = live.iter().map(|l| serde_json::json!({"source":l.0,"tip":l.2})).collect();
                ensure!(high - low <= 10, "observer tips disagree: {}", serde_json::Value::from(tips));
                let height = low - 9;
                let mut seen = Vec::new();
                for (_, client, ..) in live.iter_mut() {
                    let t = tree(client, height).await?;
                    seen.push((t.hash.to_lowercase(), t.ironwood_tree()?.root().to_bytes()));
                }
                ensure!(seen.windows(2).all(|w| w[0] == w[1]), "observer block/root disagreement");
                for (i, (_, client, ..)) in live.iter_mut().enumerate() {
                    let again = tree(client, height).await?;
                    ensure!(
                        (again.hash.to_lowercase(), again.ironwood_tree()?.root().to_bytes()) == seen[i],
                        "snapshot changed during check"
                    );
                }
                let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
                let sources: Vec<_> = live.iter().map(|l| serde_json::json!({"source":l.0,"operator":l.3,"stack":l.4})).collect();
                let operators: std::collections::BTreeSet<_> = live.iter().map(|l| l.3).collect();
                let stacks: std::collections::BTreeSet<_> = live.iter().map(|l| l.4).collect();
                // One operator behind two stacks rules out an indexer bug, not a lying operator.
                let kind = if trusted_test { "trusted-single-server-test-only" } else if operators.len() >= QUORUM {
                    "cross-checked-trusted-rpc"
                } else {
                    ensure!(stacks.len() >= QUORUM, "agreeing sources share operator and stack");
                    "single-operator-cross-implementation"
                };
                println!("{}", serde_json::json!({"kind":kind,"independentOperators":operators.len(),"network":"zcash-testnet","pool":"ironwood","height":height,"blockHash":seen[0].0,"root":hex::encode(seen[0].1),"tipHeight":low,"observedAt":now,"quorum":if trusted_test {1}else{QUORUM},"sources":sources,"unavailable":unavailable,"trustModel":if trusted_test {"owner-approved-single-pinned-TLS-RPC-for-isolated-valueless-test-only"}else{"pinned-TLS-RPC-quorum-agreement-not-independent-consensus-verification"},"canonicalConsensusProven":false,"unspentStatusVerified":false,"loanLockEnforced":false,"readyForFundedTest":false,"newTransactions":0}));
                Ok(())
            })
            .await
            .map_err(|_| anyhow::anyhow!("public snapshot deadline exceeded"))?
        })
}

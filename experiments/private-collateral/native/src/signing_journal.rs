//! Local, amount-free write-ahead reservations. A missing/corrupt record or an
//! unknown signing outcome requires reconciliation, never another signature.
//! Each independent signer must operate its own durable directory and backups.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrozenDefault {
    pub version: u8,
    pub custody_key: String,
    pub nullifier: String,
    pub digest: String,
    pub lender_outpoint: String,
    pub maturity: u32,
    pub release_cutoff: u32,
}

pub struct SigningJournal {
    directory: PathBuf,
}
impl SigningJournal {
    pub fn open(directory: &Path) -> Result<Self> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(directory)?;
        Ok(Self {
            directory: directory.to_path_buf(),
        })
    }
    fn path(&self, key: &str, suffix: &str) -> Result<PathBuf> {
        ensure!(
            key.len() == 64 && key.bytes().all(|c| c.is_ascii_hexdigit()),
            "invalid journal identifier"
        );
        Ok(self.directory.join(format!("{key}.{suffix}")))
    }
    fn reserve(&self, path: &Path, record: &[u8]) -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(path)?;
        // A crash at any point leaves a blocking reservation. NEVER truncate,
        // automatically remove or retry even a partially written record.
        file.write_all(record)?;
        file.sync_all()?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
    pub fn reserve_default(&self, record: &FrozenDefault) -> Result<()> {
        ensure!(
            record.version == 1 && record.release_cutoff < record.maturity,
            "invalid default policy"
        );
        for value in [
            &record.custody_key,
            &record.nullifier,
            &record.digest,
            &record.lender_outpoint,
        ] {
            self.path(value, "validate")?;
        }
        let bytes = serde_json::to_vec(record)?;
        // Reserve the lender input FIRST: partial failure burns availability,
        // rather than allowing two defaults to depend on the same input.
        self.reserve(&self.path(&record.lender_outpoint, "utxo")?, &bytes)?;
        self.reserve(&self.path(&record.custody_key, "default")?, &bytes)
    }
    pub fn frozen(&self, key: &str) -> Result<FrozenDefault> {
        let record: FrozenDefault = serde_json::from_slice(&fs::read(self.path(key, "default")?)?)?;
        ensure!(
            record.version == 1 && record.custody_key == key,
            "corrupt default binding"
        );
        let input: FrozenDefault =
            serde_json::from_slice(&fs::read(self.path(&record.lender_outpoint, "utxo")?)?)?;
        ensure!(record == input, "lender input binding changed");
        Ok(record)
    }
    /// Settlement is authenticated by the caller's verifier, not this journal.
    /// This method is only a last reservation before nonce/signature generation.
    pub fn reserve_release(&self, record: &FrozenDefault, digest: &str, height: u32) -> Result<()> {
        ensure!(
            self.frozen(&record.custody_key)? == *record,
            "frozen default changed"
        );
        ensure!(height < record.release_cutoff, "release window closed");
        self.path(digest, "validate")?;
        self.reserve(
            &self.path(&record.custody_key, "release")?,
            &serde_json::to_vec(&(record, digest))?,
        )
    }
    /// One outcome per escrow note, whichever party it pays; never replaced.
    pub fn reserve_escrow(&self, nullifier: &str, outcome: &str, digest: &str) -> Result<()> {
        ensure!(
            matches!(outcome, "settled-refund" | "unsettled-claim"),
            "unknown escrow outcome"
        );
        self.path(digest, "validate")?;
        self.reserve(
            &self.path(nullifier, "escrow")?,
            &serde_json::to_vec(&(outcome, digest))?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reservations_survive_reopen_and_burn_ambiguous_outcomes() -> Result<()> {
        use rand::TryRng;
        let mut id = [0u8; 16];
        rand::rngs::SysRng.try_fill_bytes(&mut id)?;
        let dir = std::env::temp_dir().join(format!("sicara-journal-{}", hex::encode(id)));
        let result = (|| -> Result<()> {
            let journal = SigningJournal::open(&dir)?;
            let record = FrozenDefault {
                version: 1,
                custody_key: "11".repeat(32),
                nullifier: "22".repeat(32),
                digest: "33".repeat(32),
                lender_outpoint: "44".repeat(32),
                maturity: 100,
                release_cutoff: 90,
            };
            journal.reserve_default(&record)?;
            let reopened = SigningJournal::open(&dir)?;
            ensure!(
                reopened.frozen(&record.custody_key)? == record,
                "restart lost binding"
            );
            let mut other = record.clone();
            other.custody_key = "55".repeat(32);
            ensure!(
                reopened.reserve_default(&other).is_err(),
                "input reused for another key"
            );
            reopened.reserve_release(&record, &"66".repeat(32), 80)?;
            ensure!(
                SigningJournal::open(&dir)?
                    .reserve_release(&record, &"77".repeat(32), 81)
                    .is_err(),
                "release replaced after restart"
            );
            ensure!(
                reopened
                    .reserve_release(&record, &"66".repeat(32), 90)
                    .is_err(),
                "late release admitted"
            );
            // A crash leaving a truncated record never becomes an empty history.
            fs::write(reopened.path(&record.custody_key, "default")?, b"{")?;
            ensure!(
                reopened.frozen(&record.custody_key).is_err(),
                "corrupt record accepted"
            );
            Ok(())
        })();
        fs::remove_dir_all(&dir)?;
        result
    }
}

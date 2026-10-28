//! Offline testnet receiver validation. This program never opens a wallet or network.
use std::io::{self, Read};
use zcash_address::unified::Typecode;
use zcash_keys::address::Address;
use zcash_protocol::consensus::Network;

fn validate(input: &str) -> Result<String, &'static str> {
    if input.len() > 512 || input.trim() != input {
        return Err("invalid address length or whitespace");
    }
    let encoded: zcash_address::ZcashAddress =
        input.parse().map_err(|_| "invalid checksum or encoding")?;
    let address = Address::try_from_zcash_address(&Network::TestNetwork, encoded)
        .map_err(|_| "wrong network or unsupported receiver")?;
    let Address::Unified(unified) = address else {
        return Err("shielded unified address required");
    };
    if unified.expiry_height().is_some() || unified.expiry_time().is_some() {
        return Err("expiring return addresses are not supported");
    }
    unified.orchard().ok_or("Orchard receiver required")?;
    // The library refuses to drop MUST-understand metadata while pruning receivers.
    let canonical = unified
        .prune_retaining(&[Typecode::ORCHARD])
        .map_err(|_| "unsupported mandatory address metadata")?
        .ok_or("invalid shielded receiver")?;
    Ok(canonical.encode(&Network::TestNetwork))
}

fn run() -> Result<(), &'static str> {
    let mut input = String::new();
    io::stdin()
        .take(1025)
        .read_to_string(&mut input)
        .map_err(|_| "could not read address")?;
    let address = input.strip_suffix('\n').unwrap_or(&input);
    println!("{}", validate(address)?);
    Ok(())
}

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(reason) => {
            eprintln!("Address refused: {reason}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_keys::address::UnifiedAddress;
    const TEST: &str = "utest15re965qrdvxun9399eps75cca8n9cakfh6anznck7evwrdsvusj00r2kpr9eddzvadex8xx4yrlnk5ahemu0jf495yhz5zz7eqglrjmm";

    #[test]
    fn canonical_testnet_receiver_roundtrips() {
        assert_eq!(validate(TEST).unwrap(), TEST);
    }
    #[test]
    fn rejects_checksum_damage_and_unshielded_addresses() {
        for value in [
            format!("{}q", &TEST[..TEST.len() - 1]),
            "tmWK81GXyxz8D259FJPkmfpdLXD32F741co".into(),
            "garbage".into(),
        ] {
            assert!(validate(&value).is_err());
        }
    }
    #[test]
    fn refuses_mainnet_and_normalizes_multi_receiver_addresses() {
        let full = "utest1cc6xtxg57vq4ca6p8vej87zw03wph4jgg0z4z7ws620js6hgxx98xufcxkqeeeslysr8f9rzufqfnhtefjj93qa7pwnhfke9aqpxf95vsffm5jz0c0vvmejp6z5haegle7uxjtkhjfm69sttekp860q04xn8ugyeq5cyfz83g645ug9ys8xeu7cc7lf32lnxpwqve00vudshuumsnpn";
        let canonical = validate(full).unwrap();
        assert_eq!(validate(&canonical).unwrap(), canonical);
        let encoded: zcash_address::ZcashAddress = full.parse().unwrap();
        let Address::Unified(ua) =
            Address::try_from_zcash_address(&Network::TestNetwork, encoded).unwrap()
        else {
            panic!("fixture is unified")
        };
        assert!(validate(&ua.encode(&Network::MainNetwork)).is_err());
    }
    #[test]
    fn refuses_expiring_destinations_instead_of_silently_removing_their_expiry() {
        let encoded: zcash_address::ZcashAddress = TEST.parse().unwrap();
        let Address::Unified(ua) =
            Address::try_from_zcash_address(&Network::TestNetwork, encoded).unwrap()
        else {
            panic!("fixture is unified")
        };
        let expires = UnifiedAddress::from_receivers(
            ua.orchard().copied(),
            None,
            Some(zcash_protocol::consensus::BlockHeight::from_u32(1)),
            None,
        )
        .unwrap();
        assert!(validate(&expires.encode(&Network::TestNetwork)).is_err());
    }
}

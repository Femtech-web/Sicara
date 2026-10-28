//! Standard SHA256 commitment relation for the ZK/FHE equality experiment.
//! Groth16 setup is ephemeral TEST ONLY. No deployed verifier trusts client-generated parameters.
use anyhow::{Result, ensure};
use bellman::{
    Circuit, ConstraintSystem, LinearCombination, SynthesisError,
    gadgets::{
        boolean::{AllocatedBit, Boolean},
        multipack,
        sha256::sha256,
        test::TestConstraintSystem,
    },
};
use bls12_381::{Bls12, Scalar};
use ff::Field;
use rand::rngs::SysRng;
use rand_core::UnwrapErr;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{self, Read};

const DOMAIN: &[u8; 8] = b"SICARA01";
const MAX: u64 = 2_100_000_000_000_000;
#[derive(Clone)]
struct ValueCommitment {
    amount: Option<u64>,
    salt: Option<[u8; 32]>,
    minimum: Option<u64>,
}

fn u64_bits<CS: ConstraintSystem<Scalar>>(
    mut cs: CS,
    value: Option<u64>,
) -> Result<Vec<AllocatedBit>, SynthesisError> {
    (0..64)
        .map(|i| {
            AllocatedBit::alloc(
                cs.namespace(|| format!("bit {i}")),
                value.map(|v| ((v >> i) & 1) == 1),
            )
        })
        .collect()
}
fn number(bits: &[AllocatedBit]) -> LinearCombination<Scalar> {
    let mut coefficient = Scalar::ONE;
    let mut result = LinearCombination::zero();
    for bit in bits {
        result = result + (coefficient, bit.get_variable());
        coefficient = coefficient.double();
    }
    result
}
impl Circuit<Scalar> for ValueCommitment {
    fn synthesize<CS: ConstraintSystem<Scalar>>(self, cs: &mut CS) -> Result<(), SynthesisError> {
        let amount = u64_bits(cs.namespace(|| "private amount"), self.amount)?;
        let gap = u64_bits(
            cs.namespace(|| "amount minus minimum"),
            self.amount
                .zip(self.minimum)
                .map(|(v, min)| v.wrapping_sub(min)),
        )?;
        let upper = u64_bits(
            cs.namespace(|| "maximum minus amount"),
            self.amount.map(|v| MAX.wrapping_sub(v)),
        )?;
        let minimum = cs.alloc_input(
            || "public policy minimum",
            || {
                self.minimum
                    .map(Scalar::from)
                    .ok_or(SynthesisError::AssignmentMissing)
            },
        )?;
        cs.enforce(
            || "amount >= minimum in bounded integers",
            |lc| lc + &number(&amount) - &number(&gap) - minimum,
            |lc| lc + CS::one(),
            |lc| lc,
        );
        cs.enforce(
            || "amount <= ZEC supply",
            |lc| lc + &number(&amount) + &number(&upper),
            |lc| lc + CS::one(),
            |lc| lc + (Scalar::from(MAX), CS::one()),
        );
        let mut preimage: Vec<Boolean> = DOMAIN
            .iter()
            .flat_map(|b| {
                (0..8)
                    .rev()
                    .map(move |i| Boolean::constant((b >> i) & 1 == 1))
            })
            .collect();
        preimage.extend(amount.iter().rev().cloned().map(Boolean::from)); // uint64 big endian
        for byte in 0..32 {
            for bit in (0..8).rev() {
                let value = self.salt.map(|r| ((r[byte] >> bit) & 1) == 1);
                preimage.push(Boolean::from(AllocatedBit::alloc(
                    cs.namespace(|| format!("private salt {byte}:{bit}")),
                    value,
                )?));
            }
        }
        let hash = sha256(cs.namespace(|| "standard SHA256 commitment"), &preimage)?;
        // Pack each digest byte little-endian, matching bellman's public-input helper.
        let packed: Vec<_> = hash
            .chunks(8)
            .flat_map(|byte| byte.iter().rev().cloned())
            .collect();
        multipack::pack_into_inputs(cs.namespace(|| "public commitment"), &packed)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    amount: String,
    minimum: String,
    salt: String,
}
pub fn client_probe() -> Result<()> {
    let mut input = Vec::new();
    io::stdin().take(4097).read_to_end(&mut input)?;
    ensure!(input.len() <= 4096, "oversized client witness");
    let request: Request = serde_json::from_slice(&input)?;
    ensure!(
        request.amount.bytes().all(|b| b.is_ascii_digit())
            && request.minimum.bytes().all(|b| b.is_ascii_digit()),
        "integer witness required"
    );
    let value = request.amount.parse::<u64>()?;
    let minimum = request.minimum.parse::<u64>()?;
    ensure!(
        minimum > 0 && value >= minimum && value <= MAX,
        "invalid test witness"
    );
    let salt: [u8; 32] = hex::decode(&request.salt)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("32 byte salt required"))?;
    let circuit = ValueCommitment {
        amount: Some(value),
        minimum: Some(minimum),
        salt: Some(salt),
    };
    let mut cs = TestConstraintSystem::<Scalar>::new();
    circuit.clone().synthesize(&mut cs)?;
    ensure!(cs.is_satisfied(), "valid relation rejected");
    for (v, min) in [(minimum - 1, minimum), (MAX + 1, minimum)] {
        let bad = ValueCommitment {
            amount: Some(v),
            minimum: Some(min),
            salt: Some(salt),
        };
        let mut invalid = TestConstraintSystem::<Scalar>::new();
        bad.synthesize(&mut invalid)?;
        ensure!(!invalid.is_satisfied(), "invalid range accepted");
    }
    let mut message = Vec::from(*DOMAIN);
    message.extend(value.to_be_bytes());
    message.extend(salt);
    let digest = Sha256::digest(&message);
    let mut public = vec![Scalar::from(minimum)];
    public.extend(multipack::compute_multipacking::<Scalar>(
        &multipack::bytes_to_bits_le(&digest),
    ));
    let params = groth16::generate_random_parameters::<Bls12, _, _>(
        ValueCommitment {
            amount: None,
            minimum: None,
            salt: None,
        },
        &mut UnwrapErr(SysRng),
    )?;
    let verifier = groth16::prepare_verifying_key(&params.vk);
    let proof = groth16::create_random_proof(circuit, &params, &mut UnwrapErr(SysRng))?;
    groth16::verify_proof(&verifier, &proof, &public)?;
    let mut changed = public.clone();
    changed[1] += Scalar::ONE;
    ensure!(
        groth16::verify_proof(&verifier, &proof, &changed).is_err(),
        "changed commitment accepted"
    );
    changed = public.clone();
    changed[0] += Scalar::ONE;
    ensure!(
        groth16::verify_proof(&verifier, &proof, &changed).is_err(),
        "changed minimum accepted"
    );
    let mut bytes = Vec::new();
    proof.write(&mut bytes)?;
    println!(
        "{}",
        serde_json::json!({
         "scope":"client-local-sha256-binding-test", "commitment":format!("0x{}",hex::encode(digest)),
         "proofVerified":true,"proofBytes":bytes.len(),"constraints":cs.num_constraints(),
         "changedCommitmentRejected":true,"changedMinimumRejected":true,"invalidRangesRejected":true,
         "setup":"ephemeral-local-test-not-production-parameters",
         "realZcashNoteBound":false,"canonicalChainRootVerified":false,"proof":hex::encode(bytes)
        })
    );
    Ok(())
}

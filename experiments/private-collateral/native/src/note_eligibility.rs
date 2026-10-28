//! Reuse upstream Orchard gadgets for a private note/value/membership relation.
//! Chip configuration/ownership wiring follows orchard 0.16.0's Action circuit
//! (MIT OR Apache-2.0); the retained MIT notice is in ../LICENSE-Orchard.txt.
//! The fixture root is NOT authenticated chain state and membership is NOT a lock.
//! No borrowing authority, wallet access, network access, or funds are involved.
//!
//! FHE value binding: the committed mask rho and the note value v satisfy
//! z = alpha * v + rho mod 2^128 for a public challenge alpha that the host contract
//! derives from this statement AND the encrypted-input handles (Fiat-Shamir). The
//! contract recomputes z homomorphically from enc(v), enc(rho). Both sides are fixed
//! before alpha, so unequal values pass with probability <= 2^(e-128), where
//! e = 2-adic valuation of their difference (e <= 50 when both are below MAX).
use anyhow::{Result, ensure};
use ff::{Field, FromUniformBytes, PrimeField};
use group::Curve;
use halo2_gadgets::{
    ecc::{
        CircuitVersion, NonIdentityPoint, ScalarFixed, ScalarVar,
        chip::{EccChip, EccConfig},
    },
    poseidon::{
        Hash, Pow5Chip, Pow5Config,
        primitives::{self, ConstantLength, P128Pow5T3},
    },
    sinsemilla::{
        chip::{SinsemillaChip, SinsemillaConfig},
        merkle::{
            MerklePath as CircuitPath,
            chip::{MerkleChip, MerkleConfig},
        },
    },
    utilities::lookup_range_check::{LookupRangeCheck, LookupRangeCheckConfig},
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, SimpleFloorPlanner, Value},
    dev::MockProver,
    pasta::EqAffine,
    plonk::{
        Advice, Circuit, Column, ConstraintSystem, Error, Expression, Instance, ProvingKey,
        Selector, SingleVerifier, create_proof, keygen_pk, keygen_vk, verify_proof,
    },
    poly::{Rotation, commitment::Params},
    transcript::{Blake2bRead, Blake2bWrite, Challenge255},
};
use orchard::{
    Note,
    circuit::{
        commit_ivk::{CommitIvkChip, CommitIvkConfig},
        gadget::{assign_free_advice, commit_ivk, note_commit},
        note_commit::{NoteCommitChip, NoteCommitConfig},
    },
    constants::{OrchardCommitDomains, OrchardFixedBases, OrchardHashDomains},
    keys::{FullViewingKey, Scope, SpendValidatingKey},
    note::{ExtractedNoteCommitment, NoteVersion, RandomSeed, Rho},
    tree::{MerkleHashOrchard, MerklePath},
    value::NoteValue,
};
use pasta_curves::{arithmetic::CurveAffine, pallas};
use rand::{TryRng, rngs::SysRng};
use rand_core::UnwrapErr;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read, Write};

type Fp = pallas::Base;
type Cell = AssignedCell<Fp, Fp>;
type SinConfig = SinsemillaConfig<OrchardHashDomains, OrchardCommitDomains, OrchardFixedBases>;
type TreeConfig = MerkleConfig<OrchardHashDomains, OrchardCommitDomains, OrchardFixedBases>;
const K: u32 = 12;
const MAX: u64 = 2_100_000_000_000_000;
// Public input layout: root, approved ak x/y, minimum, global claim scope,
// alternate claim nullifier, salted value/mask commitment, authorization context,
// FHE challenge, masked FHE response. The first eight form the hashed statement.
const ROOT: usize = 0;
const AK_X: usize = 1;
const AK_Y: usize = 2;
const MINIMUM: usize = 3;
const SCOPE: usize = 4;
const CLAIM: usize = 5;
const COMMITMENT: usize = 6;
const CONTEXT: usize = 7;
const CHALLENGE: usize = 8;
const RESPONSE: usize = 9;
const STATEMENT: usize = 8;
const PUBLIC: usize = 10;
const CIRCUIT_ID: &str = "sicara-note-membership-poseidon-v2-experimental";
const CLAIM_DOMAIN: u64 = 0x53434c41494d; // SCLAIM
const VALUE_DOMAIN: u64 = 0x534356414c; // SCVAL

#[derive(Clone, Debug)]
pub struct Config {
    advice: [Column<Advice>; 10],
    instance: Column<Instance>,
    ecc: EccConfig<OrchardFixedBases>,
    sinsemilla: [SinConfig; 2],
    merkle: [TreeConfig; 2],
    ivk: CommitIvkConfig,
    note: NoteCommitConfig,
    poseidon: Pow5Config<Fp, 3, 2>,
    bit: Selector,
    difference: Selector,
    response: Selector,
}
#[derive(Clone)]
struct NoteEligibility {
    note: Option<Note>,
    viewing: Option<FullViewingKey>,
    path: Value<[MerkleHashOrchard; 32]>,
    position: Value<u32>,
    salt: Value<Fp>,
    minimum: Value<u64>,
    // Malicious-witness injection: this value must be constrained to the note.
    asserted_value: Value<u64>,
    mask: Value<Fp>,
    carry: Value<Fp>,
}

/// Client-private openings. The challenge is public but must come from the host contract.
#[derive(Clone, Copy)]
struct Opening {
    salt: Fp,
    mask: u128,
    challenge: u128,
}

impl NoteEligibility {
    fn empty() -> Self {
        Self {
            note: None,
            viewing: None,
            path: Value::unknown(),
            position: Value::unknown(),
            salt: Value::unknown(),
            minimum: Value::unknown(),
            asserted_value: Value::unknown(),
            mask: Value::unknown(),
            carry: Value::unknown(),
        }
    }
    fn opened(mut self, o: &Opening) -> Result<Self> {
        let value = self
            .note
            .map(|n| n.value().inner())
            .ok_or_else(|| anyhow::anyhow!("fixture note missing"))?;
        self.salt = Value::known(o.salt);
        self.mask = Value::known(Fp::from_u128(o.mask));
        self.carry = Value::known(carry(o.challenge, value, o.mask)?);
        Ok(self)
    }
}

fn wrap() -> Fp {
    Fp::from_u128(1 << 64).square()
}
fn response(challenge: u128, value: u64, mask: u128) -> u128 {
    challenge.wrapping_mul(u128::from(value)).wrapping_add(mask)
}
fn carry(challenge: u128, value: u64, mask: u128) -> Result<Fp> {
    let total = Fp::from_u128(challenge) * Fp::from(value) + Fp::from_u128(mask);
    let inverse = Option::<Fp>::from(wrap().invert())
        .ok_or_else(|| anyhow::anyhow!("2^128 not invertible"))?;
    Ok((total - Fp::from_u128(response(challenge, value, mask))) * inverse)
}

fn range(
    mut layouter: impl Layouter<Fp>,
    c: &Config,
    bits: usize,
    value: Value<Fp>,
    source: &Cell,
) -> Result<(), Error> {
    let last = layouter.assign_region(
        || "bounded integer bits",
        |mut region| {
            region.assign_advice_from_constant(|| "zero", c.advice[1], 0, Fp::ZERO)?;
            let mut accumulator = value.map(|_| Fp::ZERO);
            let mut last = None;
            for row in 0..bits {
                c.bit.enable(&mut region, row)?;
                let index = bits - 1 - row;
                let bit =
                    value.map(|v| Fp::from(u64::from((v.to_repr()[index / 8] >> (index % 8)) & 1)));
                region.assign_advice(|| "bit", c.advice[0], row, || bit)?;
                accumulator = accumulator.zip(bit).map(|(a, b)| a.double() + b);
                last = Some(region.assign_advice(
                    || "accumulator",
                    c.advice[1],
                    row + 1,
                    || accumulator,
                )?);
            }
            last.ok_or(Error::Synthesis)
        },
    )?;
    layouter.assign_region(
        || "bind integer",
        |mut region| region.constrain_equal(last.cell(), source.cell()),
    )
}
fn hash<const L: usize>(
    mut layouter: impl Layouter<Fp>,
    config: &Config,
    input: [Cell; L],
) -> Result<Cell, Error> {
    Hash::<_, _, P128Pow5T3, ConstantLength<L>, 3, 2>::init(
        Pow5Chip::construct(config.poseidon.clone()),
        layouter.namespace(|| "Poseidon init"),
    )?
    .hash(layouter.namespace(|| "Poseidon hash"), input)
}

impl Circuit<Fp> for NoteEligibility {
    type Config = Config;
    type FloorPlanner = SimpleFloorPlanner;
    fn without_witnesses(&self) -> Self {
        Self::empty()
    }
    fn configure(meta: &mut ConstraintSystem<Fp>) -> Config {
        let advice = std::array::from_fn(|_| meta.advice_column());
        for col in advice {
            meta.enable_equality(col);
        }
        let instance = meta.instance_column();
        meta.enable_equality(instance);
        let fixed = std::array::from_fn(|_| meta.fixed_column());
        meta.enable_constant(fixed[0]);
        let table_idx = meta.lookup_table_column();
        let table = (
            table_idx,
            meta.lookup_table_column(),
            meta.lookup_table_column(),
        );
        let range = LookupRangeCheckConfig::configure(meta, advice[9], table_idx);
        let ecc = EccChip::<OrchardFixedBases>::configure(meta, advice, fixed, range);
        let poseidon = Pow5Chip::configure::<P128Pow5T3>(
            meta,
            [advice[6], advice[7], advice[8]],
            advice[5],
            [fixed[2], fixed[3], fixed[4]],
            [fixed[5], fixed[6], fixed[7]],
        );
        // Same standard chip layout used by Orchard; two lanes share the table.
        let sinsemilla = [
            SinsemillaChip::configure(
                meta,
                [advice[0], advice[1], advice[2], advice[3], advice[4]],
                advice[6],
                fixed[0],
                table,
                range,
                false,
            ),
            SinsemillaChip::configure(
                meta,
                [advice[5], advice[6], advice[7], advice[8], advice[9]],
                advice[7],
                fixed[1],
                table,
                range,
                false,
            ),
        ];
        let merkle = [
            MerkleChip::configure(meta, sinsemilla[0].clone()),
            MerkleChip::configure(meta, sinsemilla[1].clone()),
        ];
        let ivk = CommitIvkChip::configure(meta, advice);
        let note = NoteCommitChip::configure(meta, advice, sinsemilla[0].clone());
        let bit = meta.selector();
        meta.create_gate("boolean and integer accumulation", |m| {
            let q = m.query_selector(bit);
            let b = m.query_advice(advice[0], Rotation::cur());
            let a = m.query_advice(advice[1], Rotation::cur());
            let n = m.query_advice(advice[1], Rotation::next());
            vec![
                q.clone() * b.clone() * (b.clone() - Expression::Constant(Fp::ONE)),
                q * (n - a * Fp::from(2) - b),
            ]
        });
        let difference = meta.selector();
        meta.create_gate("bounded difference", |m| {
            let q = m.query_selector(difference);
            let a = m.query_advice(advice[0], Rotation::cur());
            let b = m.query_advice(advice[1], Rotation::cur());
            let c = m.query_advice(advice[2], Rotation::cur());
            vec![q * (a - b - c)]
        });
        // Every term is range-bounded far below the Pallas modulus, so this field
        // equation is the integer equation alpha * v + rho = z + carry * 2^128.
        let response = meta.selector();
        meta.create_gate("masked value response", |m| {
            let q = m.query_selector(response);
            let value = m.query_advice(advice[0], Rotation::cur());
            let challenge = m.query_advice(advice[1], Rotation::cur());
            let mask = m.query_advice(advice[2], Rotation::cur());
            let reply = m.query_advice(advice[3], Rotation::cur());
            let carry = m.query_advice(advice[4], Rotation::cur());
            vec![q * (value * challenge + mask - reply - carry * wrap())]
        });
        Config {
            advice,
            instance,
            ecc,
            sinsemilla,
            merkle,
            ivk,
            note,
            poseidon,
            bit,
            difference,
            response,
        }
    }
    fn synthesize(&self, c: Config, mut layouter: impl Layouter<Fp>) -> Result<(), Error> {
        SinsemillaChip::load(c.sinsemilla[0].clone(), &mut layouter)?;
        let ecc = EccChip::construct(c.ecc.clone(), CircuitVersion::AnchoredBase);
        let sin = SinsemillaChip::construct(c.sinsemilla[0].clone());
        let witness = |f: fn(&Note) -> Fp| {
            self.note
                .as_ref()
                .map(f)
                .map_or(Value::unknown(), Value::known)
        };
        let note_value = self
            .note
            .map(|n| n.value())
            .map_or(Value::unknown(), Value::known);
        let gd = NonIdentityPoint::new(
            ecc.clone(),
            layouter.namespace(|| "g_d"),
            self.note
                .map(|n| n.recipient().g_d().to_affine())
                .map_or(Value::unknown(), Value::known),
        )?;
        let pkd = NonIdentityPoint::new(
            ecc.clone(),
            layouter.namespace(|| "pk_d"),
            self.note
                .map(|n| n.recipient().pk_d().inner().to_affine())
                .map_or(Value::unknown(), Value::known),
        )?;
        let ak = self
            .viewing
            .as_ref()
            .map(|fvk| {
                let key: SpendValidatingKey = fvk.clone().into();
                let point: pallas::Point = (&key).into();
                point.to_affine()
            })
            .map_or(Value::unknown(), Value::known);
        let ak = NonIdentityPoint::new(
            ecc.clone(),
            layouter.namespace(|| "approved shared spend key"),
            ak,
        )?;
        layouter.constrain_instance(ak.inner().x().cell(), c.instance, AK_X)?;
        layouter.constrain_instance(ak.inner().y().cell(), c.instance, AK_Y)?;
        let nk = assign_free_advice(
            layouter.namespace(|| "private nk"),
            c.advice[0],
            self.viewing
                .as_ref()
                .map(|k| k.nk().inner())
                .map_or(Value::unknown(), Value::known),
        )?;
        let rivk = ScalarFixed::new(
            ecc.clone(),
            layouter.namespace(|| "private rivk"),
            self.viewing
                .as_ref()
                .map(|k| k.rivk(Scope::External).inner())
                .map_or(Value::unknown(), Value::known),
        )?;
        let ivk = commit_ivk(
            sin.clone(),
            ecc.clone(),
            CommitIvkChip::construct(c.ivk.clone()),
            layouter.namespace(|| "upstream CommitIvk"),
            ak.extract_p().inner().clone(),
            nk.clone(),
            rivk,
        )?;
        let ivk = ScalarVar::from_base(
            ecc.clone(),
            layouter.namespace(|| "derived ivk"),
            ivk.inner(),
        )?;
        let (derived, _) = gd.mul(layouter.namespace(|| "derive approved recipient"), ivk)?;
        derived.constrain_equal(
            layouter.namespace(|| "recipient belongs to shared key"),
            &pkd,
        )?;
        let rho = assign_free_advice(
            layouter.namespace(|| "rho"),
            c.advice[0],
            witness(|n| n.rho().into_inner()),
        )?;
        let psi = assign_free_advice(
            layouter.namespace(|| "psi"),
            c.advice[0],
            witness(|n| n.rseed().psi(&n.rho())),
        )?;
        let rcm = self
            .note
            .map(|n| {
                n.rseed()
                    .rcm_v3(
                        &n.rho(),
                        &n.recipient().g_d(),
                        &n.recipient().pk_d().inner(),
                        n.value().inner(),
                        &n.rseed().psi(&n.rho()),
                    )
                    .inner()
            })
            .map_or(Value::unknown(), Value::known);
        let rcm = ScalarFixed::new(
            ecc.clone(),
            layouter.namespace(|| "note commitment randomness"),
            rcm,
        )?;
        let value = assign_free_advice(
            layouter.namespace(|| "upstream note value"),
            c.advice[0],
            note_value,
        )?;
        let cm = note_commit(
            layouter.namespace(|| "upstream NoteCommit"),
            sin,
            ecc,
            NoteCommitChip::construct(c.note.clone()),
            gd.inner(),
            pkd.inner(),
            value.clone(),
            rho.clone(),
            psi,
            rcm,
        )?;
        let path = CircuitPath::construct(
            [
                MerkleChip::construct(c.merkle[0].clone()),
                MerkleChip::construct(c.merkle[1].clone()),
            ],
            OrchardHashDomains::MerkleCrh,
            self.position,
            self.path.map(|p| p.map(|n| n.inner())),
        );
        let root = path.calculate_root(
            layouter.namespace(|| "upstream 32 level note membership"),
            cm.extract_p().inner().clone(),
        )?;
        // Unconditional equality: zero-valued dummy notes cannot bypass inclusion.
        layouter.constrain_instance(root.cell(), c.instance, ROOT)?;
        let (amount, salt, mask, scope, context) = layouter.assign_region(
            || "bind value and public policy",
            |mut region| {
                let amount = region.assign_advice(
                    || "numeric value",
                    c.advice[0],
                    0,
                    || self.asserted_value.map(Fp::from),
                )?;
                region.constrain_equal(amount.cell(), value.cell())?;
                let salt = region.assign_advice(|| "private salt", c.advice[1], 0, || self.salt)?;
                let mask = region.assign_advice(|| "private mask", c.advice[4], 0, || self.mask)?;
                let scope = region.assign_advice_from_instance(
                    || "fixed global claim scope",
                    c.instance,
                    SCOPE,
                    c.advice[2],
                    0,
                )?;
                let context = region.assign_advice_from_instance(
                    || "authorization context",
                    c.instance,
                    CONTEXT,
                    c.advice[3],
                    0,
                )?;
                Ok((amount, salt, mask, scope, context))
            },
        )?;
        let gap = self
            .asserted_value
            .zip(self.minimum)
            .map(|(v, m)| v.wrapping_sub(m));
        let lower = layouter.assign_region(
            || "minimum",
            |mut r| {
                c.difference.enable(&mut r, 0)?;
                amount.copy_advice(|| "amount", &mut r, c.advice[0], 0)?;
                let gap = r.assign_advice(|| "gap", c.advice[1], 0, || gap.map(Fp::from))?;
                r.assign_advice_from_instance(|| "minimum", c.instance, MINIMUM, c.advice[2], 0)?;
                Ok(gap)
            },
        )?;
        let upper_value = self.asserted_value.map(|v| MAX.wrapping_sub(v));
        let upper = layouter.assign_region(
            || "supply cap",
            |mut r| {
                c.difference.enable(&mut r, 0)?;
                r.assign_advice_from_constant(|| "maximum", c.advice[0], 0, Fp::from(MAX))?;
                amount.copy_advice(|| "amount", &mut r, c.advice[1], 0)?;
                r.assign_advice(|| "headroom", c.advice[2], 0, || upper_value.map(Fp::from))
            },
        )?;
        range(
            layouter.namespace(|| "amount range"),
            &c,
            64,
            self.asserted_value.map(Fp::from),
            &amount,
        )?;
        range(
            layouter.namespace(|| "lower difference"),
            &c,
            64,
            gap.map(Fp::from),
            &lower,
        )?;
        range(
            layouter.namespace(|| "upper difference"),
            &c,
            64,
            upper_value.map(Fp::from),
            &upper,
        )?;
        let (challenge, reply, carry) = layouter.assign_region(
            || "masked FHE response",
            |mut r| {
                c.response.enable(&mut r, 0)?;
                amount.copy_advice(|| "amount", &mut r, c.advice[0], 0)?;
                let challenge = r.assign_advice_from_instance(
                    || "challenge",
                    c.instance,
                    CHALLENGE,
                    c.advice[1],
                    0,
                )?;
                mask.copy_advice(|| "mask", &mut r, c.advice[2], 0)?;
                let reply = r.assign_advice_from_instance(
                    || "response",
                    c.instance,
                    RESPONSE,
                    c.advice[3],
                    0,
                )?;
                let carry = r.assign_advice(|| "carry", c.advice[4], 0, || self.carry)?;
                Ok((challenge, reply, carry))
            },
        )?;
        for (name, bits, cell) in [
            ("mask range", 128, &mask),
            ("challenge range", 128, &challenge),
            ("response range", 128, &reply),
            ("carry range", 64, &carry),
        ] {
            range(
                layouter.namespace(|| name),
                &c,
                bits,
                cell.value().copied(),
                cell,
            )?;
        }
        // This alternate claim nullifier is stable across proof salt and loan context.
        // It does not publish the spend nullifier. Scope must be fixed by the verifier.
        let (claim_domain, value_domain) = layouter.assign_region(
            || "fixed protocol domains",
            |mut region| {
                Ok((
                    region.assign_advice_from_constant(
                        || "claim domain",
                        c.advice[4],
                        0,
                        Fp::from(CLAIM_DOMAIN),
                    )?,
                    region.assign_advice_from_constant(
                        || "value domain",
                        c.advice[4],
                        1,
                        Fp::from(VALUE_DOMAIN),
                    )?,
                ))
            },
        )?;
        let claim = hash(
            layouter.namespace(|| "private one use claim"),
            &c,
            [claim_domain, nk, rho, scope],
        )?;
        layouter.constrain_instance(claim.cell(), c.instance, CLAIM)?;
        let commitment = hash(
            layouter.namespace(|| "same note value commitment"),
            &c,
            [value_domain, amount, salt, context, mask],
        )?;
        layouter.constrain_instance(commitment.cell(), c.instance, COMMITMENT)
    }
}

fn field() -> Result<Fp> {
    let mut bytes = [0; 64];
    SysRng.try_fill_bytes(&mut bytes)?;
    Ok(Fp::from_uniform_bytes(&bytes))
}
fn random128() -> Result<u128> {
    let mut bytes = [0; 16];
    SysRng.try_fill_bytes(&mut bytes)?;
    Ok(u128::from_le_bytes(bytes))
}
fn digest<const N: usize>(v: [Fp; N]) -> Fp {
    primitives::Hash::<_, P128Pow5T3, ConstantLength<N>, 3, 2>::init().hash(v)
}
fn fixture_note(fvk: &FullViewingKey, value: u64) -> Result<Note> {
    let rho = Option::<Rho>::from(Rho::from_bytes(&field()?.to_repr()))
        .ok_or_else(|| anyhow::anyhow!("invalid fixture rho"))?;
    loop {
        let mut seed = [0; 32];
        SysRng.try_fill_bytes(&mut seed)?;
        if let Some(seed) = Option::<RandomSeed>::from(RandomSeed::from_bytes(seed, &rho))
            && let Some(note) = Option::<Note>::from(Note::from_parts(
                fvk.address_at(0u32, Scope::External),
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
fn fixture_node() -> Result<MerkleHashOrchard> {
    Option::<MerkleHashOrchard>::from(MerkleHashOrchard::from_bytes(&field()?.to_repr()))
        .ok_or_else(|| anyhow::anyhow!("invalid fixture node"))
}
fn root_of(path: &MerklePath, note: &Note) -> Result<Fp> {
    Option::<Fp>::from(Fp::from_repr(
        path.root(ExtractedNoteCommitment::from(note.commitment()))
            .to_bytes(),
    ))
    .ok_or_else(|| anyhow::anyhow!("invalid fixture root"))
}
fn inputs(
    c: &NoteEligibility,
    root: Fp,
    minimum: u64,
    scope: Fp,
    context: Fp,
    o: &Opening,
) -> Result<Vec<Fp>> {
    let note = c
        .note
        .ok_or_else(|| anyhow::anyhow!("fixture note missing"))?;
    let fvk = c
        .viewing
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("fixture viewing key missing"))?;
    let ak: SpendValidatingKey = fvk.clone().into();
    let ak: pallas::Point = (&ak).into();
    let ak = ak.to_affine();
    let coords =
        Option::<pasta_curves::arithmetic::Coordinates<pallas::Affine>>::from(ak.coordinates())
            .ok_or_else(|| anyhow::anyhow!("identity key"))?;
    let value = note.value().inner();
    Ok(vec![
        root,
        *coords.x(),
        *coords.y(),
        Fp::from(minimum),
        scope,
        digest([
            Fp::from(CLAIM_DOMAIN),
            fvk.nk().inner(),
            note.rho().into_inner(),
            scope,
        ]),
        digest([
            Fp::from(VALUE_DOMAIN),
            Fp::from(value),
            o.salt,
            context,
            Fp::from_u128(o.mask),
        ]),
        context,
        Fp::from_u128(o.challenge),
        Fp::from_u128(response(o.challenge, value, o.mask)),
    ])
}

struct Fixture {
    circuit: NoteEligibility,
    path: MerklePath,
    root: Fp,
    scope: Fp,
    context: Fp,
}
fn fixture(amount: u64, minimum: u64) -> Result<Fixture> {
    let args: Vec<_> = std::env::args().collect();
    // Public statement context only; never place note witnesses in process arguments.
    let context = if let Some(index) = args.iter().position(|v| v == "--public-context") {
        let bytes: [u8; 32] = hex::decode(
            args.get(index + 1)
                .ok_or_else(|| anyhow::anyhow!("missing public context"))?,
        )?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid context encoding"))?;
        Option::<Fp>::from(Fp::from_repr(bytes))
            .ok_or_else(|| anyhow::anyhow!("noncanonical public context"))?
    } else {
        field()?
    };
    let (_, group) = super::dkg_pair()?;
    let viewing = super::client_fvk(&group)?;
    let note = fixture_note(&viewing, amount)?;
    let path: [MerkleHashOrchard; 32] = (0..32)
        .map(|_| fixture_node())
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid fixture path length"))?;
    let path = MerklePath::from_parts(17, path);
    Ok(Fixture {
        root: root_of(&path, &note)?,
        circuit: NoteEligibility {
            note: Some(note),
            viewing: Some(viewing),
            path: Value::known(path.auth_path()),
            position: Value::known(path.position()),
            minimum: Value::known(minimum),
            asserted_value: Value::known(amount),
            ..NoteEligibility::empty()
        },
        path,
        scope: Fp::from(0x534943415241u64),
        context,
    })
}

struct Prover {
    params: Params<EqAffine>,
    pk: ProvingKey<EqAffine>,
}
impl Prover {
    fn new() -> Result<Self> {
        let params = Params::<EqAffine>::new(K);
        let vk = keygen_vk(&params, &NoteEligibility::empty())?;
        let pk = keygen_pk(&params, vk, &NoteEligibility::empty())?;
        Ok(Self { params, pk })
    }
    fn prove(&self, circuit: &NoteEligibility, public: &[Fp]) -> Result<Vec<u8>> {
        let mut transcript = Blake2bWrite::<_, _, Challenge255<_>>::init(vec![]);
        create_proof(
            &self.params,
            &self.pk,
            std::slice::from_ref(circuit),
            &[&[public]],
            UnwrapErr(SysRng),
            &mut transcript,
        )?;
        Ok(transcript.finalize())
    }
    fn verifies(&self, proof: &[u8], public: &[Fp]) -> bool {
        let mut transcript = Blake2bRead::<_, _, Challenge255<_>>::init(proof);
        verify_proof(
            &self.params,
            self.pk.get_vk(),
            SingleVerifier::new(&self.params),
            &[&[public]],
            &mut transcript,
        )
        .is_ok()
    }
}
fn rejects(circuit: &NoteEligibility, public: Vec<Fp>) -> Result<bool> {
    Ok(MockProver::run(K, circuit, vec![public])?.verify().is_err())
}

/// Run a real proof of the upstream note relation over an explicitly synthetic root.
pub fn probe() -> Result<()> {
    let Fixture {
        circuit,
        path,
        root,
        scope,
        context,
    } = fixture(10_000, 9_999)?;
    let opening = Opening {
        salt: field()?,
        mask: random128()?,
        challenge: random128()?,
    };
    let circuit = circuit.opened(&opening)?;
    let public = inputs(&circuit, root, 9_999, scope, context, &opening)?;
    MockProver::run(K, &circuit, vec![public.clone()])?
        .verify()
        .map_err(|_| anyhow::anyhow!("valid note relation rejected"))?;
    // A proof cannot substitute an invented value while retaining the same real-format note.
    let mut wrong = circuit.clone();
    wrong.asserted_value = Value::known(10_001);
    wrong.carry = Value::known(carry(opening.challenge, 10_001, opening.mask)?);
    let mut fake = public.clone();
    fake[COMMITMENT] = digest([
        Fp::from(VALUE_DOMAIN),
        Fp::from(10_001),
        opening.salt,
        context,
        Fp::from_u128(opening.mask),
    ]);
    fake[RESPONSE] = Fp::from_u128(response(opening.challenge, 10_001, opening.mask));
    ensure!(rejects(&wrong, fake)?, "different-value note accepted");
    let viewing = circuit
        .viewing
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("missing key"))?;
    let mut wrong = circuit.clone();
    wrong.note = Some(fixture_note(viewing, 10_000)?);
    ensure!(rejects(&wrong, public.clone())?, "different note accepted");
    for (value, minimum) in [(0, 1), (9_998, 9_999), (MAX + 1, 1)] {
        let invalid_note = fixture_note(viewing, value)?;
        let invalid = NoteEligibility {
            note: Some(invalid_note),
            asserted_value: Value::known(value),
            minimum: Value::known(minimum),
            ..circuit.clone()
        }
        .opened(&opening)?;
        let bad_inputs = inputs(
            &invalid,
            root_of(&path, &invalid_note)?,
            minimum,
            scope,
            context,
            &opening,
        )?;
        ensure!(
            rejects(&invalid, bad_inputs)?,
            "invalid note range accepted"
        );
    }
    // The response must use the committed mask, and challenge/response must be canonical:
    // adding 2^128 while lowering the carry satisfies the field gate but not the range.
    let other = Opening {
        mask: random128()?,
        ..opening
    };
    let mut uncommitted = inputs(&circuit, root, 9_999, scope, context, &other)?;
    uncommitted[COMMITMENT] = public[COMMITMENT];
    ensure!(
        rejects(&circuit.clone().opened(&other)?, uncommitted)?,
        "uncommitted mask accepted"
    );
    let mut reply = public.clone();
    reply[RESPONSE] += Fp::ONE;
    ensure!(rejects(&circuit, reply)?, "wrong response accepted");
    let mut lowered = circuit.clone();
    lowered.carry = lowered.carry.map(|c| c - Fp::ONE);
    let mut aliased = public.clone();
    aliased[RESPONSE] += wrap();
    ensure!(
        rejects(&lowered, aliased)?,
        "noncanonical response accepted"
    );
    let mut raised = circuit.clone();
    raised.carry = raised.carry.map(|c| c + Fp::from(10_000));
    let mut aliased = public.clone();
    aliased[CHALLENGE] += wrap();
    ensure!(
        rejects(&raised, aliased)?,
        "noncanonical challenge accepted"
    );
    // A new blinding salt/context changes the commitment but not the one-use tag.
    let refreshed_opening = Opening {
        salt: field()?,
        mask: random128()?,
        challenge: random128()?,
    };
    let mut later_path = path.auth_path();
    later_path[0] = fixture_node()?;
    let later_path = MerklePath::from_parts(path.position(), later_path);
    let note = circuit
        .note
        .ok_or_else(|| anyhow::anyhow!("fixture note missing"))?;
    let refreshed = NoteEligibility {
        path: Value::known(later_path.auth_path()),
        ..circuit.clone()
    }
    .opened(&refreshed_opening)?;
    let refreshed_public = inputs(
        &refreshed,
        root_of(&later_path, &note)?,
        9_999,
        scope,
        field()?,
        &refreshed_opening,
    )?;
    ensure!(
        public[CLAIM] == refreshed_public[CLAIM],
        "claim changed across reblinding"
    );
    MockProver::run(K, &refreshed, vec![refreshed_public.clone()])?
        .verify()
        .map_err(|_| anyhow::anyhow!("reblinding failed"))?;
    let prover = Prover::new()?;
    let proof = prover.prove(&circuit, &public)?;
    ensure!(prover.verifies(&proof, &public), "real note proof rejected");
    for index in 0..public.len() {
        let mut altered = public.clone();
        altered[index] += Fp::ONE;
        ensure!(
            !prover.verifies(&proof, &altered),
            "modified note statement accepted"
        );
    }
    let mut report = serde_json::json!({"scope":"upstream-note-relation-synthetic-root","proofVerified":true,"proofBytes":proof.len(),"circuitK":K,"upstream":"orchard@0.16.0","noteVersion":"V3-fixture-not-a-version-bit-in-the-proof","noteValueCommitmentBound":true,"approvedSpendKeyBound":true,"membershipPathBound":true,"changedStatementRejected":true,"differentNoteRejected":true,"differentValueRejected":true,"invalidNoteRangesRejected":true,"claimStableAcrossReblinding":true,"maskedFheResponseBound":true,"uncommittedMaskRejected":true,"noncanonicalChallengeOrResponseRejected":true,"canonicalChainRootVerified":false,"unspentStatusVerified":false,"loanLockEnforced":false,"durableClaimConsumption":false,"sha256FheBindingJoined":false,"endToEndUnlinkabilityProven":false,"readyForFundedTest":false,"newTransactions":0});
    if std::env::args().any(|v| v == "--export-fixture") {
        let reblinded_proof = prover.prove(&refreshed, &refreshed_public)?;
        ensure!(
            prover.verifies(&reblinded_proof, &refreshed_public),
            "reblinded proof rejected"
        );
        report["fixture"] = serde_json::to_value(NoteProof::new(&proof, &public))?;
        report["reblindedFixture"] =
            serde_json::to_value(NoteProof::new(&reblinded_proof, &refreshed_public))?;
    }
    println!("{report}");
    Ok(())
}

/// A proof envelope contains public data only, never a note, FVK, amount, salt or mask.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NoteProof {
    circuit_id: String,
    proof: String,
    public_inputs: [String; PUBLIC],
}
impl NoteProof {
    fn new(proof: &[u8], public: &[Fp]) -> Self {
        Self {
            circuit_id: CIRCUIT_ID.to_owned(),
            proof: hex::encode(proof),
            public_inputs: std::array::from_fn(|i| hex::encode(public[i].to_repr())),
        }
    }
}
/// Independently reconstruct the fixed experimental circuit's verifier.
/// This verifies the relation only. A caller MUST separately authenticate roots,
/// key policy, current non-spend/lock status, scope/context, compare the challenge
/// with the host contract's derivation and consume the claim.
pub fn verify_request() -> Result<()> {
    let mut input = Vec::new();
    io::stdin().take(32_769).read_to_end(&mut input)?;
    ensure!(input.len() <= 32_768, "oversized proof envelope");
    let request: NoteProof = serde_json::from_slice(&input)?;
    ensure!(request.circuit_id == CIRCUIT_ID, "unsupported circuit");
    ensure!(request.proof.len() == 10_048, "wrong proof length");
    let public = request
        .public_inputs
        .iter()
        .map(|v| {
            ensure!(
                v.len() == 64
                    && v.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "noncanonical public input"
            );
            let bytes: [u8; 32] = hex::decode(v)?
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid field length"))?;
            Option::<Fp>::from(Fp::from_repr(bytes))
                .ok_or_else(|| anyhow::anyhow!("noncanonical field"))
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        [CHALLENGE, RESPONSE]
            .iter()
            .all(|&i| public[i].to_repr()[16..].iter().all(|&b| b == 0)),
        "challenge or response exceeds 128 bits"
    );
    let proof = hex::decode(request.proof)?;
    let params = Params::<EqAffine>::new(K);
    let vk = keygen_vk(&params, &NoteEligibility::empty())?;
    let mut transcript = Blake2bRead::<_, _, Challenge255<_>>::init(proof.as_slice());
    verify_proof(
        &params,
        &vk,
        SingleVerifier::new(&params),
        &[&[&public]],
        &mut transcript,
    )?;
    println!(
        "{}",
        serde_json::json!({"circuitId":CIRCUIT_ID,"relationVerified":true,"canonicalChainRootVerified":false,"loanLockEnforced":false})
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientWitness {
    amount: String,
    mask: String,
    minimum: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostChallenge {
    challenge: String,
}
fn message<T: serde::de::DeserializeOwned>(input: &mut impl BufRead) -> Result<T> {
    let mut line = String::new();
    input.by_ref().take(4_096).read_line(&mut line)?;
    ensure!(line.ends_with('\n'), "truncated client message");
    Ok(serde_json::from_str(&line)?)
}

/// Client-local two-message prover over a SYNTHETIC note of the client's amount:
/// witness in, hashed statement out, host-derived challenge in, proof envelope out.
pub fn value_binding() -> Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let witness: ClientWitness = message(&mut input)?;
    let amount: u64 = witness.amount.parse()?;
    let minimum: u64 = witness.minimum.parse()?;
    let mask: u128 = witness.mask.parse()?;
    ensure!(
        (1..=amount).contains(&minimum) && amount <= MAX,
        "invalid client witness"
    );
    let Fixture {
        circuit,
        root,
        scope,
        context,
        ..
    } = fixture(amount, minimum)?;
    let salt = field()?;
    let committed = inputs(
        &circuit,
        root,
        minimum,
        scope,
        context,
        &Opening {
            salt,
            mask,
            challenge: 0,
        },
    )?;
    let statement: Vec<String> = committed[..STATEMENT]
        .iter()
        .map(|v| hex::encode(v.to_repr()))
        .collect();
    writeln!(output, "{}", serde_json::json!({ "statement": statement }))?;
    output.flush()?;
    let host: HostChallenge = message(&mut input)?;
    let opening = Opening {
        salt,
        mask,
        challenge: host.challenge.parse()?,
    };
    let circuit = circuit.opened(&opening)?;
    let public = inputs(&circuit, root, minimum, scope, context, &opening)?;
    ensure!(
        public[..STATEMENT] == committed[..STATEMENT],
        "statement changed after challenge"
    );
    let prover = Prover::new()?;
    let proof = prover.prove(&circuit, &public)?;
    ensure!(
        prover.verifies(&proof, &public),
        "value binding proof rejected"
    );
    writeln!(
        output,
        "{}",
        serde_json::to_string(&NoteProof::new(&proof, &public))?
    )?;
    output.flush()?;
    Ok(())
}

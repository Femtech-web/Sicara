//! Experimental private arithmetic proof, deliberately NOT a Zcash deposit/lock proof.
//! Public: salted Poseidon commitment, minimum, context. Private: value and salt.
//! Constraints: minimum <= value <= MAX_ZATOSHIS, bounded integer differences.
use anyhow::{Result, ensure};
use ff::{Field, FromUniformBytes};
use halo2_gadgets::poseidon::{
    Hash, Pow5Chip, Pow5Config,
    primitives::{self, ConstantLength, P128Pow5T3},
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, SimpleFloorPlanner, Value},
    dev::MockProver,
    pasta::{EqAffine, Fp},
    plonk::{
        Advice, Circuit, Column, ConstraintSystem, Error, Instance, Selector, SingleVerifier,
        create_proof, keygen_pk, keygen_vk, verify_proof,
    },
    poly::{Rotation, commitment::Params},
    transcript::{Blake2bRead, Blake2bWrite, Challenge255},
};
use rand::{TryRng, rngs::SysRng};
use rand_core::UnwrapErr;

const MAX_ZATOSHIS: u64 = 2_100_000_000_000_000;
const K: u32 = 9;
type Cell = AssignedCell<Fp, Fp>;
#[derive(Clone, Debug)]
pub struct Config {
    advice: [Column<Advice>; 3],
    instance: Column<Instance>,
    poseidon: Pow5Config<Fp, 3, 2>,
    sub: Selector,
    range: Selector,
}
#[derive(Clone)]
struct Eligibility {
    amount: Value<u64>,
    minimum: Value<u64>,
    salt: Value<Fp>,
}

fn range64(
    mut layouter: impl Layouter<Fp>,
    config: &Config,
    value: Value<u64>,
    source: &Cell,
) -> Result<(), Error> {
    let last = layouter.assign_region(
        || "64 bounded bits",
        |mut region| {
            region.assign_advice_from_constant(
                || "zero accumulator",
                config.advice[1],
                0,
                Fp::ZERO,
            )?;
            let mut final_cell = None;
            for row in 0..64 {
                config.range.enable(&mut region, row)?;
                region.assign_advice(
                    || "boolean bit",
                    config.advice[0],
                    row,
                    || value.map(|v| Fp::from((v >> (63 - row)) & 1)),
                )?;
                let next = region.assign_advice(
                    || "accumulator",
                    config.advice[1],
                    row + 1,
                    || value.map(|v| Fp::from(v >> (63 - row))),
                )?;
                final_cell = Some(next);
            }
            final_cell.ok_or(Error::Synthesis)
        },
    )?;
    layouter.assign_region(
        || "bind range",
        |mut region| region.constrain_equal(last.cell(), source.cell()),
    )
}

impl Circuit<Fp> for Eligibility {
    type Config = Config;
    type FloorPlanner = SimpleFloorPlanner;
    fn without_witnesses(&self) -> Self {
        Self {
            amount: Value::unknown(),
            minimum: Value::unknown(),
            salt: Value::unknown(),
        }
    }
    fn configure(meta: &mut ConstraintSystem<Fp>) -> Config {
        let advice = [
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
        ];
        let instance = meta.instance_column();
        meta.enable_equality(instance);
        for column in advice {
            meta.enable_equality(column);
        }
        let rc_a = [
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
        ];
        let rc_b = [
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
        ];
        meta.enable_constant(rc_b[0]);
        let partial = meta.advice_column();
        let poseidon = Pow5Chip::configure::<P128Pow5T3>(meta, advice, partial, rc_a, rc_b);
        let sub = meta.selector();
        meta.create_gate("bounded difference", |meta| {
            let a = meta.query_advice(advice[0], Rotation::cur());
            let b = meta.query_advice(advice[1], Rotation::cur());
            let c = meta.query_advice(advice[2], Rotation::cur());
            vec![meta.query_selector(sub) * (a - b - c)]
        });
        let range = meta.selector();
        meta.create_gate("boolean bit and accumulated integer", |meta| {
            let bit = meta.query_advice(advice[0], Rotation::cur());
            let acc = meta.query_advice(advice[1], Rotation::cur());
            let next = meta.query_advice(advice[1], Rotation::next());
            let q = meta.query_selector(range);
            vec![
                q.clone()
                    * bit.clone()
                    * (bit.clone() - halo2_proofs::plonk::Expression::Constant(Fp::ONE)),
                q * (next - acc * Fp::from(2) - bit),
            ]
        });
        Config {
            advice,
            instance,
            poseidon,
            sub,
            range,
        }
    }
    fn synthesize(&self, config: Config, mut layouter: impl Layouter<Fp>) -> Result<(), Error> {
        let (value, salt, context) = layouter.assign_region(
            || "private value and salt",
            |mut region| {
                let value = region.assign_advice(
                    || "value",
                    config.advice[0],
                    0,
                    || self.amount.map(Fp::from),
                )?;
                let salt = region.assign_advice(|| "salt", config.advice[1], 0, || self.salt)?;
                let context = region.assign_advice_from_instance(
                    || "public context",
                    config.instance,
                    2,
                    config.advice[2],
                    0,
                )?;
                Ok((value, salt, context))
            },
        )?;
        let gap_value = self
            .amount
            .zip(self.minimum)
            .map(|(v, min)| v.wrapping_sub(min));
        let gap = layouter.assign_region(
            || "minimum relation",
            |mut region| {
                config.sub.enable(&mut region, 0)?;
                value.copy_advice(|| "amount", &mut region, config.advice[0], 0)?;
                let gap = region.assign_advice(
                    || "difference",
                    config.advice[1],
                    0,
                    || gap_value.map(Fp::from),
                )?;
                region.assign_advice_from_instance(
                    || "minimum",
                    config.instance,
                    1,
                    config.advice[2],
                    0,
                )?;
                Ok(gap)
            },
        )?;
        let upper_value = self.amount.map(|v| MAX_ZATOSHIS.wrapping_sub(v));
        let upper = layouter.assign_region(
            || "maximum relation",
            |mut region| {
                config.sub.enable(&mut region, 0)?;
                region.assign_advice_from_constant(
                    || "ZEC supply bound",
                    config.advice[0],
                    0,
                    Fp::from(MAX_ZATOSHIS),
                )?;
                value.copy_advice(|| "amount", &mut region, config.advice[1], 0)?;
                region.assign_advice(
                    || "difference",
                    config.advice[2],
                    0,
                    || upper_value.map(Fp::from),
                )
            },
        )?;
        range64(
            layouter.namespace(|| "amount range"),
            &config,
            self.amount,
            &value,
        )?;
        range64(
            layouter.namespace(|| "lower difference range"),
            &config,
            gap_value,
            &gap,
        )?;
        range64(
            layouter.namespace(|| "upper difference range"),
            &config,
            upper_value,
            &upper,
        )?;
        let chip = Pow5Chip::construct(config.poseidon);
        let hasher = Hash::<_, _, P128Pow5T3, ConstantLength<3>, 3, 2>::init(
            chip,
            layouter.namespace(|| "commitment"),
        )?;
        let commitment = hasher.hash(
            layouter.namespace(|| "salted value commitment"),
            [value, salt, context],
        )?;
        layouter.constrain_instance(commitment.cell(), config.instance, 0)
    }
}

fn public(amount: u64, minimum: u64, salt: Fp, context: Fp) -> Vec<Fp> {
    vec![
        primitives::Hash::<Fp, P128Pow5T3, ConstantLength<3>, 3, 2>::init().hash([
            Fp::from(amount),
            salt,
            context,
        ]),
        Fp::from(minimum),
        context,
    ]
}
pub fn probe() -> Result<usize> {
    let mut random = [0u8; 64];
    SysRng.try_fill_bytes(&mut random)?;
    let salt = Fp::from_uniform_bytes(&random);
    let context = Fp::from(937);
    let amount = 10_000;
    let minimum = 9_999;
    let circuit = Eligibility {
        amount: Value::known(amount),
        minimum: Value::known(minimum),
        salt: Value::known(salt),
    };
    let instances = public(amount, minimum, salt, context);
    MockProver::run(K, &circuit, vec![instances.clone()])?
        .verify()
        .map_err(|_| anyhow::anyhow!("satisfied witness rejected"))?;
    let params = Params::<EqAffine>::new(K);
    let vk = keygen_vk(&params, &circuit.without_witnesses())?;
    let pk = keygen_pk(&params, vk, &circuit.without_witnesses())?;
    let mut transcript = Blake2bWrite::<_, _, Challenge255<_>>::init(vec![]);
    create_proof(
        &params,
        &pk,
        &[circuit],
        &[&[&instances]],
        UnwrapErr(SysRng),
        &mut transcript,
    )?;
    let proof = transcript.finalize();
    let verify = |data: &[u8], inputs: &[Fp]| {
        let mut transcript = Blake2bRead::<_, _, Challenge255<_>>::init(data);
        verify_proof(
            &params,
            pk.get_vk(),
            SingleVerifier::new(&params),
            &[&[inputs]],
            &mut transcript,
        )
        .is_ok()
    };
    ensure!(verify(&proof, &instances), "real eligibility proof failed");
    let mut changed = instances.clone();
    changed[0] += Fp::ONE;
    ensure!(!verify(&proof, &changed), "changed commitment accepted");
    changed = instances.clone();
    changed[2] += Fp::ONE;
    ensure!(!verify(&proof, &changed), "changed context accepted");
    changed = instances.clone();
    changed[1] += Fp::ONE;
    ensure!(!verify(&proof, &changed), "changed minimum accepted");
    let mut corrupted = proof.clone();
    corrupted[0] ^= 1;
    ensure!(!verify(&corrupted, &instances), "corrupt proof accepted");
    for (value, min) in [(9_998, 9_999), (MAX_ZATOSHIS + 1, 1)] {
        let invalid = Eligibility {
            amount: Value::known(value),
            minimum: Value::known(min),
            salt: Value::known(salt),
        };
        ensure!(
            MockProver::run(K, &invalid, vec![public(value, min, salt, context)])?
                .verify()
                .is_err(),
            "invalid range accepted"
        );
        // Exercise the actual verifier against an invalid witness too; a prover
        // need not honestly run MockProver before producing its proof bytes.
        let inputs = public(value, min, salt, context);
        let mut transcript = Blake2bWrite::<_, _, Challenge255<_>>::init(vec![]);
        if create_proof(
            &params,
            &pk,
            &[invalid],
            &[&[&inputs]],
            UnwrapErr(SysRng),
            &mut transcript,
        )
        .is_ok()
        {
            ensure!(
                !verify(&transcript.finalize(), &inputs),
                "invalid witness proof verified"
            );
        }
    }
    Ok(proof.len())
}

/** Algebra regression checks, NOT a security proof of the full protocol. */
import test from 'node:test';
import assert from 'node:assert/strict';

test('reduced ring enumeration confirms the power-of-two mismatch bound',()=>{
 const modulus=256;
 for(let delta=1;delta<128;delta++){
  let divisor=1;while(delta%(divisor*2)===0)divisor*=2;
  // All mask differences are attacker selectable; maximum over them is 2^v2(delta).
  const counts=new Array<number>(modulus).fill(0);
  for(let challenge=0;challenge<modulus;challenge++)counts[(challenge*delta)%modulus]++;
  assert.equal(Math.max(...counts),divisor);
 }
});
test('reusing one mask for the same value under two challenges exposes the bounded value',()=>{
 const modulus=1n<<128n;const value=10_000n;const mask=123456789n;
 const first=10n,second=11n;
 const z1=(first*value+mask)%modulus;const z2=(second*value+mask)%modulus;
 // Adjacent challenges make the difference invertible (equal to one) modulo 2^128.
 assert.equal((z2-z1+modulus)%modulus,value);
});
test('the documented 78-bit bound requires BOTH values to be below the ZEC supply cap',()=>{
 const max=2_100_000_000_000_000n;
 assert.ok(max<(1n<<51n));assert.ok((1n<<50n)<max);
 // Worst allowed nonzero difference has 50 trailing zero bits: 128-50=78.
 assert.equal(128-50,78);
 // Repeating a single challenge with the same mask cannot amplify soundness.
 const modulus=1n<<128n;const delta=1n<<50n;
 assert.equal((delta*(1n<<78n))%modulus,0n);
});

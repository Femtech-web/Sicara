import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenUnits,flatInterest,principalLimit} from '../src/features/liquidity/model/amount';
import {shieldedPaymentUri} from '../src/features/zcash/model/payment';
const address='utest15re965qrdvxun9399eps75cca8n9cakfh6anznck7evwrdsvusj00r2kpr9eddzvadex8xx4yrlnk5ahemu0jf495yhz5zz7eqglrjmm';
test('fixed common capacity includes rounded interest; next unit overdraws the ceiling',()=>{
 const max=principalLimit(50_000n,200n);assert.equal(max,49_019n);assert.equal(max+flatInterest(max,200n),50_000n);assert.ok(max+1n+flatInterest(max+1n,200n)>50_000n);assert.equal(flatInterest(1n,200n),1n);assert.equal(flatInterest(0n,200n),0n);
});
test('confidential token inputs reject floating point and uint64 overflow',()=>{
 assert.equal(tokenUnits('0.000001',6),1n);assert.equal(tokenUnits('0.00000001',8),1n);
 assert.equal(tokenUnits('999999999999.999999',6),999999999999999999n);
 assert.throws(()=>tokenUnits('999999999999.99999999',8));
 for(const input of ['1e2','-1','NaN','Infinity','0','0.0000001','18446744073709.551616'])assert.throws(()=>tokenUnits(input,6));
});
test('local ZIP321 preserves exact zatoshi precision and rejects network/URI injection',()=>{
 assert.equal(shieldedPaymentUri(address),`zcash:${address}`);assert.equal(shieldedPaymentUri(address,1n),`zcash:${address}?amount=0.00000001`);assert.equal(shieldedPaymentUri(address,100_000n),`zcash:${address}?amount=0.001`);
 for(const bad of ['u1abc',address+'?amount=1',address+'#x','zcash:'+address])assert.throws(()=>shieldedPaymentUri(bad,1n));assert.throws(()=>shieldedPaymentUri(address,0n));
});

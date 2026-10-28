/** ZIP321 is a payment request, not login or ownership proof. Exact amount is optional. */
export function shieldedPaymentUri(address:string,zatoshis?:bigint){
 // Allocation/native validation must establish the checksum and shielded receiver
 // BEFORE this formatter is called. This rejects URI injection/wrong network.
 if(!/^utest1[023456789acdefghjklmnpqrstuvwxyz]{40,400}$/.test(address))throw new Error('A validated shielded Zcash testnet receiver is required.');
 if(zatoshis!==undefined&&(zatoshis<=0n||zatoshis>2_100_000_000_000_000n))throw new Error('Invalid testnet payment amount.');
 if(zatoshis===undefined)return `zcash:${address}`;
 const whole=zatoshis/100_000_000n,fraction=(zatoshis%100_000_000n).toString().padStart(8,'0').replace(/0+$/,'');
 return `zcash:${address}?amount=${whole}${fraction?'.'+fraction:''}`;
}

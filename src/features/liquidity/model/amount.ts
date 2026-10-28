/** Fixed-width token inputs, never JavaScript floating point. */
export function tokenUnits(input:string,decimals:number):bigint{
 if(![6,8].includes(decimals)||!new RegExp(`^\\d{1,12}(?:\\.\\d{0,${decimals}})?$`).test(input))throw new Error(`Enter an amount with up to ${decimals} decimal places.`);
 const [whole,fraction='']=input.split('.');const amount=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));
 if(amount<=0n||amount>=(1n<<64n))throw new Error('Enter a positive amount within the token limit.');return amount;
}
export const flatInterest=(principal:bigint,bps:bigint)=>(principal*bps+9_999n)/10_000n;
export const principalLimit=(totalDebtCeiling:bigint,bps:bigint)=>totalDebtCeiling*10_000n/(10_000n+bps);

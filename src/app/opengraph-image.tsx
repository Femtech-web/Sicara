import { ImageResponse } from 'next/og';

export const alt = 'Sicara — Keep your ZEC. Borrow privately. Experimental testnet.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Satori's Tailwind `tw` renderer keeps authored styling in utility classes. */
export default function SocialImage() {
  return new ImageResponse(
    <div {...{ tw: 'flex h-full w-full flex-col justify-between bg-[#0b0b10] p-16 text-slate-50' }}>
      <div {...{ tw: 'flex items-center' }}>
        <div {...{ tw: 'flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500' }}>
          <svg width="44" height="44" viewBox="0 0 32 32"><path d="M22 9H12a5 5 0 0 0 0 10h8M10 23h10a5 5 0 0 0 0-10h-8" stroke="white" fill="none" strokeWidth="3.5" strokeLinecap="round" /></svg>
        </div>
        <span {...{ tw: 'ml-4 text-4xl font-bold' }}>Sicara</span>
      </div>
      <div {...{ tw: 'flex flex-col' }}>
        <span {...{ tw: 'text-7xl font-bold tracking-tight' }}>Keep your ZEC.</span>
        <span {...{ tw: 'mt-2 text-7xl font-bold tracking-tight text-indigo-300' }}>Borrow privately.</span>
        <span {...{ tw: 'mt-7 text-2xl text-slate-300' }}>Shielded collateral. Confidential lending.</span>
      </div>
      <div {...{ tw: 'flex justify-between text-xl text-slate-400' }}><span>Zcash × Zama</span><span>Experimental testnet</span></div>
    </div>, size,
  );
}

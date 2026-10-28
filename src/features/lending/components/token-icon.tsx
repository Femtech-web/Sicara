import type { AssetId } from "../model/assets";

export function TokenIcon({ asset, compact = false }: { asset: AssetId; compact?: boolean }) {
  const size = compact ? "size-8 text-[22px]" : "size-[54px] text-[33px] sm:size-[62px] sm:text-[38px]";
  const colors = { zec: "bg-[#e9b953] text-[#171610]", "demo-zama": "bg-[#eee270] text-[#1b1b14]", cusdc: "bg-[#2775ca] text-white", near: "bg-[#e6e9e8] text-[#171a19]" };
  return (
    <span aria-hidden="true" className={`relative flex shrink-0 items-center justify-center rounded-full font-black ${size} ${colors[asset]}`}>
      {asset === "cusdc" ? <span className="font-bold">$</span> : asset === "zec" ? <span className="-translate-y-px">Ƶ</span> : asset === "near" ? <span className="text-2xl">N</span> : <svg viewBox="0 0 32 32" className={compact ? "size-6" : "size-9"} fill="none"><path d="M7 10h18M7 16h18M7 22h18" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /><path d="m10 6 12 20" stroke="currentColor" strokeWidth="3" /></svg>}
      {!compact && <span className={`absolute -bottom-0.5 -right-1 flex size-[23px] items-center justify-center rounded-lg border-2 border-[#121316] text-[10px] font-black ${asset === "zec" ? "bg-[#30332b] text-[#e8c676]" : "bg-[#737fe5] text-white"}`}>{asset === "zec" ? <svg viewBox="0 0 16 16" className="size-3.5 fill-none stroke-current" strokeWidth="1.5"><rect x="3" y="7" width="10" height="7" rx="2" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></svg> : "◆"}</span>}
    </span>
  );
}

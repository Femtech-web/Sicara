import Link from "next/link";

export function Brand() {
  return (
    <Link href="/" aria-label="Sicara home" className="inline-flex items-center gap-2.5 rounded-lg text-[27px] font-black tracking-[-1.3px] text-[#edf0f5] focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-[#8798ff]">
      <span className="flex size-9 items-center justify-center rounded-xl bg-[#5b70f5] shadow-[0_0_28px_#5770ff25]">
        <svg viewBox="0 0 32 32" className="size-7 fill-none stroke-white" aria-hidden="true"><path d="M22 9H12a5 5 0 0 0 0 10h8M10 23h10a5 5 0 0 0 0-10h-8" strokeWidth="3.5" strokeLinecap="round" /></svg>
      </span>
      Sicara
    </Link>
  );
}

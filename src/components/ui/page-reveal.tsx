"use client";

import { useEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";

export function PageReveal({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(root.current, { y: 12, opacity: 0, duration: 0.65, ease: "power3.out", clearProps: "transform,opacity" });
    });
    return () => media.revert();
  }, []);
  return <div ref={root} className="w-full">{children}</div>;
}

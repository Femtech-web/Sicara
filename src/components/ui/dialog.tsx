"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "@/components/ui/icons";
import { useRef, type ReactNode } from "react";
import { iconButton } from "./control-styles";

export function Dialog({ open, onOpenChange, title, description, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm" />
        <DialogPrimitive.Content onOpenAutoFocus={() => { previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={(event) => { if (previouslyFocused.current?.isConnected) { event.preventDefault(); previouslyFocused.current.focus(); } }} className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] border border-white/10 bg-[#111216] p-6 text-[#edf0f5] shadow-2xl focus:outline-none sm:p-7">
          <div className="mb-3 flex items-center justify-between gap-3">
            <DialogPrimitive.Title className="text-xl font-extrabold tracking-tight">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className={iconButton} aria-label="Close dialog"><X size={18} /></DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="mb-6 text-sm leading-relaxed text-[#a5a7b3]">{description}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

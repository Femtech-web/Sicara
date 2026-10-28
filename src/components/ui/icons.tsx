"use client";

import {
  ArrowDownIcon, ArrowRightIcon, ArrowUpRightIcon, ArrowSquareOutIcon, BankIcon,
  CaretDownIcon, CheckIcon, ClockCountdownIcon, CopyIcon,
  FlaskIcon, GlobeIcon, InfoIcon, LockKeyIcon, ShieldCheckIcon,
  SignOutIcon, SpinnerGapIcon, WalletIcon, XIcon, ListIcon,
  type Icon, type IconProps,
} from "@phosphor-icons/react";

/** Rounded, filled UI icons. Never mix outline/filled families across a view. */
function filled(Component: Icon) {
  return function FilledIcon(props: IconProps) {
    return <Component weight="fill" aria-hidden="true" focusable="false" {...props} />;
  };
}

export const ExternalLink = filled(ArrowSquareOutIcon);
export const ArrowDown = filled(ArrowDownIcon);
export const ArrowRight = filled(ArrowRightIcon);
export const ArrowUpRight = filled(ArrowUpRightIcon);
export const Landmark = filled(BankIcon);
export const ChevronDown = filled(CaretDownIcon);
export const Check = filled(CheckIcon);
export const Clock3 = filled(ClockCountdownIcon);
export const Copy = filled(CopyIcon);
export const FlaskConical = filled(FlaskIcon);
export const Globe2 = filled(GlobeIcon);
export const Info = filled(InfoIcon);
export const LockKeyhole = filled(LockKeyIcon);
export const ShieldCheck = filled(ShieldCheckIcon);
export const LogOut = filled(SignOutIcon);
export const LoaderCircle = filled(SpinnerGapIcon);
export const Wallet = filled(WalletIcon);
export const X = filled(XIcon);
export const Menu = filled(ListIcon);

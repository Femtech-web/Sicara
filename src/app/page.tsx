import { AppShell } from "@/components/layout/app-shell";
import { LendingApp } from "@/features/lending/components/lending-app";

export default function HomePage() {
  return <AppShell><LendingApp /></AppShell>;
}

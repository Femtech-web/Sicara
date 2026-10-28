import { AppShell } from "@/components/layout/app-shell";
import { LendingApp } from "@/features/lending/components/lending-app";
import { pageMetadata, publicSite } from "@/config/metadata";
import { site } from "@/config/site";

export const metadata = pageMetadata('/', 'Borrow privately', site.description);

export default function HomePage() {
  const { origin } = publicSite();
  const structuredData = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: site.name, description: site.description, applicationCategory: 'FinanceApplication', operatingSystem: 'Web', ...(origin ? { url: origin } : {}), isAccessibleForFree: true };
  return <AppShell><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} /><LendingApp /></AppShell>;
}

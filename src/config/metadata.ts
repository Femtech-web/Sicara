import type { Metadata } from 'next';
import { site } from './site';

/** A preview may point to production canonicals, but must never be indexed. */
export function publicSite(env: Record<string, string | undefined> = process.env) {
  const configured = env.SICARA_APP_ORIGIN || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  if (!configured) return { origin: undefined, indexable: false };
  const url = new URL(configured);
  if (url.origin !== configured || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Set SICARA_APP_ORIGIN to an exact HTTP(S) origin with no trailing slash.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return {
    origin: url.origin,
    indexable: env.NODE_ENV === 'production' && url.protocol === 'https:' && !local && (!env.VERCEL_ENV || env.VERCEL_ENV === 'production'),
  };
}

export function pageMetadata(path: '/' | '/docs', title: string, description: string): Metadata {
  const { origin } = publicSite();
  const images = [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'Sicara — Keep your ZEC. Borrow privately. Experimental testnet.' }];
  return {
    title: { absolute: `${title} — ${site.name}` }, description,
    ...(origin ? { alternates: { canonical: path } } : {}),
    openGraph: { title: `${title} — ${site.name}`, description, siteName: site.name, type: 'website', locale: 'en_US', ...(origin ? { url: path } : {}), images },
    twitter: { card: 'summary_large_image', title: `${title} — ${site.name}`, description, images },
  };
}

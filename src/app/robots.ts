import type { MetadataRoute } from 'next';
import { publicSite } from '@/config/metadata';

export default function robots(): MetadataRoute.Robots {
  const { origin, indexable } = publicSite();
  return indexable && origin
    ? { rules: { userAgent: '*', allow: '/', disallow: '/api/' }, sitemap: `${origin}/sitemap.xml` }
    : { rules: { userAgent: '*', disallow: '/' } };
}

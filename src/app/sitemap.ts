import type { MetadataRoute } from 'next';
import { publicSite } from '@/config/metadata';

export default function sitemap(): MetadataRoute.Sitemap {
  const { origin, indexable } = publicSite();
  if (!indexable || !origin) return [];
  return [{ url: `${origin}/`, priority: 1 }, { url: `${origin}/docs`, priority: 0.7 }];
}

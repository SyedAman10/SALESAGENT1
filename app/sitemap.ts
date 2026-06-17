import type { MetadataRoute } from 'next';
import fs from 'fs';
import path from 'path';

type Asset = { domain: string };

export default function sitemap(): MetadataRoute.Sitemap {
  const p = path.join(process.cwd(), 'domains.json');
  const assets: Asset[] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : [];
  const now = new Date();
  // Each portfolio domain's own root is its canonical storefront once DNS is live.
  return assets.map(a => ({ url: `https://${a.domain}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 }));
}

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getStorefrontAsset, getAnalysisSummary } from '@/lib/storefront';
import BuyWidget from './widget';

export async function generateMetadata({ params }: { params: Promise<{ domain: string }> }): Promise<Metadata> {
  const { domain } = await params;
  const decoded = decodeURIComponent(domain).toLowerCase();
  const asset = getStorefrontAsset(decoded);
  const title = `${decoded} is for sale`;
  const description = asset
    ? `Buy ${decoded} for $${asset.asking_price.toLocaleString()} — ${asset.description}`
    : `Buy ${decoded} — premium brandable domain.`;
  const url = `https://${decoded}/`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: 'website', siteName: decoded },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function BuyPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  const decoded = decodeURIComponent(domain).toLowerCase();
  const asset = getStorefrontAsset(decoded);
  if (!asset) notFound();

  const analysis = await getAnalysisSummary(decoded).catch(() => null);
  const deadlineActive = asset.deadline && new Date(`${asset.deadline}T23:59:59Z`).getTime() >= Date.now();

  // Structured data: lets search engines understand this is a domain for sale and
  // surface it as a product result — the discovery a marketplace would otherwise provide.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: asset.domain,
    description: analysis?.one_liner ?? asset.description,
    category: 'Domain name',
    offers: {
      '@type': 'Offer',
      price: asset.asking_price,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: `https://${asset.domain}/`,
    },
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center px-4 py-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="w-full max-w-2xl">
        <p className="text-sm uppercase tracking-widest text-zinc-500 mb-3">This domain is for sale</p>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">{asset.domain}</h1>
        <p className="text-zinc-400 text-lg mb-6">{analysis?.one_liner ?? asset.description}</p>

        <div className="flex items-baseline gap-4 mb-8">
          <span className="text-3xl font-semibold">${asset.asking_price.toLocaleString()}</span>
          {deadlineActive && (
            <span className="text-amber-400 text-sm">Accepting best offers through {asset.deadline}</span>
          )}
        </div>

        {analysis && analysis.value_props.length > 0 && (
          <ul className="mb-10 space-y-2 text-zinc-300">
            {analysis.value_props.slice(0, 4).map((v, i) => (
              <li key={i} className="flex gap-2"><span className="text-emerald-400">✓</span>{v}</li>
            ))}
          </ul>
        )}

        <BuyWidget domain={asset.domain} askingPrice={asset.asking_price} />

        <p className="mt-12 text-xs text-zinc-600">
          Secure transfer via escrow · Sold directly by the owner · Negotiated by an AI sales agent
        </p>
      </div>
    </main>
  );
}

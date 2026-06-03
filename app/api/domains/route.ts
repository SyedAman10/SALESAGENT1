import { NextResponse } from 'next/server';
import { getPortfolio, getDomainAnalyses } from '@/lib/pipeline';

export async function GET() {
  const portfolio = getPortfolio();
  const analyses = getDomainAnalyses();
  const analysisMap = new Map(analyses.map(a => [a.domain, a.analysis]));

  return NextResponse.json(
    portfolio.map(asset => ({
      domain: asset.domain,
      category: asset.category,
      asking_price: asset.asking_price,
      description: asset.description,
      analysis: analysisMap.has(asset.domain) ? JSON.parse(analysisMap.get(asset.domain)!) : null,
    }))
  );
}

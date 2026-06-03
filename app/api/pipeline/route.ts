import { NextRequest, NextResponse } from 'next/server';
import { ingestLeads, enrichLeads, matchDomains, writeEmails, decideAndApprove, analyzeDomains, writeFollowUps, testApifyApollo, findHotLeads } from '@/lib/pipeline';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { step, domains } = await req.json() as { step: string; domains?: string[] };

  try {
    switch (step) {
      case 'analyze': {
        const result = await analyzeDomains(domains);
        return NextResponse.json({ ok: true, ...result });
      }
      case 'ingest': {
        const result = await ingestLeads(domains);
        const sourceStr = Object.entries(result.sources).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
        return NextResponse.json({ ok: true, inserted: result.inserted, skipped: result.skipped, sources: sourceStr });
      }
      case 'enrich': {
        const result = await enrichLeads();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'match': {
        const result = await matchDomains(domains);
        return NextResponse.json({ ok: true, ...result });
      }
      case 'write': {
        const result = await writeEmails();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'decide': {
        const result = await decideAndApprove();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'sequence': {
        const result = await writeFollowUps();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'hot': {
        const result = await findHotLeads(domains);
        const hasErrors = Object.keys(result.errors).length > 0;
        return NextResponse.json({
          ok: true,
          inserted: result.inserted,
          skipped: result.skipped,
          threads: result.threads,
          ...result.sources,
          ...(hasErrors ? { errors: result.errors } : {}),
        });
      }
      case 'test': {
        const result = await testApifyApollo(domains);
        const bd = result.breakdown;
        const hasErrors = Object.keys(result.errors).length > 0;
        return NextResponse.json({
          ok: true,
          inserted: result.inserted,
          skipped: result.skipped,
          'sedo': bd['sedo:direct'] ?? 0,
          'afternic': bd['afternic:apify'] ?? 0,
          'expireddomains': bd['expireddomains:apify'] ?? 0,
          'reverse→leads': bd['apollo:reverse'] ?? 0,
          'direct→leads': bd['apollo:direct'] ?? 0,
          ...(hasErrors ? { errors: result.errors } : {}),
        });
      }
      default:
        return NextResponse.json({ ok: false, error: 'Unknown step' }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

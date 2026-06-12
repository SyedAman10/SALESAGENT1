import { NextRequest, NextResponse } from 'next/server';
import { ingestLeads, enrichLeads, matchDomains, writeEmails, decideAndApprove, analyzeDomains, writeFollowUps, testApifyApollo, findHotLeads, testNewSources, findUpgradeBuyers, findCompanyNameMatches, syncReplies, writeClosingFollowUps, generateDailyReport, findTriggerLeads, auditLostDeals, computeDomainMetrics, markIgnoredOutcomes, getBrokerInterestReport, scrapeCompSales, getBuyerBook, writeWarmFirstEmails, extractChatIntent, getVariantPerformance } from '@/lib/pipeline';

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
      case 'replies': {
        const result = await syncReplies();
        return NextResponse.json({ ok: !result.error, ...result });
      }
      case 'closing': {
        const result = await writeClosingFollowUps();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'report': {
        const report = await generateDailyReport();
        return NextResponse.json({ ok: true, report });
      }
      case 'triggers': {
        const result = await findTriggerLeads(domains);
        return NextResponse.json({ ok: true, inserted: result.inserted, skipped: result.skipped, companies: result.companies, ...(Object.keys(result.errors).length ? { errors: result.errors } : {}) });
      }
      case 'audit': {
        const result = await auditLostDeals();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'metrics': {
        const result = await computeDomainMetrics();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'ignored': {
        const result = await markIgnoredOutcomes();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'broker-report': {
        const result = await getBrokerInterestReport();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'comps': {
        const result = await scrapeCompSales();
        return NextResponse.json({ ok: !result.error, ...result });
      }
      case 'buyerbook': {
        const book = await getBuyerBook();
        return NextResponse.json({ ok: true, count: book.length, book });
      }
      case 'warmfirst': {
        const result = await writeWarmFirstEmails(domains);
        return NextResponse.json({ ok: true, ...result });
      }
      case 'intent': {
        const result = await extractChatIntent();
        return NextResponse.json({ ok: true, ...result });
      }
      case 'variants': {
        const result = await getVariantPerformance();
        return NextResponse.json({ ok: true, variants: result });
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
      case 'namematch': {
        const result = await findCompanyNameMatches(domains);
        return NextResponse.json({
          ok: true,
          inserted: result.inserted,
          skipped: result.skipped,
          ...result.breakdown,
          ...(Object.keys(result.errors).length ? { errors: result.errors } : {}),
        });
      }
      case 'upgrade': {
        const result = await findUpgradeBuyers(domains);
        return NextResponse.json({
          ok: true,
          inserted: result.inserted,
          skipped: result.skipped,
          'live variants': result.liveVariants.join(', ') || 'none',
          'checked': result.breakdown['checked'],
          'apollo leads': result.breakdown['apollo'],
          'contact leads': result.breakdown['contact'],
          ...(Object.keys(result.errors).length ? { errors: result.errors } : {}),
        });
      }
      case 'testnew': {
        const result = await testNewSources(domains);
        return NextResponse.json({ ok: true, inserted: result.inserted, skipped: result.skipped, ...result.breakdown, ...(Object.keys(result.errors).length ? { errors: result.errors } : {}) });
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

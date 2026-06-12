import axios from 'axios';
import { config } from './config';

// One-click "go live": attach the domain to the Vercel project and set its DNS
// at GoDaddy so the domain serves its own storefront. Idempotent — safe to re-click.

const VERCEL_APEX_IP = '76.76.21.21';

export interface AttachResult {
  ok: boolean;
  summary: string;
  steps: Record<string, string>;
  manual?: { type: string; host: string; value: string }[];
}

export async function attachDomain(domain: string): Promise<AttachResult> {
  const steps: Record<string, string> = {};

  if (!config.vercelToken) {
    return {
      ok: false,
      summary: 'VERCEL_TOKEN not set — add it to env, or add the domain + DNS manually.',
      steps,
      manual: manualRecords(),
    };
  }

  const vercelHeaders = { Authorization: `Bearer ${config.vercelToken}` };

  // 1. Attach domain to the Vercel project (409/conflict = already attached, fine)
  try {
    await axios.post(
      `https://api.vercel.com/v10/projects/${config.vercelProjectId}/domains`,
      { name: domain },
      { headers: vercelHeaders, timeout: 15000 }
    );
    steps.vercel_attach = 'attached';
  } catch (e) {
    const status = axios.isAxiosError(e) ? e.response?.status : 0;
    const code = axios.isAxiosError(e) ? (e.response?.data as { error?: { code?: string } })?.error?.code : '';
    if (status === 409 || code === 'domain_already_in_use' || code === 'domain_already_exists') {
      steps.vercel_attach = 'already attached';
    } else {
      steps.vercel_attach = `failed: ${code || (e as Error).message}`;
      return { ok: false, summary: `Vercel attach failed (${steps.vercel_attach})`, steps, manual: manualRecords() };
    }
  }

  // 2. Set DNS at GoDaddy (apex A record + www CNAME)
  if (config.godaddyApiKey && config.godaddyApiSecret) {
    const gdHeaders = {
      Authorization: `sso-key ${config.godaddyApiKey}:${config.godaddyApiSecret}`,
      'Content-Type': 'application/json',
    };
    try {
      await axios.put(
        `https://api.godaddy.com/v1/domains/${domain}/records/A/@`,
        [{ data: VERCEL_APEX_IP, ttl: 600 }],
        { headers: gdHeaders, timeout: 15000 }
      );
      steps.godaddy_a_record = `@ → ${VERCEL_APEX_IP}`;
      await axios.put(
        `https://api.godaddy.com/v1/domains/${domain}/records/CNAME/www`,
        [{ data: 'cname.vercel-dns.com', ttl: 600 }],
        { headers: gdHeaders, timeout: 15000 }
      );
      steps.godaddy_cname = 'www → cname.vercel-dns.com';
    } catch (e) {
      const msg = axios.isAxiosError(e) ? `${e.response?.status}: ${JSON.stringify(e.response?.data)}` : (e as Error).message;
      steps.godaddy_dns = `failed (${msg})`;
      return {
        ok: false,
        summary: 'Attached to Vercel, but GoDaddy DNS update failed — set records manually.',
        steps,
        manual: manualRecords(),
      };
    }
  } else {
    steps.godaddy_dns = 'skipped — GODADDY_API_KEY/SECRET not set';
    return {
      ok: false,
      summary: 'Attached to Vercel. Set the DNS records manually (or add GoDaddy API keys for one-click).',
      steps,
      manual: manualRecords(),
    };
  }

  // 3. Check verification status
  try {
    const res = await axios.get(
      `https://api.vercel.com/v9/projects/${config.vercelProjectId}/domains/${domain}`,
      { headers: vercelHeaders, timeout: 15000 }
    );
    const verified = (res.data as { verified?: boolean }).verified;
    steps.verification = verified ? 'verified' : 'pending (DNS propagation can take minutes to an hour)';
  } catch {
    steps.verification = 'status check failed — re-click in a few minutes';
  }

  return { ok: true, summary: `${domain} is going live — DNS set, SSL issues automatically once propagation completes.`, steps };
}

function manualRecords() {
  return [
    { type: 'A', host: '@', value: VERCEL_APEX_IP },
    { type: 'CNAME', host: 'www', value: 'cname.vercel-dns.com' },
  ];
}

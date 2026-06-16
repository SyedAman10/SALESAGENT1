'use client';

import { useState, useEffect, useCallback } from 'react';

interface Stats {
  byStatus: Record<string, number>;
  sentToday: number;
  sentTotal: number;
  replies: number;
  approved: number;
  dailyLimit: number;
  bySources: Record<string, number>;
}

interface Lead {
  id: number;
  name: string;
  email: string;
  company: string | null;
  score: number | null;
  status: string;
  source: string;
  linkedin_url: string | null;
  enrichment: string | null;
  matched_domain: string | null;
  created_at: string;
}

interface PortfolioDomain {
  domain: string;
  category: string;
  asking_price: number;
  description: string;
  analysis: {
    ideal_buyer_types: string[]; industries: string[]; use_cases: string[];
    value_props: string[]; comparable_sales: string[]; email_hooks: string[];
    buyer_profile_summary: string; one_liner: string;
  } | null;
}

interface Email {
  id: number;
  name: string;
  email: string;
  score: number;
  domain: string;
  subject: string;
  body: string;
  variant: string;
  sent_at?: string;
  sequence_day?: number;
  company?: string;
}

type PipelineStep = 'analyze' | 'ingest' | 'enrich' | 'match' | 'write' | 'decide' | 'sequence' | 'test' | 'hot' | 'testnew' | 'upgrade' | 'namematch';

interface BrokerPitch {
  broker: string;
  website: string;
  domain: string;
  subject: string;
  body: string;
}

const STEPS: { key: PipelineStep; label: string; desc: string }[] = [
  { key: 'analyze', label: '0. Analyze', desc: 'Study domain portfolio' },
  { key: 'ingest', label: '1. Ingest', desc: 'Domain-specific + broker leads' },
  { key: 'enrich', label: '2. Enrich', desc: 'Score leads with Claude' },
  { key: 'match', label: '3. Match', desc: 'Match domains to leads' },
  { key: 'write', label: '4. Write', desc: 'Write email variants' },
  { key: 'decide', label: '5. Decide', desc: 'Pick best variant' },
  { key: 'sequence', label: '6. Sequence', desc: 'Write Day 3/5/7 follow-ups' },
];

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-gray-500',
  enriched: 'bg-blue-500',
  contacted: 'bg-purple-500',
  replied: 'bg-green-500',
  skipped: 'bg-yellow-600',
  no_match: 'bg-red-600',
  unsubscribed: 'bg-red-900',
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [emails, setEmails] = useState<Email[]>([]);
  const [activeTab, setActiveTab] = useState<'overview' | 'leads' | 'emails' | 'sent' | 'analysis' | 'broker'>('overview');
  const [running, setRunning] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [sending, setSending] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [sentEmails, setSentEmails] = useState<Email[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioDomain[]>([]);
  const [showDomainPicker, setShowDomainPicker] = useState(false);
  const [pickerSelected, setPickerSelected] = useState<string[]>([]);
  const [pickerCustomInput, setPickerCustomInput] = useState('');
  const [pickerCustomDomains, setPickerCustomDomains] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<PipelineStep | 'all' | null>(null);
  const [gmailAccounts, setGmailAccounts] = useState<{ email: string; is_active: boolean; daily_limit: number; sent_today: number }[]>([]);
  const [warmup, setWarmup] = useState<{
    active: boolean; dayN: number; realLimit: number; warmupCount: number;
    startedAt: string | null; sentToday: number; warmupSentToday: number;
    seeds: string[]; complete: boolean;
  } | null>(null);
  const [warmupSeedInput, setWarmupSeedInput] = useState('');
  const [warmupRunning, setWarmupRunning] = useState(false);
  const [showWarmup, setShowWarmup] = useState(false);
  const [brokerPitches, setBrokerPitches] = useState<BrokerPitch[]>([]);
  const [brokerLoading, setBrokerLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchGmailAccount = useCallback(async () => {
    const res = await fetch('/api/gmail-account');
    const data = await res.json() as { accounts: { email: string; is_active: boolean; daily_limit: number; sent_today: number }[] };
    setGmailAccounts(data.accounts ?? []);
  }, []);

  const fetchWarmup = useCallback(async () => {
    const res = await fetch('/api/warmup');
    setWarmup(await res.json());
  }, []);

  const fetchStats = useCallback(async () => {
    const res = await fetch('/api/stats');
    setStats(await res.json());
  }, []);

  const fetchLeads = useCallback(async () => {
    const res = await fetch('/api/leads');
    setLeads(await res.json());
  }, []);

  const fetchEmails = useCallback(async () => {
    const res = await fetch('/api/emails');
    setEmails(await res.json());
  }, []);

  const fetchSentEmails = useCallback(async () => {
    const res = await fetch('/api/emails?status=sent');
    setSentEmails(await res.json());
  }, []);

  const fetchPortfolio = useCallback(async () => {
    const res = await fetch('/api/domains');
    const data: PortfolioDomain[] = await res.json();
    setPortfolio(data);
  }, []);

  useEffect(() => {
    fetchStats();
    fetchLeads();
    fetchEmails();
    fetchSentEmails();
    fetchPortfolio();
    fetchGmailAccount();
    fetchWarmup();
  }, [fetchStats, fetchLeads, fetchEmails, fetchSentEmails, fetchPortfolio, fetchGmailAccount, fetchWarmup]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get('gmail');
    if (gmail === 'connected' || gmail === 'error') {
      fetchGmailAccount();
      window.history.replaceState({}, '', '/');
    }
  }, [fetchGmailAccount]);

  const DOMAIN_PICKER_STEPS = new Set<PipelineStep | 'all'>(['analyze', 'ingest', 'match', 'all', 'test', 'hot', 'testnew', 'upgrade', 'namematch']);

  function openDomainPicker(action: PipelineStep | 'all') {
    setPickerSelected(portfolio.map(d => d.domain));
    setPickerCustomDomains([]);
    setPickerCustomInput('');
    setPendingAction(action);
    setShowDomainPicker(true);
  }

  async function runStep(step: PipelineStep, domains?: string[]) {
    setRunning(step);
    setLog(prev => [...prev, `▶ Running ${step}${domains ? ` [${domains.join(', ')}]` : ''}...`]);
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step, domains }),
      });
      const data = await res.json();
      if (data.ok) {
        const summary = Object.entries(data)
          .filter(([k]) => k !== 'ok' && k !== 'errors')
          .map(([k, v]) => `${k}: ${v}`)
          .join(' | ');
        setLog(prev => [...prev, `✓ ${step} done — ${summary}`]);
        if (data.errors && Object.keys(data.errors as object).length > 0) {
          for (const [src, msg] of Object.entries(data.errors as Record<string, string>)) {
            setLog(prev => [...prev, `  ⚠ ${src}: ${msg}`]);
          }
        }
      } else {
        setLog(prev => [...prev, `✗ ${step} failed — ${data.error}`]);
      }
    } catch (e) {
      setLog(prev => [...prev, `✗ ${step} error — ${(e as Error).message}`]);
    }
    setRunning(null);
    fetchStats();
    fetchLeads();
    fetchEmails();
    if (step === 'analyze') fetchPortfolio();
  }

  async function runAll(domains?: string[]) {
    for (const step of STEPS) {
      await runStep(step.key, ['analyze', 'match'].includes(step.key) ? domains : undefined);
    }
  }

  const [goingLive, setGoingLive] = useState<string | null>(null);
  async function goLiveDomain(domain: string) {
    setGoingLive(domain);
    setLog(prev => [...prev, `▶ Going live: attaching ${domain} to Vercel + setting DNS...`]);
    try {
      const res = await fetch('/api/domains/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const data = await res.json() as { ok: boolean; summary?: string; error?: string; steps?: Record<string, string>; manual?: { type: string; host: string; value: string }[] };
      setLog(prev => [...prev, `${data.ok ? '✓' : '✗'} ${domain}: ${data.summary ?? data.error}`]);
      for (const [k, v] of Object.entries(data.steps ?? {})) setLog(prev => [...prev, `  · ${k}: ${v}`]);
      if (data.manual) for (const r of data.manual) setLog(prev => [...prev, `  · set manually: ${r.type} ${r.host} → ${r.value}`]);
    } catch (e) {
      setLog(prev => [...prev, `✗ ${domain}: ${(e as Error).message}`]);
    }
    setGoingLive(null);
  }

  async function confirmDomainPicker() {
    const action = pendingAction;
    const domains = [...new Set([...pickerSelected, ...pickerCustomDomains])];
    setShowDomainPicker(false);
    setPendingAction(null);
    setPickerCustomDomains([]);
    setPickerCustomInput('');
    if (!action) return;
    if (action === 'all') {
      await runAll(domains);
    } else {
      await runStep(action, domains);
    }
  }

  async function confirmAndSend() {
    setShowPreview(true);
  }

  async function sendEmails() {
    setShowPreview(false);
    setSending(true);
    setLog(prev => [...prev, '▶ Sending approved emails...']);
    try {
      const res = await fetch('/api/send', { method: 'POST' });
      if (!res.body) throw new Error('No stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as { type: string; message: string };
            if (event.type === 'done') break;
            setLog(prev => [...prev, event.message]);
            if (event.type === 'sent' || event.type === 'failed') {
              fetchStats();
              fetchLeads();
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (e) {
      setLog(prev => [...prev, `✗ Send error — ${(e as Error).message}`]);
    }
    setSending(false);
    fetchStats();
    fetchLeads();
    fetchSentEmails();
    fetchEmails();
  }

  async function markReplied(id: number) {
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'replied' }),
    });
    fetchLeads();
    fetchStats();
  }

  const total = stats ? Object.values(stats.byStatus).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-mono text-sm">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-white font-semibold text-base">Domain Sales Agent</h1>
          <p className="text-gray-500 text-xs mt-0.5">indikaclub.com · $3,900</p>
        </div>
        <div className="flex gap-2">
          {(['overview', 'leads', 'emails', 'sent', 'analysis', 'broker'] as const).map(tab => (
            <button key={tab} onClick={() => { setActiveTab(tab); if (tab === 'sent') fetchSentEmails(); if (tab === 'analysis') fetchPortfolio(); }}
              className={`px-3 py-1.5 rounded text-xs capitalize ${activeTab === tab ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
              {tab === 'overview' ? 'Overview' : tab === 'leads' ? `Leads (${total})` : tab === 'emails' ? `Approved (${emails.length})` : tab === 'sent' ? `Sent (${sentEmails.length})` : tab === 'broker' ? `Brokers (${brokerPitches.length})` : `Domains (${portfolio.length})`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex h-[calc(100vh-57px)]">
        {/* Sidebar */}
        <div className="w-64 border-r border-gray-800 p-4 flex flex-col gap-3 overflow-auto">
          <p className="text-gray-500 text-xs uppercase tracking-wider mb-1">Pipeline</p>

          {STEPS.map(step => (
            <button key={step.key}
              onClick={() => DOMAIN_PICKER_STEPS.has(step.key) ? openDomainPicker(step.key) : runStep(step.key)}
              disabled={!!running || sending}
              className="text-left px-3 py-2.5 rounded border border-gray-700 hover:border-gray-500 hover:bg-gray-800 disabled:opacity-40 transition-colors">
              <div className="flex items-center justify-between">
                <span className="text-white text-xs">{step.label}</span>
                {running === step.key && <span className="text-blue-400 text-xs animate-pulse">running</span>}
              </div>
              <p className="text-gray-500 text-xs mt-0.5">{step.desc}</p>
            </button>
          ))}

          <button onClick={() => openDomainPicker('upgrade')} disabled={!!running || sending}
            className="px-3 py-2.5 rounded border border-emerald-600 hover:border-emerald-400 hover:bg-emerald-900/30 disabled:opacity-40 text-emerald-400 text-xs font-medium transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>🎯</span>
                <div className="text-left">
                  <p className="font-semibold">Upgrade Buyers</p>
                  <p className="text-emerald-700 font-normal text-xs">Companies using .net/.co/.org of your domain</p>
                </div>
              </div>
              {running === 'upgrade' && <span className="text-emerald-300 text-xs animate-pulse">running</span>}
            </div>
          </button>

          <button onClick={() => openDomainPicker('namematch')} disabled={!!running || sending}
            className="px-3 py-2.5 rounded border border-violet-600 hover:border-violet-400 hover:bg-violet-900/30 disabled:opacity-40 text-violet-400 text-xs font-medium transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>🏷️</span>
                <div className="text-left">
                  <p className="font-semibold">Company Name Match</p>
                  <p className="text-violet-700 font-normal text-xs">Companies named after your domain keywords</p>
                </div>
              </div>
              {running === 'namematch' && <span className="text-violet-300 text-xs animate-pulse">running</span>}
            </div>
          </button>

          <button onClick={async () => {
            setBrokerLoading(true);
            setActiveTab('broker');
            try {
              const qs = portfolio.map(d => `domain=${encodeURIComponent(d.domain)}`).join('&');
              const res = await fetch(`/api/broker-pitches?${qs}`);
              const data = await res.json() as { ok: boolean; pitches: BrokerPitch[]; error?: string };
              if (data.ok) setBrokerPitches(data.pitches);
              else setLog(prev => [...prev, `✗ broker pitches failed — ${data.error}`]);
            } catch (e) {
              setLog(prev => [...prev, `✗ broker pitches error — ${(e as Error).message}`]);
            }
            setBrokerLoading(false);
          }} disabled={!!running || sending || brokerLoading}
            className="px-3 py-2.5 rounded border border-orange-700 hover:border-orange-500 hover:bg-orange-900/30 disabled:opacity-40 text-orange-400 text-xs font-medium transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>✉️</span>
                <div className="text-left">
                  <p className="font-semibold">Broker Outreach</p>
                  <p className="text-orange-700 font-normal text-xs">Generate pitches for MediaOptions, Sedo + more</p>
                </div>
              </div>
              {brokerLoading && <span className="text-orange-300 text-xs animate-pulse">generating</span>}
            </div>
          </button>

          <button onClick={() => openDomainPicker('hot')} disabled={!!running || sending}
            className="px-3 py-2.5 rounded border border-red-700 hover:border-red-500 hover:bg-red-900/30 disabled:opacity-40 text-red-400 text-xs font-medium transition-colors">
            <div className="flex items-center gap-2">
              <span>🔥</span>
              <div className="text-left">
                <p>Hot Leads</p>
                <p className="text-red-600 font-normal text-xs">Domain brokers · Investors · Advisors</p>
              </div>
            </div>
            {running === 'hot' && <span className="text-red-300 text-xs animate-pulse ml-1">running</span>}
          </button>

          {/* Workflow comparison */}
          <div className="border-t border-gray-800 pt-3 mt-1">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Lead Workflows</p>

            <div className="rounded-lg border border-cyan-800/50 bg-cyan-950/20 p-1 mb-2">
              <p className="text-cyan-600 text-xs font-medium px-2 pt-1 pb-0.5">Workflow A — Apollo</p>
              <button onClick={() => openDomainPicker('testnew')} disabled={!!running || sending}
                className="w-full text-left px-2 py-2 rounded hover:bg-cyan-900/30 disabled:opacity-40 transition-colors">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-cyan-300 text-xs font-medium">Buyer-Type Title Search</p>
                    <p className="text-cyan-700 text-xs mt-0.5">Claude titles → Apollo people search · 3 pages</p>
                  </div>
                  {running === 'testnew' && <span className="text-cyan-400 text-xs animate-pulse">running</span>}
                </div>
              </button>
            </div>

            <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-1">
              <p className="text-amber-600 text-xs font-medium px-2 pt-1 pb-0.5">Workflow B — Apify</p>
              <button onClick={() => openDomainPicker('test')} disabled={!!running || sending}
                className="w-full text-left px-2 py-2 rounded hover:bg-amber-900/30 disabled:opacity-40 transition-colors">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-amber-300 text-xs font-medium">Google Maps + Contact Scraping</p>
                    <p className="text-amber-700 text-xs mt-0.5">Maps → crawl contact pages → real emails</p>
                  </div>
                  {running === 'test' && <span className="text-amber-400 text-xs animate-pulse">running</span>}
                </div>
              </button>
            </div>
          </div>

          <button onClick={() => openDomainPicker('all')} disabled={!!running || sending}
            className="px-3 py-2.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium transition-colors">
            ▶ Run All Steps
          </button>

          <div className="border-t border-gray-800 pt-3 mt-1">
            {gmailAccounts.length > 0 && (
              <div className="mb-2 space-y-1.5">
                <div className="flex items-center justify-between px-1">
                  <p className="text-green-400 text-xs font-medium">{gmailAccounts.length} mailbox{gmailAccounts.length !== 1 ? 'es' : ''} connected</p>
                  <p className="text-gray-600 text-xs">{gmailAccounts.filter(a => a.is_active).reduce((s, a) => s + Math.max(0, a.daily_limit - a.sent_today), 0)} sends left today</p>
                </div>
                {gmailAccounts.map(acc => (
                  <div key={acc.email} className={`flex items-center justify-between px-3 py-2 rounded bg-gray-900 border ${acc.is_active ? 'border-gray-700' : 'border-gray-800 opacity-50'}`}>
                    <div className="min-w-0">
                      <p className="text-gray-300 text-xs truncate max-w-[150px]">{acc.email}</p>
                      <p className="text-gray-600 text-xs">{acc.sent_today}/{acc.daily_limit} sent today</p>
                    </div>
                    <div className="flex items-center gap-2 ml-2 shrink-0">
                      <button
                        onClick={async () => { await fetch('/api/gmail-account', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: acc.email, is_active: !acc.is_active }) }); fetchGmailAccount(); }}
                        className={`text-xs ${acc.is_active ? 'text-green-500 hover:text-green-300' : 'text-gray-600 hover:text-gray-400'}`}
                      >{acc.is_active ? 'on' : 'off'}</button>
                      <button
                        onClick={async () => { await fetch(`/api/gmail-account?email=${encodeURIComponent(acc.email)}`, { method: 'DELETE' }); fetchGmailAccount(); }}
                        className="text-gray-600 hover:text-red-400 text-xs"
                      >✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <a href="/api/auth/google"
              className="block w-full px-3 py-2.5 rounded border border-gray-600 hover:border-gray-400 text-center text-gray-300 text-xs font-medium transition-colors mb-2">
              {gmailAccounts.length > 0 ? '+ Connect another mailbox' : 'Connect Gmail to send'}
            </a>
            <button onClick={confirmAndSend} disabled={!!running || sending || (stats?.approved ?? 0) === 0 || !gmailAccounts.some(a => a.is_active)}
              className="w-full px-3 py-2.5 rounded bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white text-xs font-medium transition-colors">
              {sending ? 'Sending...' : `Send ${stats?.approved ?? 0} Approved Email${(stats?.approved ?? 0) !== 1 ? 's' : ''}`}
            </button>
            <p className="text-gray-600 text-xs mt-1.5 text-center">{stats?.sentToday ?? 0} / {stats?.dailyLimit ?? 50} sent today</p>
            <p className="text-gray-700 text-xs mt-1 text-center">⏱ auto-runs daily 9am UTC</p>
          </div>

          {/* Warmup */}
          <div className="border-t border-gray-800 pt-3 mt-1">
            <button onClick={() => setShowWarmup(v => !v)} className="flex items-center justify-between w-full text-gray-500 text-xs uppercase tracking-wider mb-2 hover:text-gray-300">
              <span>Email Warmup</span>
              <span className={warmup?.active && !warmup.complete ? 'text-green-500' : warmup?.complete ? 'text-blue-400' : 'text-gray-600'}>
                {warmup?.active && !warmup.complete ? `Day ${warmup.dayN}/28` : warmup?.complete ? 'Complete' : 'Off'}
              </span>
            </button>
            {showWarmup && warmup && (
              <div className="space-y-2 mb-2">
                {warmup.active && !warmup.complete && (
                  <div className="bg-gray-900 border border-gray-700 rounded px-3 py-2 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Day</span>
                      <span className="text-white">{warmup.dayN} / 28</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Real send limit</span>
                      <span className="text-yellow-400">{warmup.realLimit}/day</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Warmup emails today</span>
                      <span className="text-green-400">{warmup.warmupSentToday} / {warmup.warmupCount}</span>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-1 mt-1">
                      <div className="bg-green-500 h-1 rounded-full" style={{ width: `${(warmup.dayN / 28) * 100}%` }} />
                    </div>
                  </div>
                )}
                {warmup.complete && (
                  <p className="text-blue-400 text-xs px-1">Warmup done — sending at full limit.</p>
                )}
                {!warmup.active && (
                  <p className="text-gray-600 text-xs px-1">Not active. Add seeds then start.</p>
                )}

                {/* Seeds */}
                <div className="space-y-1">
                  <p className="text-gray-600 text-xs px-1">Seeds ({warmup.seeds.length})</p>
                  {warmup.seeds.map(seed => (
                    <div key={seed} className="flex items-center justify-between px-2 py-1 bg-gray-900 rounded text-xs">
                      <span className="text-gray-400 truncate">{seed}</span>
                      <button onClick={async () => {
                        await fetch('/api/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove-seed', email: seed }) });
                        fetchWarmup();
                      }} className="text-gray-700 hover:text-red-400 ml-2 flex-shrink-0">✕</button>
                    </div>
                  ))}
                  <div className="flex gap-1">
                    <input
                      type="email"
                      placeholder="add seed email"
                      value={warmupSeedInput}
                      onChange={e => setWarmupSeedInput(e.target.value)}
                      onKeyDown={async e => {
                        if (e.key === 'Enter' && warmupSeedInput.trim()) {
                          await fetch('/api/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add-seed', email: warmupSeedInput.trim() }) });
                          setWarmupSeedInput('');
                          fetchWarmup();
                        }
                      }}
                      className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-700 focus:outline-none focus:border-gray-500"
                    />
                    <button onClick={async () => {
                      if (!warmupSeedInput.trim()) return;
                      await fetch('/api/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add-seed', email: warmupSeedInput.trim() }) });
                      setWarmupSeedInput('');
                      fetchWarmup();
                    }} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-white">+</button>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-1.5">
                  {!warmup.active ? (
                    <button onClick={async () => {
                      if (warmup.seeds.length === 0) { alert('Add at least one seed email first.'); return; }
                      await fetch('/api/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
                      fetchWarmup();
                    }} className="flex-1 py-1.5 rounded bg-green-800 hover:bg-green-700 text-white text-xs">Start warmup</button>
                  ) : (
                    <>
                      {!warmup.complete && (
                        <button disabled={warmupRunning || warmup.warmupSentToday >= warmup.warmupCount} onClick={async () => {
                          setWarmupRunning(true);
                          const res = await fetch('/api/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send' }) });
                          const data = await res.json() as { sent: number; errors: string[] };
                          setLog(prev => [...prev, `Warmup: sent ${data.sent} emails${data.errors.length ? ` (${data.errors.length} errors)` : ''}`]);
                          fetchWarmup();
                          setWarmupRunning(false);
                        }} className="flex-1 py-1.5 rounded bg-blue-800 hover:bg-blue-700 disabled:opacity-40 text-white text-xs">
                          {warmupRunning ? 'Sending...' : `Send warmup (${warmup.warmupCount - warmup.warmupSentToday} left)`}
                        </button>
                      )}
                      <button onClick={async () => {
                        await fetch('/api/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
                        fetchWarmup();
                      }} className="px-2.5 py-1.5 rounded border border-gray-700 hover:border-red-700 text-gray-500 hover:text-red-400 text-xs">Stop</button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {log.length > 0 && (
            <div className="border-t border-gray-800 pt-3 mt-1">
              <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Log</p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {log.slice(-10).map((line, i) => (
                  <p key={i} className={`text-xs break-all ${line.startsWith('✓') ? 'text-green-400' : line.startsWith('✗') ? 'text-red-400' : 'text-gray-400'}`}>{line}</p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Main */}
        <div className="flex-1 overflow-auto p-6">
          {activeTab === 'overview' && stats && (
            <div className="space-y-6">
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: 'Total Leads', value: total },
                  { label: 'Sent Total', value: stats.sentTotal },
                  { label: 'Replies', value: stats.replies },
                  { label: 'Reply Rate', value: stats.sentTotal > 0 ? `${((stats.replies / stats.sentTotal) * 100).toFixed(1)}%` : '—' },
                ].map(card => (
                  <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                    <p className="text-gray-500 text-xs">{card.label}</p>
                    <p className="text-white text-2xl font-semibold mt-1">{card.value}</p>
                  </div>
                ))}
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-4">Lead Pipeline</p>
                <div className="space-y-3">
                  {Object.entries(stats.byStatus).map(([status, count]) => (
                    <div key={status} className="flex items-center gap-3">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[status] ?? 'bg-gray-600'}`} />
                      <span className="text-gray-400 w-28 capitalize">{status.replace('_', ' ')}</span>
                      <div className="flex-1 bg-gray-800 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full ${STATUS_COLORS[status] ?? 'bg-gray-600'}`}
                          style={{ width: total > 0 ? `${(count / total) * 100}%` : '0%' }} />
                      </div>
                      <span className="text-white w-8 text-right">{count}</span>
                    </div>
                  ))}
                </div>
              </div>

              {stats && Object.keys(stats.bySources).length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                  <p className="text-gray-400 text-xs uppercase tracking-wider mb-4">Lead Sources</p>
                  <div className="space-y-2">
                    {Object.entries(stats.bySources).sort((a, b) => b[1] - a[1]).map(([source, count]) => {
                      const label = source.startsWith('apollo:') && source.endsWith('-buyer')
                        ? `🎯 ${source.replace('apollo:', '').replace('-buyer', '')} (targeted)`
                        : source === 'namepros:wanted' ? '🔥 Namepros wanted (high intent)'
                        : source === 'namepros:direct' ? '📋 Namepros direct'
                        : source === 'dnforum:direct' ? '📋 DNForum direct'
                        : source === 'apify:namepros' ? '🤖 Apify Namepros'
                        : source.startsWith('godaddy:') ? '🏪 GoDaddy Auctions'
                        : source.startsWith('afternic:') ? '🏪 Afternic/Sedo'
                        : source.startsWith('apollo:') ? `💼 Apollo (${source.replace('apollo:', '')})`
                        : source;
                      return (
                        <div key={source} className="flex items-center gap-3">
                          <span className="text-gray-300 text-xs flex-1 truncate">{label}</span>
                          <div className="w-24 bg-gray-800 rounded-full h-1.5 flex-shrink-0">
                            <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${Math.min((count / Math.max(...Object.values(stats.bySources))) * 100, 100)}%` }} />
                          </div>
                          <span className="text-white text-xs w-6 text-right flex-shrink-0">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {total === 0 && (
                <div className="bg-gray-900 border border-gray-700 rounded-lg p-5">
                  <p className="text-gray-300 text-xs font-medium mb-3">Quick Start</p>
                  <ol className="text-gray-500 text-xs space-y-2 list-decimal list-inside">
                    <li>Run <span className="text-white">0. Analyze</span> first — unlocks domain-specific lead targeting</li>
                    <li>Click <span className="text-white">Run All Steps</span> — finds brokers + end-user buyers per domain, enriches, matches, writes, decides</li>
                    <li>Review emails in <span className="text-white">Approved</span> tab, then click <span className="text-white">Send</span></li>
                    <li>After sending, run <span className="text-white">6. Sequence</span> daily — writes Day 3/5/7 follow-ups automatically</li>
                    <li>Each daily send picks up any due follow-ups alongside new Day 1 emails</li>
                  </ol>
                </div>
              )}
            </div>
          )}

          {activeTab === 'leads' && (
            <div>
              <div className="flex gap-2 mb-4 flex-wrap">
                {['all', 'new', 'enriched', 'contacted', 'replied', 'skipped', 'unsubscribed'].map(s => (
                  <button key={s} onClick={async () => {
                    const res = await fetch(s === 'all' ? '/api/leads' : `/api/leads?status=${s}`);
                    setLeads(await res.json());
                  }} className="px-2.5 py-1 rounded border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white text-xs capitalize transition-colors">
                    {s}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                {leads.map(lead => {
                  const enrichment = lead.enrichment ? (() => { try { return JSON.parse(lead.enrichment!) as { score?: number; reasoning?: string; fit?: string }; } catch { return null; } })() : null;
                  const scoreColor = (lead.score ?? 0) >= 75 ? 'text-green-400' : (lead.score ?? 0) >= 50 ? 'text-yellow-400' : 'text-gray-500';
                  const sourceLabel = lead.source?.startsWith('apollo:') ? `Apollo · ${lead.source.replace('apollo:', '')}` : lead.source ?? 'unknown';
                  return (
                    <div key={lead.id} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 space-y-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${STATUS_COLORS[lead.status] ?? 'bg-gray-600'}`} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-white text-xs font-medium">{lead.name}</p>
                              {lead.company && <span className="text-gray-400 text-xs">@ {lead.company}</span>}
                              {lead.linkedin_url && (
                                <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer"
                                  className="text-blue-500 hover:text-blue-400 text-xs">LinkedIn ↗</a>
                              )}
                            </div>
                            <p className="text-gray-500 text-xs mt-0.5">{lead.email}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              <span className="text-gray-600 text-xs">{sourceLabel}</span>
                              {lead.matched_domain && <><span className="text-gray-700">·</span><span className="text-blue-400 text-xs">{lead.matched_domain}</span></>}
                              <span className="text-gray-700">·</span>
                              <span className="text-gray-600 text-xs">{new Date(lead.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {lead.score != null && (
                            <span className={`text-xs font-semibold tabular-nums ${scoreColor}`}>{lead.score}</span>
                          )}
                          <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 capitalize">{lead.status.replace('_', ' ')}</span>
                          {lead.status === 'contacted' && (
                            <button onClick={() => markReplied(lead.id)}
                              className="text-green-400 hover:text-green-300 text-xs px-2 py-0.5 border border-green-800 rounded hover:border-green-600 transition-colors">
                              replied
                            </button>
                          )}
                          {lead.status !== 'unsubscribed' && (
                            <button onClick={async () => {
                              await fetch('/api/leads', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: lead.id, status: 'unsubscribed' }) });
                              fetchLeads(); fetchStats();
                            }} className="text-red-600 hover:text-red-400 text-xs px-2 py-0.5 border border-red-900 rounded hover:border-red-700 transition-colors">
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                      {enrichment?.reasoning && (
                        <p className="text-gray-600 text-xs leading-relaxed pl-5 border-l border-gray-800">{enrichment.reasoning}</p>
                      )}
                    </div>
                  );
                })}
                {leads.length === 0 && <p className="text-gray-600 text-xs text-center py-12">No leads yet — run the pipeline.</p>}
              </div>
            </div>
          )}

          {activeTab === 'sent' && (
            <div>
              <p className="text-gray-500 text-xs mb-4">{sentEmails.length} emails sent total</p>
              <div className="space-y-2">
                {sentEmails.map(email => (
                  <div key={email.id} onClick={() => setSelectedEmail(selectedEmail?.id === email.id ? null : email)}
                    className={`bg-gray-900 border rounded-lg px-4 py-3 cursor-pointer transition-colors ${selectedEmail?.id === email.id ? 'border-purple-500' : 'border-gray-800 hover:border-gray-600'}`}>
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-white text-xs font-medium truncate">{email.name} <span className="text-gray-500 font-normal">&lt;{email.email}&gt;</span></p>
                        <p className="text-gray-400 text-xs truncate mt-0.5">{email.subject}</p>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0 text-xs text-gray-500">
                        <span className="text-blue-400">{email.domain}</span>
                        <span>Day {email.sequence_day ?? 1}</span>
                        <span>{email.sent_at ? new Date(email.sent_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                      </div>
                    </div>
                    {selectedEmail?.id === email.id && (
                      <pre className="text-gray-300 text-xs whitespace-pre-wrap leading-relaxed mt-3 pt-3 border-t border-gray-800">{email.body}</pre>
                    )}
                  </div>
                ))}
                {sentEmails.length === 0 && <p className="text-gray-600 text-xs text-center py-12">No emails sent yet.</p>}
              </div>
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="space-y-6">
              {portfolio.length === 0 && (
                <p className="text-gray-600 text-xs text-center py-12">No domains found in portfolio.</p>
              )}
              {portfolio.map(row => (
                <div key={row.domain} className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h2 className="text-white font-semibold text-sm">{row.domain}</h2>
                      {row.analysis ? (
                        <p className="text-blue-400 text-xs mt-1">{row.analysis.one_liner}</p>
                      ) : (
                        <p className="text-gray-600 text-xs mt-1">Not analyzed yet — run 0. Analyze</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <p className="text-white text-sm font-semibold">${row.asking_price.toLocaleString()}</p>
                      <p className="text-gray-500 text-xs">{row.category}</p>
                      <button
                        onClick={() => goLiveDomain(row.domain)}
                        disabled={goingLive !== null}
                        className="mt-2 text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-medium"
                      >
                        {goingLive === row.domain ? 'Going live…' : '🌐 Go Live'}
                      </button>
                    </div>
                  </div>
                  {row.analysis && (
                    <>
                      <p className="text-gray-300 text-xs leading-relaxed border-l-2 border-gray-700 pl-3">{row.analysis.buyer_profile_summary}</p>
                      <div className="grid grid-cols-2 gap-4">
                        {([
                          { label: 'Ideal Buyers', items: row.analysis.ideal_buyer_types },
                          { label: 'Industries', items: row.analysis.industries },
                          { label: 'Use Cases', items: row.analysis.use_cases },
                          { label: 'Value Props', items: row.analysis.value_props },
                          { label: 'Email Hooks', items: row.analysis.email_hooks },
                          { label: 'Comparable Sales', items: row.analysis.comparable_sales },
                        ] as { label: string; items: string[] }[]).map(section => (
                          <div key={section.label}>
                            <p className="text-gray-500 text-xs uppercase tracking-wider mb-1.5">{section.label}</p>
                            <ul className="space-y-1">
                              {section.items.map((item, i) => (
                                <li key={i} className="text-gray-300 text-xs flex gap-1.5"><span className="text-gray-600 flex-shrink-0">·</span>{item}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'broker' && (
            <div className="space-y-4">
              {brokerPitches.length === 0 && !brokerLoading && (
                <div className="text-center py-12">
                  <p className="text-gray-500 text-xs mb-2">No pitches generated yet.</p>
                  <p className="text-gray-600 text-xs">Click <span className="text-orange-400">✉️ Broker Outreach</span> in the sidebar to generate Claude-written pitch emails for domain brokers.</p>
                </div>
              )}
              {brokerLoading && (
                <div className="text-center py-12">
                  <p className="text-orange-400 text-xs animate-pulse">Generating broker pitches with Claude...</p>
                </div>
              )}
              {brokerPitches.length > 0 && (
                <div className="space-y-6">
                  {portfolio.map(d => {
                    const domainPitches = brokerPitches.filter(p => p.domain === d.domain);
                    if (domainPitches.length === 0) return null;
                    return (
                      <div key={d.domain}>
                        <p className="text-gray-500 text-xs uppercase tracking-wider mb-3">{d.domain} — ${d.asking_price.toLocaleString()}</p>
                        <div className="grid grid-cols-2 gap-3">
                          {domainPitches.map(pitch => {
                            const key = `${pitch.domain}-${pitch.broker}`;
                            return (
                              <div key={key} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <p className="text-white text-xs font-semibold">{pitch.broker}</p>
                                    <a href={`https://${pitch.website}`} target="_blank" rel="noopener noreferrer"
                                      className="text-blue-500 hover:text-blue-400 text-xs">{pitch.website} ↗</a>
                                  </div>
                                  <button
                                    onClick={() => {
                                      void navigator.clipboard.writeText(`Subject: ${pitch.subject}\n\n${pitch.body}`);
                                      setCopiedKey(key);
                                      setTimeout(() => setCopiedKey(null), 2000);
                                    }}
                                    className={`flex-shrink-0 px-2.5 py-1 rounded text-xs font-medium transition-colors ${copiedKey === key ? 'bg-green-700 text-green-100' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
                                    {copiedKey === key ? 'Copied!' : 'Copy'}
                                  </button>
                                </div>
                                <div>
                                  <p className="text-gray-500 text-xs">Subject</p>
                                  <p className="text-gray-200 text-xs mt-0.5">{pitch.subject}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500 text-xs mb-1">Body</p>
                                  <pre className="text-gray-300 text-xs whitespace-pre-wrap leading-relaxed border-t border-gray-800 pt-2">{pitch.body}</pre>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'emails' && (
            <div className="flex flex-col md:flex-row gap-4 h-full">
              <div className="md:w-80 w-full space-y-2 overflow-auto flex-shrink-0">
                {emails.map(email => (
                  <button key={email.id} onClick={() => setSelectedEmail(email)}
                    className={`w-full text-left bg-gray-900 border rounded-lg px-3 py-3 transition-colors ${selectedEmail?.id === email.id ? 'border-blue-500' : 'border-gray-800 hover:border-gray-600'}`}>
                    <p className="text-white text-xs font-semibold truncate">{email.name}</p>
                    <p className="text-gray-300 text-xs truncate mt-0.5">{email.subject}</p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="text-blue-400 text-xs font-medium">{email.domain}</span>
                      <span className="px-1.5 py-0.5 rounded bg-gray-700 text-gray-200 text-xs font-medium">{email.variant}</span>
                      <span className="text-gray-400 text-xs">score {email.score}</span>
                    </div>
                  </button>
                ))}
                {emails.length === 0 && <p className="text-gray-500 text-xs text-center py-12">No approved emails yet.</p>}
              </div>

              {selectedEmail ? (
                <div className="flex-1 bg-gray-900 border border-gray-800 rounded-lg p-5 overflow-auto">
                  <div className="mb-4 pb-4 border-b border-gray-800 space-y-1.5">
                    <p className="text-gray-400 text-xs">To: <span className="text-white">{selectedEmail.name} &lt;{selectedEmail.email}&gt;</span></p>
                    <p className="text-gray-400 text-xs">Subject: <span className="text-white">{selectedEmail.subject}</span></p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-gray-400 text-xs">Domain:</span>
                      <span className="text-blue-400 text-xs font-medium">{selectedEmail.domain}</span>
                      <span className="px-1.5 py-0.5 rounded bg-gray-700 text-gray-200 text-xs font-medium">{selectedEmail.variant}</span>
                      <span className="text-gray-400 text-xs">score {selectedEmail.score}</span>
                    </div>
                  </div>
                  <pre className="text-gray-200 text-xs whitespace-pre-wrap leading-relaxed">{selectedEmail.body}</pre>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-gray-500 text-xs">Select an email to preview</div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Domain picker modal */}
      {showDomainPicker && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm">
            <div className="px-5 py-4 border-b border-gray-800">
              <h2 className="text-white text-sm font-medium">Select target domain(s)</h2>
              <p className="text-gray-500 text-xs mt-0.5">Choose which domains to analyze and match leads against.</p>
            </div>
            <div className="p-4 space-y-2">
              {portfolio.map(d => (
                <label key={d.domain} className="flex items-center gap-3 px-3 py-2.5 rounded border border-gray-700 hover:border-gray-500 cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={pickerSelected.includes(d.domain)}
                    onChange={e => setPickerSelected(prev =>
                      e.target.checked ? [...prev, d.domain] : prev.filter(x => x !== d.domain)
                    )}
                    className="accent-blue-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-xs font-medium">{d.domain}</p>
                    <p className="text-gray-500 text-xs">{d.category} · ${d.asking_price.toLocaleString()}</p>
                  </div>
                  {d.analysis && <span className="text-green-500 text-xs flex-shrink-0">analyzed</span>}
                </label>
              ))}

              {/* Custom / test domains */}
              <div className="border-t border-gray-800 pt-3 mt-1">
                <p className="text-gray-600 text-xs mb-2">Test with custom domain</p>
                {pickerCustomDomains.map(d => (
                  <div key={d} className="flex items-center justify-between px-3 py-1.5 mb-1 rounded border border-gray-700 bg-gray-800">
                    <span className="text-yellow-400 text-xs">{d} <span className="text-gray-600">(test)</span></span>
                    <button onClick={() => setPickerCustomDomains(prev => prev.filter(x => x !== d))}
                      className="text-gray-600 hover:text-red-400 text-xs ml-2">✕</button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="e.g. notion.com"
                    value={pickerCustomInput}
                    onChange={e => setPickerCustomInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const v = pickerCustomInput.trim().toLowerCase().replace(/^https?:\/\//, '');
                        if (v && !pickerCustomDomains.includes(v)) setPickerCustomDomains(prev => [...prev, v]);
                        setPickerCustomInput('');
                      }
                    }}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 placeholder-gray-700 focus:outline-none focus:border-gray-500"
                  />
                  <button onClick={() => {
                    const v = pickerCustomInput.trim().toLowerCase().replace(/^https?:\/\//, '');
                    if (v && !pickerCustomDomains.includes(v)) setPickerCustomDomains(prev => [...prev, v]);
                    setPickerCustomInput('');
                  }} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-white">Add</button>
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex gap-3">
              <button onClick={confirmDomainPicker} disabled={pickerSelected.length === 0 && pickerCustomDomains.length === 0}
                className="flex-1 py-2.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium transition-colors">
                Confirm — {pendingAction === 'all' ? 'Run All Steps' : pendingAction === 'test' ? 'Apify: Maps + Contacts' : pendingAction}
              </button>
              <button onClick={() => { setShowDomainPicker(false); setPendingAction(null); }}
                className="px-4 py-2.5 rounded border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white text-xs transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {showPreview && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-white text-sm font-medium">Preview — {emails.length} email{emails.length !== 1 ? 's' : ''} will be sent</h2>
                <p className="text-gray-500 text-xs mt-0.5">Review before sending. Emails go to real inboxes.</p>
              </div>
              <button onClick={() => setShowPreview(false)} className="text-gray-500 hover:text-white text-xs">Cancel</button>
            </div>
            <div className="overflow-auto flex-1 p-4 space-y-3">
              {emails.map((email, i) => (
                <div key={email.id} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-white text-xs font-medium">{i + 1}. {email.name} <span className="text-gray-400 font-normal">&lt;{email.email}&gt;</span></p>
                    <span className="text-blue-400 text-xs">{email.domain}</span>
                  </div>
                  <p className="text-gray-400 text-xs mb-2">Subject: <span className="text-gray-200">{email.subject}</span></p>
                  <pre className="text-gray-300 text-xs whitespace-pre-wrap leading-relaxed border-t border-gray-700 pt-2">{email.body}</pre>
                </div>
              ))}
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex gap-3">
              <button onClick={sendEmails}
                className="flex-1 py-2.5 rounded bg-green-700 hover:bg-green-600 text-white text-xs font-medium transition-colors">
                Confirm — Send {emails.length} Email{emails.length !== 1 ? 's' : ''}
              </button>
              <button onClick={() => setShowPreview(false)}
                className="px-4 py-2.5 rounded border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white text-xs transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

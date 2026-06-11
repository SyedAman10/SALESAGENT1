'use client';

import { useRef, useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };

export default function BuyWidget({ domain, askingPrice }: { domain: string; askingPrice: number }) {
  const [tab, setTab] = useState<'chat' | 'offer'>('chat');

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
      <div className="flex border-b border-zinc-800">
        <button onClick={() => setTab('chat')} className={`flex-1 py-3 text-sm font-medium ${tab === 'chat' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
          Talk to the agent
        </button>
        <button onClick={() => setTab('offer')} className={`flex-1 py-3 text-sm font-medium ${tab === 'offer' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
          Make an offer
        </button>
      </div>
      {tab === 'chat' ? <Chat domain={domain} /> : <OfferForm domain={domain} askingPrice={askingPrice} />}
    </div>
  );
}

function Chat({ domain }: { domain: string }) {
  const sessionId = useRef<string>(typeof crypto !== 'undefined' ? crypto.randomUUID() : `s${Date.now()}`);
  const [messages, setMessages] = useState<Msg[]>([
    { role: 'assistant', content: `Hi — I'm the sales agent for ${domain}. Ask me anything about the name, the price, or how transfer works.` },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', content: text }]);
    setBusy(true);
    try {
      const res = await fetch('/api/storefront/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, sessionId: sessionId.current, message: text }),
      });
      const data = await res.json() as { ok: boolean; reply?: string };
      setMessages(m => [...m, { role: 'assistant', content: data.reply ?? 'Something went wrong — try again.' }]);
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Connection hiccup — try again.' }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="h-72 overflow-y-auto space-y-3 mb-4 pr-1">
        {messages.map((m, i) => (
          <div key={i} className={`max-w-[85%] rounded-xl px-4 py-2 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'ml-auto bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-100'}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="bg-zinc-800 text-zinc-400 max-w-[85%] rounded-xl px-4 py-2 text-sm">…</div>}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder="e.g. Would you take $3,000?"
          className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:border-indigo-500"
        />
        <button onClick={send} disabled={busy} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-medium">
          Send
        </button>
      </div>
    </div>
  );
}

function OfferForm({ domain, askingPrice }: { domain: string; askingPrice: number }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState(String(askingPrice));
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{ status: string; response: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    const amt = parseInt(amount.replace(/[^0-9]/g, ''), 10);
    if (!email.includes('@')) { setError('Enter a valid email.'); return; }
    if (!amt || amt <= 0) { setError('Enter a valid amount.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/storefront/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, name, email, amount: amt, message }),
      });
      const data = await res.json() as { ok: boolean; status?: string; response?: string; error?: string };
      if (data.ok && data.status && data.response) setResult({ status: data.status, response: data.response });
      else setError(data.error ?? 'Something went wrong.');
    } catch {
      setError('Connection hiccup — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="p-6">
        <p className={`text-sm font-semibold mb-2 ${result.status === 'accepted' ? 'text-emerald-400' : 'text-amber-400'}`}>
          {result.status === 'accepted' ? 'Offer accepted' : 'Counter-offer'}
        </p>
        <p className="text-zinc-200 text-sm whitespace-pre-wrap">{result.response}</p>
        {result.status === 'countered' && (
          <button onClick={() => setResult(null)} className="mt-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium">
            Revise offer
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email *" type="email" className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
      </div>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">$</span>
        <input value={amount} onChange={e => setAmount(e.target.value)} placeholder={String(askingPrice)} inputMode="numeric" className="w-full rounded-lg bg-zinc-800 border border-zinc-700 pl-7 pr-3 py-2 text-sm outline-none focus:border-indigo-500" />
      </div>
      <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Anything you want the seller to know (optional)" rows={2} className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm outline-none focus:border-indigo-500 resize-none" />
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 py-2.5 text-sm font-semibold">
        {busy ? 'Submitting…' : `Submit offer for ${domain}`}
      </button>
    </div>
  );
}

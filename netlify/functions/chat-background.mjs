import { getStore } from '@netlify/blobs';

// Те же лимиты и цены, что в api.mjs
const PLANS = [
  { name: 'Free',    pr: { m: 0,  w: 0 },   bud: { m: 0.008, w: 0.008 }, req: 20,  tok: 20000,  inTok: 500,  maxTok: 512 },
  { name: 'Starter', pr: { m: 2,  w: 0.8 }, bud: { m: 0.02,  w: 0.035 }, req: 60,  tok: 100000, inTok: 1500, maxTok: 1024 },
  { name: 'Pro',     pr: { m: 4,  w: 1.7 }, bud: { m: 0.04,  w: 0.07 },  req: 120, tok: 200000, inTok: 3000, maxTok: 2048 },
  { name: 'Ultra',   pr: { m: 10, w: 3.5 }, bud: { m: 0.1,   w: 0.15 },  req: 250, tok: 500000, inTok: 8000, maxTok: 4096 },
];

const MODELS = {
  'doubao-seed-2-0-mini-260215': { name: 'Doubao-Seed-2.0', cost: 0.03, caps: [8, 12, 16, 24] },
  'claude-haiku-5-5':            { name: 'Claude Haiku 5.5', cost: 0.1,  caps: [3, 25, 40, 55] },
  'gpt-6-luna':                  { name: 'GPT-6 Luna',       cost: 0.1,  caps: [3, 25, 40, 55] },
  'gemini-4-argon':              { name: 'Gemini 4 Argon',   cost: 2,    caps: [5, 10, 20, 40] },
};

const db = () => getStore('kiony-code');
const day = () => new Date().toISOString().slice(0, 10);
const effective = u => (u && u.plan > 0 && Date.now() < u.until)
  ? { plan: u.plan, per: u.per }
  : { plan: 0, per: 'm' };
const costOf = (id, tokens) => MODELS[id].cost * tokens / 1e6;

export default async (req) => {
  const { jobId, token, model, messages } = await req.json();
  const email = token ? await db().get(`s:${token}`) : null;
  const put = o => db().setJSON(`job:${jobId}`, { email, ...o });
  if (!email) return put({ status: 'error', error: 'Сессия истекла, войди заново' });

  try {
    const M = MODELS[model];
    if (!M) throw new Error('Такой модели нет');
    const { plan, per } = effective(await db().get(`u:${email}`, { type: 'json' }));
    const p = PLANS[plan], bud = p.bud[per], cap = M.caps[plan];
    if (!cap) throw new Error(`${M.name} недоступна на плане ${p.name}`);

    const msgs = messages.slice(-12).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 20000),
    }));
    const last = msgs[msgs.length - 1].content;
    if (last.length > p.inTok * 3) throw new Error(`Сообщение длиннее ${p.inTok} токенов на плане ${p.name}`);

    const inChars = msgs.reduce((s, m) => s + m.content.length, 0);
    const estT = Math.ceil(inChars / 1.2) + p.maxTok;
    const u = (await db().get(`use:${email}:${day()}`, { type: 'json' })) || { r: 0, t: 0, c: 0, m: {} };
    if (u.r >= p.req) throw new Error(`Лимит запросов на сегодня исчерпан (${p.req})`);
    if (u.t >= p.tok) throw new Error(`Лимит токенов на сегодня исчерпан (${p.tok})`);
    if ((u.m[model] || 0) >= cap) throw new Error(`${M.name}: лимит ${cap} в день исчерпан`);
    if (u.c + costOf(model, estT) > bud) throw new Error(`Дневной бюджет исчерпан ($${bud}). Сбросится завтра`);

    const r = await fetch('https://api.cometapi.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.COMETAPI_KEY}` },
      body: JSON.stringify({ model, messages: msgs, max_tokens: p.maxTok }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `Ошибка модели ${r.status}`);

    const reply = j.choices?.[0]?.message?.content || '';
    const tokens = j.usage?.total_tokens || Math.ceil((inChars + reply.length) / 3);
    u.r++;
    u.m[model] = (u.m[model] || 0) + 1;
    u.t += tokens;
    u.c += costOf(model, tokens);
    await db().setJSON(`use:${email}:${day()}`, u);
    await put({ status: 'done', reply });
  } catch (e) {
    await put({ status: 'error', error: e.message });
  }
};

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

// Лимиты такие же, как в Kiony AI. Счётчики у Kiony Code свои.
// pr — цена $ (m месяц, w неделя). bud — расход на модели $ в день. caps — запросов в день по моделям [Free, Starter, Pro, Ultra].
const PLANS = [
  { name: 'Free',    pr: { m: 0,  w: 0 },   bud: { m: 0.008, w: 0.008 }, req: 20,  tok: 20000,  inTok: 500,  maxTok: 512 },
  { name: 'Starter', pr: { m: 2,  w: 0.8 }, bud: { m: 0.02,  w: 0.035 }, req: 60,  tok: 100000, inTok: 1500, maxTok: 1024 },
  { name: 'Pro',     pr: { m: 4,  w: 1.7 }, bud: { m: 0.04,  w: 0.07 },  req: 120, tok: 200000, inTok: 3000, maxTok: 2048 },
  { name: 'Ultra',   pr: { m: 10, w: 3.5 }, bud: { m: 0.1,   w: 0.15 },  req: 250, tok: 500000, inTok: 8000, maxTok: 4096 },
];

// cost — $ за 1 млн токенов (полная цена CometAPI, с запасом)
const MODELS = {
  'doubao-seed-2-0-mini-260215': { name: 'Doubao-Seed-2.0', cost: 0.03, caps: [8, 12, 16, 24] },
  'claude-haiku-5-5':            { name: 'Claude Haiku 5.5', cost: 0.1,  caps: [3, 25, 40, 55] },
  'gpt-6-luna':                  { name: 'GPT-6 Luna',       cost: 0.1,  caps: [3, 25, 40, 55] },
  'gemini-4-argon':              { name: 'Gemini 4 Argon',   cost: 2,    caps: [5, 10, 20, 40] },
};

export const config = { path: '/api/*' };

const db = () => getStore('kiony-code');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const day = () => new Date().toISOString().slice(0, 10);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const loadUser = email => db().get(`u:${email}`, { type: 'json' });
const saveUser = (email, u) => db().setJSON(`u:${email}`, u);
const usageOf = async email => (await db().get(`use:${email}:${day()}`, { type: 'json' })) || { r: 0, t: 0, c: 0, m: {} };
const saveUsage = (email, u) => db().setJSON(`use:${email}:${day()}`, u);
const costOf = (id, tokens) => MODELS[id].cost * tokens / 1e6;

async function userOf(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  return token ? db().get(`s:${token}`) : null;
}

// Действующий план. Если срок вышел — Free.
function effective(u) {
  return u && u.plan > 0 && Date.now() < u.until
    ? { plan: u.plan, per: u.per, until: u.until }
    : { plan: 0, per: 'm', until: 0 };
}

async function auth(req) {
  const { action, email: raw, password } = await req.json();
  const email = String(raw || '').trim().toLowerCase();
  const pw = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Неверная почта' });
  if (pw.length < 6) return json(400, { error: 'Пароль от 6 символов' });

  const user = await loadUser(email);
  if (action === 'register') {
    if (user) return json(409, { error: 'Такой аккаунт уже есть. Нажми «Войти»' });
    const salt = crypto.randomBytes(16).toString('hex');
    await saveUser(email, { salt, hash: hashPw(pw, salt), plan: 0, per: 'm', until: 0 });
  } else {
    if (!user) return json(404, { error: 'Аккаунта нет. Сначала зарегистрируйся' });
    if (hashPw(pw, user.salt) !== user.hash) return json(401, { error: 'Неверный пароль' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  await db().set(`s:${token}`, email);
  return json(200, { token, email });
}

async function me(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const { plan, per, until } = effective(await loadUser(email));
  const p = PLANS[plan];
  return json(200, {
    email,
    planName: p.name,
    per,
    until,
    limits: { req: p.req, tok: p.tok, bud: p.bud[per], inTok: p.inTok, maxTok: p.maxTok },
    usage: await usageOf(email),
    models: Object.entries(MODELS).map(([id, m]) => ({ id, name: m.name, cap: m.caps[plan] || 0 })),
    plans: PLANS.map(x => ({ name: x.name, m: x.pr.m, w: x.pr.w, req: x.req, tok: x.tok, bud: x.bud.m })),
  });
}

async function chat(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });

  const { model, messages } = await req.json();
  const M = MODELS[model];
  if (!M) return json(400, { error: 'Такой модели нет' });
  if (!Array.isArray(messages) || !messages.length) return json(400, { error: 'Пустой запрос' });

  const { plan, per } = effective(await loadUser(email));
  const p = PLANS[plan], bud = p.bud[per], cap = M.caps[plan];
  if (!cap) return json(403, { error: `${M.name} недоступна на плане ${p.name}` });

  const msgs = messages.slice(-12).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 20000),
  }));
  const last = msgs[msgs.length - 1].content;
  if (last.length > p.inTok * 3) return json(400, { error: `Сообщение длиннее ${p.inTok} токенов на плане ${p.name}` });

  // Оценка с запасом: лучше переоценить, чем превысить бюджет
  const inChars = msgs.reduce((s, m) => s + m.content.length, 0);
  const estT = Math.ceil(inChars / 1.2) + p.maxTok;

  const u = await usageOf(email);
  if (u.r >= p.req) return json(429, { error: `Лимит запросов на сегодня исчерпан (${p.req})` });
  if (u.t >= p.tok) return json(429, { error: `Лимит токенов на сегодня исчерпан (${p.tok})` });
  if ((u.m[model] || 0) >= cap) return json(429, { error: `${M.name}: лимит ${cap} в день исчерпан` });
  if (u.c + costOf(model, estT) > bud) return json(429, { error: `Дневной бюджет исчерпан ($${bud}). Сбросится завтра` });

  let r;
  try {
    r = await fetch('https://api.cometapi.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.COMETAPI_KEY}` },
      body: JSON.stringify({ model, messages: msgs, max_tokens: p.maxTok }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    return json(502, { error: 'Модель не ответила, попробуй ещё раз' });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json(502, { error: j.error?.message || `Ошибка модели ${r.status}` });

  const reply = j.choices?.[0]?.message?.content || '';
  const tokens = j.usage?.total_tokens || Math.ceil((inChars + reply.length) / 3);
  u.r++;
  u.m[model] = (u.m[model] || 0) + 1;
  u.t += tokens;
  u.c += costOf(model, tokens);
  await saveUsage(email, u);
  return json(200, { reply });
}

// CODE_LIST в настройках Netlify, например: {"STARTER-7F3K":"1:m","PRO-9QX2":"2:w"}
// 1/2/3 — Starter/Pro/Ultra, m — месяц, w — неделя
async function code(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });

  const { code: raw } = await req.json();
  const c = String(raw || '').trim().toUpperCase();
  let list;
  try { list = JSON.parse(process.env.CODE_LIST || '{}'); } catch { return json(500, { error: 'Не настроен CODE_LIST' }); }
  if (!Object.prototype.hasOwnProperty.call(list, c)) return json(404, { error: 'Такого кода нет' });
  if (await db().get(`code:${c}`)) return json(409, { error: 'Код уже использован' });

  await db().set(`code:${c}`, email);
  const [tier, per] = list[c].split(':');
  const user = (await loadUser(email)) || {};
  user.plan = Number(tier);
  user.per = per;
  user.until = Date.now() + (per === 'w' ? 7 : 30) * 864e5;
  await saveUser(email, user);
  return json(200, { plan: PLANS[user.plan].name, per, until: user.until });
}

export default async (req) => {
  const path = new URL(req.url).pathname;
  try {
    if (path === '/api/auth') return await auth(req);
    if (path === '/api/me') return await me(req);
    if (path === '/api/chat') return await chat(req);
    if (path === '/api/code') return await code(req);
    return json(404, { error: 'Нет такого адреса' });
  } catch (e) {
    return json(500, { error: 'Ошибка сервера: ' + e.message });
  }
};

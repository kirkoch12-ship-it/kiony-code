import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

// Лимиты такие же, как в Kiony AI. Счётчики у Kiony Code свои.
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

export const config = { path: '/api/*' };

const db = () => getStore('kiony-code');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const day = () => new Date().toISOString().slice(0, 10);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const loadUser = email => db().get(`u:${email}`, { type: 'json' });
const saveUser = (email, u) => db().setJSON(`u:${email}`, u);
const usageOf = async email => (await db().get(`use:${email}:${day()}`, { type: 'json' })) || { r: 0, t: 0, c: 0, m: {} };

const tokenOf = req => (req.headers.get('authorization') || '').replace(/^Bearer /, '');
async function userOf(req) {
  const token = tokenOf(req);
  if (!token) return null;
  return (await db().get(`s:${token}`)) || (await db().get(`agent:${token}`));
}

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

// Запуск ответа: сразу возвращаем jobId, а работу делает фоновая функция chat-background
async function chatStart(req) {
  const token = tokenOf(req);
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const { model, messages } = await req.json();
  if (!Array.isArray(messages) || !messages.length) return json(400, { error: 'Пустой запрос' });

  const jobId = crypto.randomUUID();
  await db().setJSON(`job:${jobId}`, { email, status: 'pending' });
  try {
    const bg = await fetch(new URL(req.url).origin + '/.netlify/functions/chat-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, token, model, messages }),
    });
    if (!bg.ok) await db().setJSON(`job:${jobId}`, { email, status: 'error', error: `фоновая функция не запустилась (код ${bg.status}). Проверь, что файл chat-background.mjs лежит в netlify/functions` });
  } catch (e) {
    await db().setJSON(`job:${jobId}`, { email, status: 'error', error: 'не удалось запустить фоновую функцию: ' + e.message });
  }
  return json(200, { jobId });
}

// Проверка готовности ответа
async function job(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const id = new URL(req.url).searchParams.get('id') || '';
  const j = await db().get(`job:${id}`, { type: 'json' });
  if (!j || j.email !== email) return json(404, { error: 'Нет такого ответа' });
  return json(200, { status: j.status, reply: j.reply, error: j.error });
}

// CODE_LIST в настройках Netlify, например: {"STARTER-7F3K":"1:m","PRO-9QX2":"2:w"}
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

// ---- Telegram-агент ----
const PAUSE_MS = 30 * 60 * 1000;

async function tgGet(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const tg = (await db().get(`tg:${email}`, { type: 'json' })) || {};
  return json(200, { apiId: tg.apiId || '', hasHash: !!tg.apiHash, device: tg.device || 'pc', consentAt: tg.consentAt || 0 });
}

async function tgSave(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const { apiId, apiHash, device, consent } = await req.json();
  const old = (await db().get(`tg:${email}`, { type: 'json' })) || {};
  if (!old.consentAt && consent !== true) return json(400, { error: 'Поставь галочку согласия на риск' });
  const tg = { ...old, apiId: String(apiId || old.apiId || '').trim(), device: device === 'phone' ? 'phone' : 'pc', consentAt: old.consentAt || Date.now() };
  if (String(apiHash || '').trim()) tg.apiHash = String(apiHash).trim();
  if (!/^\d+$/.test(tg.apiId)) return json(400, { error: 'api_id — это число' });
  if (!tg.apiHash) return json(400, { error: 'Нужен api_hash' });
  await db().setJSON(`tg:${email}`, tg);
  return json(200, { ok: true });
}

async function agentToken(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const tg = (await db().get(`tg:${email}`, { type: 'json' })) || {};
  if (!tg.consentAt || !tg.apiHash) return json(400, { error: 'Сначала сохрани настройки Telegram' });
  if (tg.agentToken) await db().delete(`agent:${tg.agentToken}`);
  const token = crypto.randomBytes(24).toString('hex');
  tg.agentToken = token;
  await db().setJSON(`tg:${email}`, tg);
  await db().set(`agent:${token}`, email);
  return json(200, { token });
}

async function agentConfig(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нет доступа' });
  const tg = (await db().get(`tg:${email}`, { type: 'json' })) || {};
  return json(200, { apiId: Number(tg.apiId), apiHash: tg.apiHash });
}

async function agentDialogs(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нет доступа' });
  const { dialogs } = await req.json();
  await db().setJSON(`dlg:${email}`, Array.isArray(dialogs) ? dialogs.slice(0, 200) : []);
  return json(200, { ok: true });
}

async function chats(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  return json(200, { dialogs: (await db().get(`dlg:${email}`, { type: 'json' })) || [] });
}

async function taskNew(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const { index, instruction, model } = await req.json();
  const chat = ((await db().get(`dlg:${email}`, { type: 'json' })) || [])[Number(index)];
  if (!chat) return json(400, { error: 'Нет такого чата. Открой /chats' });
  const text = String(instruction || '').trim().slice(0, 500);
  if (!text) return json(400, { error: 'Напиши, что написать' });
  const id = crypto.randomUUID();
  await db().setJSON(`task:${id}`, { email, status: 'queued', chatId: chat.id, title: chat.title, instruction: text, model: model || 'claude-haiku-5-5' });
  const ids = (await db().get(`tq:${email}`, { type: 'json' })) || [];
  await db().setJSON(`tq:${email}`, [...ids, id].slice(-50));
  return json(200, { id });
}

async function taskGet(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const id = new URL(req.url).searchParams.get('id') || '';
  const t = await db().get(`task:${id}`, { type: 'json' });
  if (!t || t.email !== email) return json(404, { error: 'Нет такой задачи' });
  return json(200, { status: t.status, title: t.title, draft: t.draft, error: t.error });
}

// Подтверждение отправки и отмена черновика. Пауза 30 минут проверяется здесь.
async function taskAct(req, action) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нужен вход' });
  const { id } = await req.json();
  const t = await db().get(`task:${id}`, { type: 'json' });
  if (!t || t.email !== email) return json(404, { error: 'Нет такой задачи' });
  if (action === 'cancel') {
    if (t.status !== 'draft') return json(400, { error: 'Отменить можно только черновик' });
    t.status = 'cancelled';
  } else {
    if (t.status !== 'draft') return json(400, { error: 'Этот черновик уже нельзя отправить' });
    const last = (await db().get(`last:${email}`, { type: 'json' })) || 0;
    const wait = last + PAUSE_MS - Date.now();
    if (wait > 0) return json(429, { error: `Пауза между сообщениями 30 минут. Можно отправить через ${Math.ceil(wait / 60000)} мин.` });
    await db().setJSON(`last:${email}`, Date.now());
    t.status = 'approved';
  }
  await db().setJSON(`task:${id}`, t);
  return json(200, { ok: true });
}

async function agentNext(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нет доступа' });
  for (const id of (await db().get(`tq:${email}`, { type: 'json' })) || []) {
    const t = await db().get(`task:${id}`, { type: 'json' });
    if (t && (t.status === 'queued' || t.status === 'approved')) {
      t.status = t.status === 'queued' ? 'drafting' : 'sending';
      await db().setJSON(`task:${id}`, t);
      return json(200, { task: { id, type: t.status === 'drafting' ? 'draft' : 'send', chatId: t.chatId, instruction: t.instruction, model: t.model, draft: t.draft } });
    }
  }
  return json(200, { task: null });
}

async function agentReport(req) {
  const email = await userOf(req);
  if (!email) return json(401, { error: 'Нет доступа' });
  const { id, draft, sent, error } = await req.json();
  const t = await db().get(`task:${id}`, { type: 'json' });
  if (!t || t.email !== email) return json(404, { error: 'Нет такой задачи' });
  if (error) { t.status = 'error'; t.error = String(error).slice(0, 300); }
  else if (sent) t.status = 'sent';
  else if (draft !== undefined) { t.status = 'draft'; t.draft = String(draft).slice(0, 4000); }
  await db().setJSON(`task:${id}`, t);
  return json(200, { ok: true });
}

export default async (req) => {
  const path = new URL(req.url).pathname;
  try {
    if (path === '/api/auth') return await auth(req);
    if (path === '/api/me') return await me(req);
    if (path === '/api/chat') return await chatStart(req);
    if (path === '/api/job') return await job(req);
    if (path === '/api/code') return await code(req);
    if (path === '/api/tg') return req.method === 'GET' ? await tgGet(req) : await tgSave(req);
    if (path === '/api/agent/token') return await agentToken(req);
    if (path === '/api/agent/config') return await agentConfig(req);
    if (path === '/api/agent/dialogs') return await agentDialogs(req);
    if (path === '/api/agent/next') return await agentNext(req);
    if (path === '/api/agent/report') return await agentReport(req);
    if (path === '/api/chats') return await chats(req);
    if (path === '/api/task/new') return await taskNew(req);
    if (path === '/api/task/approve') return await taskAct(req, 'approve');
    if (path === '/api/task/cancel') return await taskAct(req, 'cancel');
    if (path === '/api/task') return await taskGet(req);
    return json(404, { error: 'Нет такого адреса' });
  } catch (e) {
    return json(500, { error: 'Ошибка сервера: ' + e.message });
  }
};

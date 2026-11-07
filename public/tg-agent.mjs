// Kiony Agent: работает на твоём устройстве. Сессия Telegram хранится только здесь, на сайт не уходит.
// Правила: пишет только в чаты, где уже была переписка; вступает в группы и добавляет контакты НЕ умеет;
// отправляет только сообщения, которые ты подтвердил на сайте; между отправками пауза 30 минут.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import readline from 'node:readline/promises';
import qrcode from 'qrcode-terminal';

const CFG = 'kiony-agent.json', SESS = 'tg-session.txt', LAST = 'last-sent.txt', PAUSE = 30 * 60 * 1000;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cfg;
if (existsSync(CFG)) cfg = JSON.parse(readFileSync(CFG, 'utf8'));
else {
  cfg = {
    server: (await rl.question('Адрес сайта, например https://твой-сайт.netlify.app: ')).trim().replace(/\/$/, ''),
    agentToken: (await rl.question('Токен агента (из /settings на сайте): ')).trim(),
  };
  writeFileSync(CFG, JSON.stringify(cfg));
}

async function api(path, body) {
  const r = await fetch(cfg.server + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.agentToken },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Ошибка ' + r.status);
  return j;
}

const { apiId, apiHash } = await api('/agent/config');
const client = new TelegramClient(
  new StringSession(existsSync(SESS) ? readFileSync(SESS, 'utf8') : ''), apiId, apiHash, { connectionRetries: 3 });
// Вход по QR-ссылке: код по SMS или в Telegram не нужен.
// В Termux открываешь выведенную ссылку, Telegram спрашивает подтверждение входа — подтверждаешь.
async function qrLogin() {
  await client.connect();
  await client.signInUserWithQrCode({ apiId, apiHash }, {
    qrCode: async ({ token }) => {
      const url = 'tg://login?token=' + Buffer.from(token).toString('base64url');
      console.log('\nСканируй QR другим устройством, где открыт этот аккаунт Telegram:');
      console.log('Telegram → Настройки → Устройства → Подключить устройство\n');
      qrcode.generate(url, { small: true });
      console.log('\nQR обновляется сам. Сканируй последний показанный код.\n');
    },
    password: () => rl.question('Пароль двухэтапной проверки: '),
    onError: e => console.error('Ошибка входа:', e.message),
  });
}

if (!existsSync(SESS) || !readFileSync(SESS, 'utf8').trim()) {
  const choice = (await rl.question('Вход: 1 — по QR-ссылке (рекомендуется), 2 — по номеру и коду: ')).trim();
  if (choice === '2') {
    await client.start({
      phoneNumber: () => rl.question('Номер телефона (+…): '),
      phoneCode: () => rl.question('Код из Telegram: '),
      password: () => rl.question('Пароль двухэтапной проверки: '),
      onError: e => console.error('Telegram:', e.message),
    });
  } else {
    await qrLogin();
  }
} else {
  await client.connect();
}
writeFileSync(SESS, client.session.save());
console.log('Telegram подключён. Агент работает. Чтобы остановить — Ctrl+C.');

// Сторожевой таймер: если связь с Telegram пропала больше 3 минут, агент завершится,
// а цикл перезапуска в Termux запустит его заново (вход повторно не нужен).
let lastOk = Date.now();
setInterval(async () => {
  try {
    await Promise.race([
      client.getMe(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут')), 20000)),
    ]);
    lastOk = Date.now();
  } catch (e) { /* связи нет, ждём */ }
  if (Date.now() - lastOk > 180000) {
    console.error('Нет связи с Telegram больше 3 минут. Перезапускаю агента…');
    process.exit(1);
  }
}, 60000);

const entities = new Map();          // id чата -> объект чата из Telegram (только из списка переписок)
let lastSent = Number(existsSync(LAST) ? readFileSync(LAST, 'utf8') : 0);

async function syncDialogs() {
  const list = [];
  for (const d of await client.getDialogs({ limit: 100 })) {
    if (!d.message || !d.entity) continue;          // только чаты, где уже была переписка
    const type = d.isGroup ? 'group' : d.isChannel ? 'channel' : 'user';
    const canPost = type !== 'channel' || !!(d.entity.creator || d.entity.adminRights);
    const id = d.id.toString();
    entities.set(id, d.entity);
    list.push({ id, title: d.title || d.name || 'Без названия', type, canPost });
  }
  await api('/agent/dialogs', { dialogs: list });
  console.log(`Чатов доступно агенту: ${list.length}`);
}

// Черновик: агент читает последние 30 сообщений этого чата и просит модель написать текст
async function makeDraft(t) {
  const { limits } = await api('/me');                  // лимит входа для твоего плана
  const msgs = (await client.getMessages(entities.get(t.chatId), { limit: 30 })).reverse();
  const tail = `\n\nЗадача: ${t.instruction}\nНапиши только текст сообщения, без пояснений и кавычек.`;
  const room = limits.inTok * 3 - tail.length - 200;
  let ctx = '';
  for (const m of [...msgs].reverse()) {                // от новых к старым, пока влезает
    if (!m.message) continue;
    const line = `${m.out ? 'Я' : 'Собеседник'}: ${m.message}\n`;
    if (ctx.length + line.length > room) break;
    ctx = line + ctx;
  }
  const { jobId } = await api('/chat', {
    model: t.model,
    messages: [{ role: 'user', content: `Переписка:\n${ctx}${tail}` }],
  });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const j = await api('/job?id=' + jobId);
    if (j.status === 'done') return j.reply;
    if (j.status === 'error') throw new Error(j.error);
  }
  throw new Error('модель не ответила');
}

// Отправка: только подтверждённый текст, с паузой 30 минут
async function sendMsg(t) {
  if (Date.now() - lastSent < PAUSE) throw new Error('пауза 30 минут ещё не прошла');
  await sleep(3000 + Math.random() * 7000);
  await client.sendMessage(entities.get(t.chatId), { message: t.draft });
  lastSent = Date.now();
  writeFileSync(LAST, String(lastSent));
}

async function handle(t) {
  try {
    if (!entities.has(t.chatId)) throw new Error('чат не найден у агента, обнови список на сайте (/chats)');
    if (t.type === 'draft') return api('/agent/report', { id: t.id, draft: await makeDraft(t) });
    await sendMsg(t);
    return api('/agent/report', { id: t.id, sent: true });
  } catch (e) {
    return api('/agent/report', { id: t.id, error: e.message });
  }
}

let lastSync = 0;
while (true) {
  try {
    if (Date.now() - lastSync > 10 * 60 * 1000) { await syncDialogs(); lastSync = Date.now(); }
    const { task } = await api('/agent/next');
    if (task) await handle(task);
  } catch (e) {
    console.error('Ошибка:', e.message);
  }
  await sleep(10000);
}

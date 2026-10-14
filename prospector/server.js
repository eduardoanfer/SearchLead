require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const {
  PORT = 3000,
  ADMIN_USER,
  ADMIN_PASS,
  SESSION_SECRET,
  GOOGLE_PLACES_API_KEY,
  EVOLUTION_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE,
  WEBHOOK_TOKEN = '',
  SEND_START_HOUR = 8,
  SEND_END_HOUR = 18,
  SEND_WEEKDAYS_ONLY = 'true',
} = process.env;

for (const k of ['ADMIN_USER', 'ADMIN_PASS', 'SESSION_SECRET']) {
  if (!process.env[k]) { console.error(`Defina ${k} no arquivo .env`); process.exit(1); }
}

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT UNIQUE,
  name TEXT, phone TEXT, wa_number TEXT, address TEXT,
  niche TEXT, region TEXT,
  has_whatsapp INTEGER DEFAULT NULL,
  opted_out INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, message TEXT,
  min_delay INTEGER, max_delay INTEGER, daily_limit INTEGER,
  status TEXT DEFAULT 'paused',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER, lead_id INTEGER,
  status TEXT DEFAULT 'pending', error TEXT, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_campaign ON messages(campaign_id, status);
`);

const adminHash = bcrypt.hashSync(ADMIN_PASS, 10);
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

/* ---------- Webhook de descadastro (sem sessão, protegido por token) ---------- */
app.post('/webhook/evolution', (req, res) => {
  if (WEBHOOK_TOKEN && req.query.token !== WEBHOOK_TOKEN) return res.sendStatus(401);
  try {
    const d = req.body?.data || {};
    const m = Array.isArray(d) ? d[0] : d;
    if (m?.key && !m.key.fromMe) {
      const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
      if (/^(sair|parar|stop|remover|cancelar)$/i.test(text)) {
        const num = String(m.key.remoteJid || '').split('@')[0];
        db.prepare('UPDATE leads SET opted_out = 1 WHERE wa_number = ? OR phone = ?').run(num, num);
        db.prepare(`UPDATE messages SET status='skipped' WHERE status='pending' AND lead_id IN
                    (SELECT id FROM leads WHERE opted_out=1)`).run();
      }
    }
  } catch (e) { console.error('webhook', e.message); }
  res.sendStatus(200);
});

/* ---------- Auth ---------- */
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && bcrypt.compareSync(String(pass || ''), adminHash)) {
    attempts.delete(ip);
    req.session.auth = true;
    return res.json({ ok: true });
  }
  a.n++; attempts.set(ip, a);
  res.status(401).json({ error: 'Usuário ou senha incorretos.' });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ auth: !!req.session.auth }));

const guard = (req, res, next) => (req.session.auth ? next() : res.status(401).json({ error: 'Faça login.' }));
app.use('/api', (req, res, next) => (['/login', '/me'].includes(req.path) ? next() : guard(req, res, next)));

/* ---------- Google Places (API oficial) ---------- */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (!d.startsWith('55')) d = '55' + d;
  return d;
}
const isMobileBR = (d) => /^55\d{2}9\d{8}$/.test(d);

async function placesSearch(textQuery, max) {
  if (!GOOGLE_PLACES_API_KEY) throw new Error('Configure GOOGLE_PLACES_API_KEY no .env');
  const out = [];
  let token;
  do {
    const body = { textQuery, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 20 };
    if (token) body.pageToken = token;
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,nextPageToken',
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'Erro na Places API');
    out.push(...(j.places || []));
    token = j.nextPageToken;
    if (token) await sleep(1200);
  } while (token && out.length < max);
  return out.slice(0, max);
}

app.post('/api/leads/search', async (req, res) => {
  try {
    const niche = String(req.body.niche || '').trim();
    const region = String(req.body.region || '').trim();
    const max = Math.min(Number(req.body.max) || 60, 60);
    if (!niche || !region) return res.status(400).json({ error: 'Informe nicho e região.' });
    const places = await placesSearch(`${niche} em ${region}`, max);
    const ins = db.prepare(`INSERT OR IGNORE INTO leads (place_id,name,phone,address,niche,region)
                            VALUES (?,?,?,?,?,?)`);
    let added = 0, noPhone = 0, landline = 0;
    for (const p of places) {
      const phone = normalizePhone(p.internationalPhoneNumber);
      if (!phone) { noPhone++; continue; }
      if (!isMobileBR(phone)) { landline++; continue; }
      const r = ins.run(p.id, p.displayName?.text || '', phone, p.formattedAddress || '', niche, region);
      added += r.changes;
    }
    res.json({ found: places.length, added, noPhone, landline, duplicates: places.length - noPhone - landline - added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Evolution API ---------- */
const evoHeaders = () => ({ 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY });
const evoReady = () => EVOLUTION_URL && EVOLUTION_API_KEY && EVOLUTION_INSTANCE;

async function evoVerify(numbers) {
  const r = await fetch(`${EVOLUTION_URL}/chat/whatsappNumbers/${EVOLUTION_INSTANCE}`, {
    method: 'POST', headers: evoHeaders(), body: JSON.stringify({ numbers }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.error || 'Erro ao verificar números');
  return j;
}

app.post('/api/leads/verify', async (req, res) => {
  try {
    if (!evoReady()) return res.status(400).json({ error: 'Configure a Evolution API no .env' });
    const rows = db.prepare('SELECT id, phone FROM leads WHERE has_whatsapp IS NULL').all();
    const upd = db.prepare('UPDATE leads SET has_whatsapp=?, wa_number=? WHERE id=?');
    let yes = 0, no = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const result = await evoVerify(chunk.map((c) => c.phone));
      chunk.forEach((c, idx) => {
        const r = result.find((x) => String(x.number) === c.phone) || result[idx] || {};
        if (r.exists) { upd.run(1, String(r.jid || c.phone).split('@')[0], c.id); yes++; }
        else { upd.run(0, null, c.id); no++; }
      });
      await sleep(1000);
    }
    res.json({ checked: rows.length, withWhatsapp: yes, without: no });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Contatos ---------- */
app.get('/api/leads', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1000').all();
  const stats = db.prepare(`SELECT COUNT(*) total,
      SUM(has_whatsapp=1) wa, SUM(has_whatsapp IS NULL) pending, SUM(opted_out=1) optout FROM leads`).get();
  res.json({ rows, stats });
});
app.post('/api/leads/:id/optout', (req, res) => {
  db.prepare('UPDATE leads SET opted_out=1 WHERE id=?').run(req.params.id);
  db.prepare(`UPDATE messages SET status='skipped' WHERE status='pending' AND lead_id=?`).run(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- Campanhas ---------- */
app.get('/api/campaigns', (req, res) => {
  const rows = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  const st = db.prepare(`SELECT status, COUNT(*) n FROM messages WHERE campaign_id=? GROUP BY status`);
  rows.forEach((c) => {
    c.stats = Object.fromEntries(st.all(c.id).map((s) => [s.status, s.n]));
  });
  res.json(rows);
});

app.post('/api/campaigns', (req, res) => {
  const { name, message, niche, region } = req.body;
  const minD = Math.max(Number(req.body.min_delay) || 45, 20);
  const maxD = Math.max(Number(req.body.max_delay) || 120, minD);
  const daily = Math.min(Number(req.body.daily_limit) || 30, 200);
  if (!name || !message) return res.status(400).json({ error: 'Informe nome e mensagem.' });
  const c = db.prepare('INSERT INTO campaigns (name,message,min_delay,max_delay,daily_limit) VALUES (?,?,?,?,?)')
    .run(name, message, minD, maxD, daily);
  let sql = `SELECT id FROM leads WHERE has_whatsapp=1 AND opted_out=0
             AND id NOT IN (SELECT lead_id FROM messages WHERE status='sent')`;
  const params = [];
  if (niche) { sql += ' AND niche = ?'; params.push(niche); }
  if (region) { sql += ' AND region = ?'; params.push(region); }
  const leads = db.prepare(sql).all(...params);
  const ins = db.prepare('INSERT INTO messages (campaign_id, lead_id) VALUES (?,?)');
  db.transaction(() => leads.forEach((l) => ins.run(c.lastInsertRowid, l.id)))();
  res.json({ id: c.lastInsertRowid, recipients: leads.length });
});

app.post('/api/campaigns/:id/:action', (req, res) => {
  const map = { start: 'running', pause: 'paused' };
  if (!map[req.params.action]) return res.sendStatus(404);
  if (req.params.action === 'start' && !evoReady()) {
    return res.status(400).json({ error: 'Configure a Evolution API no .env' });
  }
  db.prepare('UPDATE campaigns SET status=? WHERE id=?').run(map[req.params.action], req.params.id);
  res.json({ ok: true });
});
app.delete('/api/campaigns/:id', (req, res) => {
  db.prepare('DELETE FROM messages WHERE campaign_id=?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- Worker de envio ---------- */
const spin = (t) => t.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => { const o = g.split('|'); return o[rand(0, o.length - 1)]; });
const firstName = (n) => String(n || '').split(/\s+/)[0] || '';
function buildText(tpl, lead) {
  return spin(tpl).replace(/\{nome\}/gi, lead.name || '').replace(/\{primeiro_nome\}/gi, firstName(lead.name)).trim()
    + '\n\nPara não receber mais mensagens, responda SAIR.';
}
function inWindow() {
  const now = new Date();
  if (String(SEND_WEEKDAYS_ONLY) === 'true' && [0, 6].includes(now.getDay())) return false;
  return now.getHours() >= Number(SEND_START_HOUR) && now.getHours() < Number(SEND_END_HOUR);
}

let nextAt = 0, busy = false;
async function tick() {
  if (busy || Date.now() < nextAt || !inWindow() || !evoReady()) return;
  busy = true;
  try {
    const camps = db.prepare(`SELECT * FROM campaigns WHERE status='running' ORDER BY id`).all();
    for (const c of camps) {
      const sentToday = db.prepare(`SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND status='sent'
                                    AND date(sent_at,'localtime')=date('now','localtime')`).get(c.id).n;
      if (sentToday >= c.daily_limit) continue;
      const m = db.prepare(`SELECT m.id, l.name, l.wa_number, l.opted_out FROM messages m
                            JOIN leads l ON l.id=m.lead_id WHERE m.campaign_id=? AND m.status='pending' LIMIT 1`).get(c.id);
      if (!m) { db.prepare(`UPDATE campaigns SET status='done' WHERE id=?`).run(c.id); continue; }
      if (m.opted_out) { db.prepare(`UPDATE messages SET status='skipped' WHERE id=?`).run(m.id); continue; }
      try {
        const r = await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
          method: 'POST', headers: evoHeaders(),
          body: JSON.stringify({ number: m.wa_number, text: buildText(c.message, m) }),
        });
        if (!r.ok) throw new Error((await r.text()).slice(0, 200));
        db.prepare(`UPDATE messages SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=?`).run(m.id);
      } catch (e) {
        db.prepare(`UPDATE messages SET status='failed', error=? WHERE id=?`).run(e.message, m.id);
      }
      nextAt = Date.now() + rand(c.min_delay, c.max_delay) * 1000;
      break;
    }
  } finally { busy = false; }
}
setInterval(tick, 3000);

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));

// SPECTRE — lecture et analyse de contenu (pages web rendues, texte collé, documents PDF/MD)
// Zéro dépendance npm. IA : OpenRouter si clé fournie, sinon Ollama local (qwen2.5:3b).
'use strict';

const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');

const PORT = 8087;
const MAX_TEXT = 3000;          // plafond du texte envoyé à l'IA (Cloudflare coupe à 100 s)
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || 'http://browserless:3000';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';
const OPENROUTER_KEY_FILE = '/etc/openrouter-key.txt';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen-2.5-7b-instruct:free';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

// ---------- utilitaires ----------

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '\u0026')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à')
    .replace(/&ccedil;/g, 'ç').replace(/&ecirc;/g, 'ê').replace(/&euro;/g, '€');
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\r\f]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function fetchWithTimeout(url, opts, ms) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

// Extraction du texte d'un PDF (poppler-utils) depuis un buffer
function pdfToText(buf) {
  return new Promise((resolve, reject) => {
    const p = execFile('pdftotext', ['-', '-'], { maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
    p.stdin.write(buf);
    p.stdin.end();
  });
}

// ---------- sources ----------

async function textFromUrl(url) {
  const t0 = Date.now();
  if (!/^https?:\/\//i.test(url)) throw new Error('URL invalide (http/https requis)');
  if (!BROWSERLESS_TOKEN) throw new Error('BROWSERLESS_TOKEN non configuré');
  const r = await fetchWithTimeout(
    `${BROWSERLESS_URL}/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, gotoOptions: { waitUntil: 'domcontentloaded', timeout: 60000 } }) },
    90000
  );
  console.error(`[spectre] browserless status ${r.status} en ${(Date.now() - t0) / 1000}s pour ${url}`);
  if (!r.ok) throw new Error(`Browserless ${r.status} (page inaccessible ?)`);
  const html = await r.text();
  console.error(`[spectre] body lu (${html.length} octets) en ${(Date.now() - t0) / 1000}s`);
  const text = htmlToText(html);
  console.error(`[spectre] extraction faite en ${(Date.now() - t0) / 1000}s`);
  return { text, source: url };
}

async function textFromDocument(filename, base64) {
  const safe = String(filename || 'document').toLowerCase();
  const buf = Buffer.from(base64 || '', 'base64');
  if (!buf.length) throw new Error('Document vide');
  if (safe.endsWith('.pdf')) {
    const txt = await pdfToText(buf);
    return { text: txt, source: filename };
  }
  if (safe.endsWith('.md') || safe.endsWith('.markdown') || safe.endsWith('.txt')) {
    return { text: buf.toString('utf8'), source: filename };
  }
  throw new Error('Type non supporté (PDF, MD ou TXT uniquement)');
}

// ---------- IA ----------

function buildPrompt(texte, question) {
  const contenu = texte.slice(0, MAX_TEXT);
  if (question && question.trim()) {
    return `Tu es un assistant d'analyse de contenu. Réponds en français, de façon concise et factuelle, à la question en te basant UNIQUEMENT sur le contenu fourni. Si la réponse n'y figure pas, dis-le.\n\n### Question :\n${question.trim()}\n\n### Contenu :\n${contenu}`;
  }
  return `Tu es un assistant d'analyse de contenu. Résume en français le contenu suivant en 5 points maximum (une ligne par point), puis une ligne "En bref :" avec l'essentiel.\n\n### Contenu :\n${contenu}`;
}

async function iaOpenRouter(prompt, key) {
  const model = OPENROUTER_MODEL;
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
  }, 95000);
  if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
  const j = await r.json();
  const answer = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!answer) throw new Error('Réponse OpenRouter vide');
  return { answer: answer.trim(), model: `openrouter/${model}` };
}

async function iaOllama(prompt) {
  const r = await fetchWithTimeout(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, keep_alive: 0, options: { num_ctx: 4096 } })
  }, 95000);
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const j = await r.json();
  if (!j.response) throw new Error('Réponse Ollama vide');
  return { answer: j.response.trim(), model: `ollama/${OLLAMA_MODEL}` };
}

async function askIA(prompt) {
  let key = null;
  try { key = fs.readFileSync(OPENROUTER_KEY_FILE, 'utf8').trim(); } catch (_) { /* pas de clé */ }
  if (key) {
    try { return await iaOpenRouter(prompt, key); }
    catch (e) { console.error('OpenRouter KO, bascule Ollama :', e.message); }
  }
  return iaOllama(prompt);
}

// ---------- serveur ----------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    fs.readFile(__dirname + '/public/index.html', (err, data) => {
      if (err) { res.writeHead(500); return res.end('Erreur lecture front'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/healthz') {
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && u.pathname === '/api/analyze') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 30 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      const t0 = Date.now();
      try {
        const body = JSON.parse(raw || '{}');
        const mode = body.mode;
        let extracted;
        if (mode === 'url') extracted = await textFromUrl(body.url || '');
        else if (mode === 'texte') {
          if (!body.texte || !body.texte.trim()) throw new Error('Texte vide');
          extracted = { text: body.texte, source: 'texte collé' };
        }
        else if (mode === 'document') extracted = await textFromDocument(body.filename, body.content);
        else throw new Error('mode inconnu (url | texte | document)');

        if (!extracted.text.trim()) throw new Error('Aucun texte exploitable extrait');
        const { answer, model } = await askIA(buildPrompt(extracted.text, body.question));
        return send(res, 200, {
          ok: true, source: extracted.source, mode,
          chars: extracted.text.length, capped: extracted.text.length > MAX_TEXT,
          answer, model, ms: Date.now() - t0
        });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message || String(e), ms: Date.now() - t0 });
      }
    });
    return;
  }
  send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`SPECTRE prêt sur ${PORT}`));
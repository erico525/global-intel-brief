const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PASSWORD = process.env.ACCESS_PASSWORD || 'changeme';
const sessions = new Map();

// ── CACHE ──
let cachedBrief = null;
let cacheTime = null;
let generating = false;

function parseBody(req) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { res(JSON.parse(b)); } catch(e) { res({}); } });
    req.on('error', rej);
  });
}

function authed(req) {
  const m = (req.headers.cookie||'').match(/gib2=([a-f0-9]+)/);
  return m && sessions.has(m[1]);
}

function respond(res, status, type, body) {
  res.writeHead(status, {'Content-Type': type});
  res.end(body);
}

function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 120000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic request timed out')); });
    req.write(payload);
    req.end();
  });
}

async function generateBrief() {
  if (generating) {
    console.log('Generation already in progress, skipping.');
    return;
  }
  generating = true;
  console.log('Generating brief at', new Date().toISOString());

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `You are a senior intelligence analyst producing a daily Global Intelligence Brief for ${date}.

CRITICAL REQUIREMENT: Every piece of intelligence must be REAL, SPECIFIC, and CURRENT. No generic placeholders. Use actual named events, real countries, real threat actors, real CVE numbers, real market prices from today. If you are uncertain of exact current prices, use your best knowledge and note approximate.

Return ONLY valid JSON starting with { and ending with }. No markdown, no code fences, no explanation.

{
  "date": "${date}",
  "edition": "Daily Edition",
  "risks": {
    "overall": "CRITICAL|HIGH|MEDIUM|WATCH",
    "geo": "CRITICAL|HIGH|MEDIUM|WATCH",
    "cyber": "CRITICAL|HIGH|MEDIUM|WATCH",
    "market": "CRITICAL|HIGH|MEDIUM|WATCH",
    "supply": "CRITICAL|HIGH|MEDIUM|WATCH"
  },
  "situation": {
    "breaking": "REAL breaking news story with specific country/actor/event name. 2 sentences.",
    "headline": "REAL lead geopolitical story with specific named parties. 2 sentences.",
    "diplomacy": "REAL diplomatic development with named countries/leaders. 2 sentences.",
    "cyber": "REAL active cyber threat with specific named threat actor or CVE. 2 sentences."
  },
  "geo": {
    "score": "HIGH",
    "stories": [
      {"n": 1, "title": "Specific Real Story Title", "body": "2-3 sentences with named actors, locations, dates."},
      {"n": 2, "title": "Specific Real Story Title", "body": "2-3 sentences with named actors, locations, dates."},
      {"n": 3, "title": "Specific Real Story Title", "body": "2-3 sentences with named actors, locations, dates."},
      {"n": 4, "title": "Specific Real Story Title", "body": "2-3 sentences with named actors, locations, dates."},
      {"n": 5, "title": "Specific Real Story Title", "body": "2-3 sentences with named actors, locations, dates."}
    ],
    "note_title": "Analytical headline",
    "note": "2-3 sentence strategic assessment grounded in the actual stories above."
  },
  "cyber": {
    "score": "HIGH",
    "threats": [
      {"actor": "Real named threat actor or CVE ID", "tactic": "Specific real attack method", "target": "Real targeted sector or org", "level": "CRITICAL"},
      {"actor": "Real named threat actor or CVE ID", "tactic": "Specific real attack method", "target": "Real targeted sector or org", "level": "HIGH"},
      {"actor": "Real named threat actor or CVE ID", "tactic": "Specific real attack method", "target": "Real targeted sector or org", "level": "HIGH"},
      {"actor": "Real named threat actor or CVE ID", "tactic": "Specific real attack method", "target": "Real targeted sector or org", "level": "HIGH"},
      {"actor": "Real named threat actor or CVE ID", "tactic": "Specific real attack method", "target": "Real targeted sector or org", "level": "MEDIUM"}
    ],
    "themes": [
      "Specific analytical theme based on real threats above.",
      "Specific analytical theme based on real threats above.",
      "Specific analytical theme based on real threats above."
    ],
    "note_title": "Analytical headline",
    "note": "2-3 sentence assessment of today's cyber threat landscape."
  },
  "markets": {
    "score": "MEDIUM",
    "assets": [
      {"name": "S&P 500", "price": "real approximate price", "context": "1 sentence real context", "trend": "up|down|flat"},
      {"name": "Brent Crude", "price": "real approximate price", "context": "1 sentence real context", "trend": "up|down|flat"},
      {"name": "Gold", "price": "real approximate price", "context": "1 sentence real context", "trend": "up|down|flat"},
      {"name": "US 10-Yr Treasury", "price": "real approximate yield", "context": "1 sentence real context", "trend": "up|down|flat"},
      {"name": "Bitcoin", "price": "real approximate price", "context": "1 sentence real context", "trend": "up|down|flat"},
      {"name": "USD/EUR", "price": "real approximate rate", "context": "1 sentence real context", "trend": "up|down|flat"},
      {"name": "VIX", "price": "real approximate level", "context": "1 sentence real context", "trend": "up|down|flat"}
    ],
    "signals": [
      "Real specific market signal or economic development.",
      "Real specific market signal or economic development.",
      "Real specific market signal or economic development."
    ],
    "note_title": "Analytical headline",
    "note": "2-3 sentence assessment of current market conditions."
  },
  "watch": [
    {"item": "Specific real watch item with named parties", "why": "2 sentences explaining real stakes and timeline.", "priority": "CRITICAL"},
    {"item": "Specific real watch item with named parties", "why": "2 sentences explaining real stakes and timeline.", "priority": "HIGH"},
    {"item": "Specific real watch item with named parties", "why": "2 sentences explaining real stakes and timeline.", "priority": "HIGH"},
    {"item": "Specific real watch item with named parties", "why": "2 sentences explaining real stakes and timeline.", "priority": "MEDIUM"},
    {"item": "Specific real watch item with named parties", "why": "2 sentences explaining real stakes and timeline.", "priority": "WATCH"}
  ],
  "sources": "Reuters, AP, Bloomberg, CISA KEV, Financial Times, OSINT"
}`;

  try {
    const result = await callAnthropic({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 5000,
      messages: [{ role: 'user', content: prompt }]
    });

    if (result.status !== 200) {
      const e = JSON.parse(result.body);
      throw new Error(e.error ? e.error.message : 'API error ' + result.status);
    }

    const resp = JSON.parse(result.body);
    const raw = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in response');

    cachedBrief = JSON.parse(raw.slice(start, end + 1));
    cacheTime = new Date();
    console.log('Brief generated successfully at', cacheTime.toISOString());
  } catch(e) {
    console.error('Brief generation failed:', e.message);
  } finally {
    generating = false;
  }
}

// Generate on startup, then every 4 hours
generateBrief();
setInterval(generateBrief, 4 * 60 * 60 * 1000);

// ── SERVER ──
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Login
  if (url === '/login' && req.method === 'POST') {
    const b = await parseBody(req);
    if (b.password === PASSWORD) {
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now());
      for (const [k, v] of sessions) if (Date.now() - v > 86400000) sessions.delete(k);
      res.setHeader('Set-Cookie', `gib2=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      return respond(res, 200, 'application/json', JSON.stringify({ ok: true }));
    }
    return respond(res, 401, 'application/json', JSON.stringify({ ok: false }));
  }

  // Auth check
  if (url === '/authcheck') {
    return respond(res, 200, 'application/json', JSON.stringify({ ok: authed(req) }));
  }

  // Serve cached brief
  if (url === '/brief' && req.method === 'POST') {
    if (!authed(req)) return respond(res, 401, 'application/json', JSON.stringify({ error: 'Unauthorized' }));
    if (cachedBrief) {
      return respond(res, 200, 'application/json', JSON.stringify({
        ...cachedBrief,
        _cached_at: cacheTime ? cacheTime.toISOString() : null
      }));
    }
    // Brief not ready yet — still generating on startup
    return respond(res, 503, 'application/json', JSON.stringify({ error: 'Brief is being generated, please try again in 30 seconds.' }));
  }

  // Manual refresh trigger (forces new generation)
  if (url === '/regenerate' && req.method === 'POST') {
    if (!authed(req)) return respond(res, 401, 'application/json', JSON.stringify({ error: 'Unauthorized' }));
    generateBrief(); // fire and forget
    return respond(res, 200, 'application/json', JSON.stringify({ ok: true, message: 'Regenerating brief, check back in 30 seconds.' }));
  }

  // Serve HTML
  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      return respond(res, 200, 'text/html; charset=utf-8', html);
    } catch(e) {
      return respond(res, 500, 'text/plain', 'Error: ' + e.message);
    }
  }

  respond(res, 404, 'text/plain', 'Not found');

}).listen(PORT, () => {
  console.log('GIB Server running on port ' + PORT);
  console.log('API key:', API_KEY ? 'SET' : 'MISSING - set ANTHROPIC_API_KEY env var');
  console.log('Password:', PASSWORD !== 'changeme' ? 'CUSTOM' : 'WARNING: using default password');
});

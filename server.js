const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'changeme';

const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function isAuthenticated(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/gib_session=([a-f0-9]+)/);
  if (!match) return false;
  return sessions.has(match[1]);
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `gib_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
}

function send(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function callAnthropic(requestBody) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(requestBody);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 55000
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

async function generateBrief() {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `Generate a Global Intelligence Brief for ${dateStr}.

You are a senior intelligence analyst. Use your most current knowledge to produce today's brief.
Return ONLY a valid JSON object. Start with { and end with }. No markdown, no code fences.

Schema:
{
  "date": "${dateStr}",
  "edition": "Daily Edition",
  "global_risk": {
    "overall": {"score":"CRITICAL|HIGH|MEDIUM|WATCH","label":"one sentence"},
    "geopolitical": {"score":"CRITICAL|HIGH|MEDIUM|WATCH","label":"one sentence"},
    "cyber": {"score":"CRITICAL|HIGH|MEDIUM|WATCH","label":"one sentence"},
    "market": {"score":"CRITICAL|HIGH|MEDIUM|WATCH","label":"one sentence"},
    "supply_chain": {"score":"CRITICAL|HIGH|MEDIUM|WATCH","label":"one sentence"}
  },
  "situation": {
    "breaking": "2 sentences",
    "headline": "2 sentences",
    "diplomacy": "2 sentences",
    "cyber": "2 sentences"
  },
  "geopolitics": {
    "risk_score": "CRITICAL|HIGH|MEDIUM|WATCH",
    "stories": [{"num":1,"title":"string","body":"2-3 sentences"}],
    "analyst_title": "string",
    "analyst_body": "2-3 sentences"
  },
  "cybersecurity": {
    "risk_score": "CRITICAL|HIGH|MEDIUM|WATCH",
    "threats": [{"actor":"string","tactic":"string","target":"string","level":"CRITICAL|HIGH|MEDIUM|WATCH"}],
    "themes": ["string"],
    "analyst_title": "string",
    "analyst_body": "2-3 sentences"
  },
  "markets": {
    "risk_score": "CRITICAL|HIGH|MEDIUM|WATCH",
    "assets": [{"name":"string","price":"string","context":"1 sentence","trend":"up|down|flat"}],
    "signals": ["string"],
    "analyst_title": "string",
    "analyst_body": "2-3 sentences"
  },
  "watchlist": [{"item":"string","why":"2 sentences","priority":"CRITICAL|HIGH|MEDIUM|WATCH"}],
  "sources": "string"
}

Requirements: 5 geopolitics stories, 5 cyber threats, 7 market assets, 5 watchlist items. Use real current world events.`;

  const result = await callAnthropic({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }]
  });

  if (result.status !== 200) {
    const err = JSON.parse(result.body);
    throw new Error(err.error ? err.error.message : 'API error ' + result.status);
  }

  const response = JSON.parse(result.body);
  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in response');
  return JSON.parse(raw.slice(start, end + 1));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (url === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.password === ACCESS_PASSWORD) {
      const token = generateToken();
      sessions.set(token, { created: Date.now() });
      for (const [k, v] of sessions.entries()) {
        if (Date.now() - v.created > 86400000) sessions.delete(k);
      }
      setCookie(res, token);
      return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    }
    return send(res, 401, 'application/json', JSON.stringify({ ok: false, error: 'Invalid password' }));
  }

  if (url === '/api/auth-check' && req.method === 'GET') {
    return send(res, 200, 'application/json', JSON.stringify({ authenticated: isAuthenticated(req) }));
  }

  if (url === '/api/brief' && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      return send(res, 401, 'application/json', JSON.stringify({ error: 'Unauthorized' }));
    }
    try {
      const data = await generateBrief();
      return send(res, 200, 'application/json', JSON.stringify(data));
    } catch(e) {
      console.error('Brief error:', e.message);
      return send(res, 500, 'application/json', JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      return send(res, 200, 'text/html; charset=utf-8', html);
    } catch(e) {
      return send(res, 500, 'text/plain', 'Could not load index.html: ' + e.message);
    }
  }

  return send(res, 404, 'text/plain', 'Not found');
});

server.listen(PORT, () => {
  console.log('GIB Server running on port ' + PORT);
  console.log('API Key: ' + (ANTHROPIC_API_KEY ? 'SET' : 'MISSING'));
  console.log('Password: ' + (ACCESS_PASSWORD !== 'changeme' ? 'CUSTOM' : 'DEFAULT'));
});

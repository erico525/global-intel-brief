const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'changeme';

// Session store — simple in-memory token map
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
  res.writeHead(status, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function proxyToAnthropic(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // ── LOGIN endpoint ──
  if (url === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.password === ACCESS_PASSWORD) {
      const token = generateToken();
      sessions.set(token, { created: Date.now() });
      // Clean old sessions (> 24h)
      for (const [k, v] of sessions.entries()) {
        if (Date.now() - v.created > 86400000) sessions.delete(k);
      }
      setCookie(res, token);
      return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    }
    return send(res, 401, 'application/json', JSON.stringify({ ok: false, error: 'Invalid password' }));
  }

  // ── CHECK AUTH endpoint ──
  if (url === '/api/auth-check' && req.method === 'GET') {
    return send(res, 200, 'application/json', JSON.stringify({ authenticated: isAuthenticated(req) }));
  }

  // ── ANTHROPIC PROXY endpoint ──
  if (url === '/api/brief' && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      return send(res, 401, 'application/json', JSON.stringify({ error: 'Unauthorized' }));
    }
    try {
      const body = await parseBody(req);
      const result = await proxyToAnthropic(body);
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(result.body);
    } catch(e) {
      return send(res, 500, 'application/json', JSON.stringify({ error: e.message }));
    }
  }

  // ── SERVE HTML ──
  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      return send(res, 200, 'text/html; charset=utf-8', html);
    } catch(e) {
      return send(res, 500, 'text/plain', 'Could not load index.html: ' + e.message);
    }
  }

  return send(res, 404, 'text/plain', 'Not found');
});

server.listen(PORT, () => {
  console.log(`GIB Server running on port ${PORT}`);
  console.log(`Password protection: ${ACCESS_PASSWORD !== 'changeme' ? 'ENABLED' : 'WARNING: using default password'}`);
});

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

async function runAgenticBrief(userPrompt) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const systemPrompt = `You are a senior intelligence analyst producing a daily executive brief for ${dateStr}.
Search the web to find TODAY'S actual breaking news, current geopolitical events, active CVEs from CISA KEV, and live market prices.
After gathering current intelligence via web search, return ONLY a valid JSON object. No markdown, no code fences. Start your response with { and end with }.`;

  const messages = [{ role: 'user', content: userPrompt }];
  let requestBody = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: messages
  };

  for (let turn = 0; turn < 15; turn++) {
    const result = await callAnthropic(requestBody);
    if (result.status !== 200) {
      const errBody = JSON.parse(result.body);
      throw new Error(errBody.error ? errBody.error.message : 'API error ' + result.status);
    }
    const response = JSON.parse(result.body);
    messages.push({ role: 'assistant', content: response.content });

    const hasToolUse = response.content.some(b => b.type === 'tool_use');

    if (!hasToolUse) {
      const textBlocks = response.content.filter(b => b.type === 'text');
      const rawText = textBlocks.map(b => b.text).join('');
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON found in response');
      return JSON.parse(rawText.slice(start, end + 1));
    }

    // Build tool results from web search responses
    const toolResults = response.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: JSON.stringify(b.content || b.input || '')
      }));

    messages.push({ role: 'user', content: toolResults });
    requestBody.messages = messages;
  }

  throw new Error('Max turns reached');
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
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
      const body = await parseBody(req);
      const data = await runAgenticBrief(body.prompt || '');
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
  console.log('Password: ' + (ACCESS_PASSWORD !== 'changeme' ? 'CUSTOM' : 'DEFAULT - please change'));
});

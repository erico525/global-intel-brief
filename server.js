const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PASSWORD = process.env.ACCESS_PASSWORD || 'changeme';
const sessions = new Map();

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

function anthropic(body) {
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
      timeout: 45000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({status: res.statusCode, body: d}));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function getBrief() {
  const date = new Date().toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'});
  
  const r = await anthropic({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3500,
    system: 'You are an intelligence analyst. Return only valid JSON with no markdown or code fences.',
    messages: [{role:'user', content:`Global Intelligence Brief for ${date}. Return this JSON with real current intelligence (keep each text field to 1-2 sentences):

{"date":"${date}","risks":{"overall":"HIGH","geo":"HIGH","cyber":"HIGH","market":"MEDIUM","supply":"MEDIUM"},"situation":{"breaking":"...","headline":"...","diplomacy":"...","cyber":"..."},"geo":{"score":"HIGH","stories":[{"n":1,"title":"...","body":"..."},{"n":2,"title":"...","body":"..."},{"n":3,"title":"...","body":"..."},{"n":4,"title":"...","body":"..."},{"n":5,"title":"...","body":"..."}],"note_title":"...","note":"..."},"cyber":{"score":"HIGH","threats":[{"actor":"...","tactic":"...","target":"...","level":"HIGH"},{"actor":"...","tactic":"...","target":"...","level":"CRITICAL"},{"actor":"...","tactic":"...","target":"...","level":"HIGH"},{"actor":"...","tactic":"...","target":"...","level":"HIGH"},{"actor":"...","tactic":"...","target":"...","level":"MEDIUM"}],"themes":["...","...","..."],"note_title":"...","note":"..."},"markets":{"score":"MEDIUM","assets":[{"name":"...","price":"...","context":"...","trend":"flat"},{"name":"...","price":"...","context":"...","trend":"up"},{"name":"...","price":"...","context":"...","trend":"down"},{"name":"...","price":"...","context":"...","trend":"up"},{"name":"...","price":"...","context":"...","trend":"flat"},{"name":"...","price":"...","context":"...","trend":"down"},{"name":"...","price":"...","context":"...","trend":"up"}],"signals":["...","...","..."],"note_title":"...","note":"..."},"watch":[{"item":"...","why":"...","priority":"HIGH"},{"item":"...","why":"...","priority":"CRITICAL"},{"item":"...","why":"...","priority":"HIGH"},{"item":"...","why":"...","priority":"MEDIUM"},{"item":"...","why":"...","priority":"WATCH"}],"sources":"Reuters, AP, Bloomberg, CISA, OSINT"}`}]
  });

  if (r.status !== 200) {
    const e = JSON.parse(r.body);
    throw new Error(e.error ? e.error.message : 'API error '+r.status);
  }

  const resp = JSON.parse(r.body);
  const raw = (resp.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('No JSON in response');
  return JSON.parse(raw.slice(s, e+1));
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    return res.end();
  }

  if (url === '/login' && req.method === 'POST') {
    const b = await parseBody(req);
    if (b.password === PASSWORD) {
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now());
      for (const [k,v] of sessions) if (Date.now()-v > 86400000) sessions.delete(k);
      res.setHeader('Set-Cookie', `gib2=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      return respond(res, 200, 'application/json', JSON.stringify({ok:true}));
    }
    return respond(res, 401, 'application/json', JSON.stringify({ok:false}));
  }

  if (url === '/authcheck') {
    return respond(res, 200, 'application/json', JSON.stringify({ok: authed(req)}));
  }

  if (url === '/brief' && req.method === 'POST') {
    if (!authed(req)) return respond(res, 401, 'application/json', JSON.stringify({error:'Unauthorized'}));
    try {
      const data = await getBrief();
      return respond(res, 200, 'application/json', JSON.stringify(data));
    } catch(e) {
      console.error('Brief error:', e.message);
      return respond(res, 500, 'application/json', JSON.stringify({error: e.message}));
    }
  }

  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      return respond(res, 200, 'text/html; charset=utf-8', html);
    } catch(e) {
      return respond(res, 500, 'text/plain', 'Error: '+e.message);
    }
  }

  respond(res, 404, 'text/plain', 'Not found');

}).listen(PORT, () => {
  console.log('GIB running on port '+PORT);
  console.log('API key:', API_KEY ? 'SET' : 'MISSING');
  console.log('Password:', PASSWORD !== 'changeme' ? 'CUSTOM' : 'DEFAULT - please change');
});

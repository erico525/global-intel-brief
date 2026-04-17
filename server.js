const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PASSWORD = process.env.ACCESS_PASSWORD || 'changeme';
const sessions = new Map();

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

// ── ANTHROPIC AGENTIC LOOP WITH WEB SEARCH ──
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
      timeout: 180000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic timeout')); });
    req.write(payload);
    req.end();
  });
}

async function runWithSearch(systemPrompt, userPrompt) {
  const messages = [{ role: 'user', content: userPrompt }];
  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  for (let turn = 0; turn < 20; turn++) {
    const result = await callAnthropic({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8000,
      system: systemPrompt,
      tools,
      messages
    });

    if (result.status !== 200) {
      const e = JSON.parse(result.body);
      throw new Error(e.error ? e.error.message : 'API error ' + result.status);
    }

    const resp = JSON.parse(result.body);
    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter(b => b.type === 'tool_use');

    if (toolUses.length === 0 || resp.stop_reason === 'end_turn') {
      // Extract final JSON from text blocks
      const raw = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON in final response');
      return JSON.parse(raw.slice(start, end + 1));
    }

    // Feed tool results back
    const toolResults = toolUses.map(tu => ({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: tu.content ? JSON.stringify(tu.content) : '[]'
    }));
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Max search turns reached');
}

async function generateBrief() {
  if (generating) { console.log('Already generating, skipping.'); return; }
  generating = true;
  console.log('Starting brief generation at', new Date().toISOString());

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const system = `You are a senior intelligence analyst producing a daily Global Intelligence Brief for ${date}.
Your job is to search the web for REAL, CURRENT, SPECIFIC intelligence — then synthesize it into a structured JSON brief.
Use multiple targeted web searches to gather today's actual news. Search for specific events, named actors, real numbers.
Do NOT produce generic or placeholder content. Every item must be grounded in something you actually found via search.
After all searches are complete, return ONLY valid JSON — no markdown, no code fences, start with { end with }.`;

  const prompt = `Search the web systematically for today's intelligence across these domains, then produce the brief.

REQUIRED SEARCHES — run ALL of these:
1. "breaking news today ${date}" — top global story right now
2. "Iran Strait of Hormuz war update today" — current status of US-Iran conflict
3. "Ukraine Russia war update today" — latest military developments  
4. "geopolitical news today ${date}" — other major global flashpoints
5. "CISA KEV vulnerabilities today" OR "cybersecurity threat news today" — active cyber threats
6. "S&P 500 Nasdaq stock market today" — equity market levels and moves
7. "oil price gold price today" — commodity prices
8. "diplomatic news UN Security Council today" — diplomatic developments
9. "China Taiwan South China Sea news today" — Asia-Pacific tensions
10. "Africa Middle East conflict news today" — regional developments

After completing all searches, synthesize findings into this exact JSON schema:

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
    "breaking": "Real breaking story with named actors, specific event, and consequence. 2 sentences.",
    "headline": "Real lead geopolitical story with named countries/leaders. 2 sentences.",
    "diplomacy": "Real diplomatic development with named parties and specific context. 2 sentences.",
    "cyber": "Real active cyber threat with named actor/CVE and targeted sector. 2 sentences."
  },
  "geo": {
    "score": "CRITICAL|HIGH|MEDIUM|WATCH",
    "stories": [
      {"n": 1, "title": "Real specific story title", "body": "Named actors, locations, dates, specific developments. 2-3 sentences.", "confidence": "HIGH|MODERATE|LOW"},
      {"n": 2, "title": "Real specific story title", "body": "Named actors, locations, dates, specific developments. 2-3 sentences.", "confidence": "HIGH|MODERATE|LOW"},
      {"n": 3, "title": "Real specific story title", "body": "Named actors, locations, dates, specific developments. 2-3 sentences.", "confidence": "HIGH|MODERATE|LOW"},
      {"n": 4, "title": "Real specific story title", "body": "Named actors, locations, dates, specific developments. 2-3 sentences.", "confidence": "HIGH|MODERATE|LOW"},
      {"n": 5, "title": "Real specific story title", "body": "Named actors, locations, dates, specific developments. 2-3 sentences.", "confidence": "HIGH|MODERATE|LOW"}
    ],
    "note_title": "Analytical assessment title",
    "note": "Strategic synthesis of above stories. 2-3 sentences."
  },
  "cyber": {
    "score": "CRITICAL|HIGH|MEDIUM|WATCH",
    "threats": [
      {"actor": "Real named threat actor or CVE-ID", "tactic": "Specific real attack method", "target": "Real targeted sector or organization", "level": "CRITICAL", "confidence": "HIGH"},
      {"actor": "Real named threat actor or CVE-ID", "tactic": "Specific real attack method", "target": "Real targeted sector or organization", "level": "HIGH", "confidence": "HIGH"},
      {"actor": "Real named threat actor or CVE-ID", "tactic": "Specific real attack method", "target": "Real targeted sector or organization", "level": "HIGH", "confidence": "MODERATE"},
      {"actor": "Real named threat actor or CVE-ID", "tactic": "Specific real attack method", "target": "Real targeted sector or organization", "level": "HIGH", "confidence": "MODERATE"},
      {"actor": "Real named threat actor or CVE-ID", "tactic": "Specific real attack method", "target": "Real targeted sector or organization", "level": "MEDIUM", "confidence": "HIGH"}
    ],
    "themes": [
      "Specific analytical theme grounded in above threats.",
      "Specific analytical theme grounded in above threats.",
      "Specific analytical theme grounded in above threats."
    ],
    "note_title": "Cyber threat assessment title",
    "note": "Strategic assessment of today's cyber landscape. 2-3 sentences."
  },
  "markets": {
    "score": "CRITICAL|HIGH|MEDIUM|WATCH",
    "assets": [
      {"name": "S&P 500", "price": "actual level from search", "context": "what drove today's move", "trend": "up|down|flat", "confidence": "HIGH"},
      {"name": "Nasdaq", "price": "actual level from search", "context": "what drove today's move", "trend": "up|down|flat", "confidence": "HIGH"},
      {"name": "Brent Crude", "price": "actual $/bbl from search", "context": "what drove today's move", "trend": "up|down|flat", "confidence": "HIGH"},
      {"name": "Gold", "price": "actual $/oz from search", "context": "what drove today's move", "trend": "up|down|flat", "confidence": "HIGH"},
      {"name": "VIX", "price": "actual level from search", "context": "what this signals", "trend": "up|down|flat", "confidence": "HIGH"},
      {"name": "Bitcoin", "price": "actual price from search", "context": "market positioning context", "trend": "up|down|flat", "confidence": "HIGH"},
      {"name": "DXY (USD Index)", "price": "actual level from search", "context": "dollar strength context", "trend": "up|down|flat", "confidence": "HIGH"}
    ],
    "signals": [
      "Real specific market signal with numbers from today's search.",
      "Real specific market signal with numbers from today's search.",
      "Real specific market signal with numbers from today's search."
    ],
    "note_title": "Market assessment title",
    "note": "What today's market moves actually mean. 2-3 sentences."
  },
  "watch": [
    {"item": "Specific named watch item with parties/dates", "why": "Specific stakes and timeline from search findings. 2 sentences.", "priority": "CRITICAL", "confidence": "HIGH"},
    {"item": "Specific named watch item with parties/dates", "why": "Specific stakes and timeline from search findings. 2 sentences.", "priority": "CRITICAL", "confidence": "HIGH"},
    {"item": "Specific named watch item with parties/dates", "why": "Specific stakes and timeline from search findings. 2 sentences.", "priority": "HIGH", "confidence": "MODERATE"},
    {"item": "Specific named watch item with parties/dates", "why": "Specific stakes and timeline from search findings. 2 sentences.", "priority": "HIGH", "confidence": "MODERATE"},
    {"item": "Specific named watch item with parties/dates", "why": "Specific stakes and timeline from search findings. 2 sentences.", "priority": "WATCH", "confidence": "HIGH"}
  ],
  "sources": "List the actual sources found in your searches"
}`;

  try {
    const data = await runWithSearch(system, prompt);
    cachedBrief = data;
    cacheTime = new Date();
    console.log('Brief generated successfully at', cacheTime.toISOString());
  } catch(e) {
    console.error('Generation failed:', e.message);
  } finally {
    generating = false;
  }
}

// Generate on startup, refresh every 4 hours
generateBrief();
setInterval(generateBrief, 4 * 60 * 60 * 1000);

// ── HTTP SERVER ──
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
    if (cachedBrief) {
      return respond(res, 200, 'application/json', JSON.stringify({
        ...cachedBrief,
        _cached_at: cacheTime ? cacheTime.toISOString() : null,
        _generating: generating
      }));
    }
    return respond(res, 503, 'application/json', JSON.stringify({
      error: generating
        ? 'Brief is being generated with live web search — this takes 60-90 seconds. Please refresh in a moment.'
        : 'Brief not available. Please try again shortly.'
    }));
  }

  if (url === '/regenerate' && req.method === 'POST') {
    if (!authed(req)) return respond(res, 401, 'application/json', JSON.stringify({error:'Unauthorized'}));
    if (generating) return respond(res, 200, 'application/json', JSON.stringify({ok:true, message:'Already generating.'}));
    generateBrief();
    return respond(res, 200, 'application/json', JSON.stringify({ok:true, message:'Regenerating brief with live web search. Ready in ~90 seconds.'}));
  }

  if (url === '/status') {
    return respond(res, 200, 'application/json', JSON.stringify({
      cached: !!cachedBrief,
      generating,
      cached_at: cacheTime ? cacheTime.toISOString() : null
    }));
  }

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
  console.log('GIB Server v3 running on port ' + PORT);
  console.log('API key:', API_KEY ? 'SET' : 'MISSING');
  console.log('Password:', PASSWORD !== 'changeme' ? 'CUSTOM' : 'DEFAULT - change this');
});

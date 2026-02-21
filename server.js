const WebSocket = require('ws');
const http = require('http');

// ── og: metadata fetch ─────────────────────────────────────────────────────
async function fetchOG(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VOIDBot/1.0; +https://gartic.io)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const html = await res.text();

    const get = (prop) => {
      const m =
        html.match(new RegExp('<meta[^>]+property=["\']og:' + prop + '["\'][^>]+content=["\']([^"\']*)["\']', 'i')) ||
        html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+property=["\']og:' + prop + '["\']', 'i')) ||
        html.match(new RegExp('<meta[^>]+name=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'));
      return m ? m[1].trim() : null;
    };

    const title       = get('title') || html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim() || null;
    const description = get('description');
    const image       = get('image');
    const siteName    = get('site_name');

    if (!title && !image) return null;
    return { title, description, image, siteName, url };
  } catch (_) {
    return null;
  }
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /og?url=https://...
  if (req.method === 'GET' && req.url?.startsWith('/og')) {
    const qs   = new URL(req.url, 'http://localhost').searchParams;
    const target = qs.get('url');
    if (!target) { res.writeHead(400, {'Content-Type':'application/json'}); res.end('{"error":"missing url"}'); return; }
    const data = await fetchOG(target);
    res.writeHead(data ? 200 : 404, {'Content-Type':'application/json'});
    res.end(JSON.stringify(data || { error: 'no og data' }));
    return;
  }

  res.writeHead(200);
  res.end('VOID Server online');
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const rooms = {};

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'join') {
        currentRoom = msg.room;
        if (!rooms[currentRoom]) rooms[currentRoom] = new Set();
        rooms[currentRoom].add(ws);
        console.log(`[JOIN] sala=${currentRoom} total=${rooms[currentRoom].size}`);
        return;
      }

      if (msg.type === 'image' && currentRoom && rooms[currentRoom]) {
        const payload = JSON.stringify({
          type: 'image',
          from: msg.from,
          img:  msg.img,
          ts:   Date.now(),
        });
        for (const client of rooms[currentRoom]) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        }
      }
    } catch (e) {
      console.error('Msg inválida:', e.message);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].delete(ws);
      if (rooms[currentRoom].size === 0) delete rooms[currentRoom];
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`VOID Server rodando na porta ${PORT}`));

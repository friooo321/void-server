const WebSocket = require('ws');
const http = require('http');

// ── og: metadata fetch ─────────────────────────────────────────────────────
async function fetchOG(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const reader = res.body.getReader();
    let html = '';
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      total += value.length;
      if (total > 100_000) { reader.cancel(); break; }
    }
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url?.startsWith('/og')) {
    const qs     = new URL(req.url, 'http://localhost').searchParams;
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

const MAX_CODE_SIZE = 5_000_000; // 5MB
const MAX_IMG_SIZE  = 100 * 1024 * 1024; // 100MB

const VALID_EMOJIS = new Set(['👍','❤️','😂','😮','🔥','👏','😢','💀']);

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (data) => {
    if (data.length > MAX_IMG_SIZE) {
      console.warn('[BLOCKED] Payload muito grande:', data.length);
      return;
    }

    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'join') {
        currentRoom = msg.room;
        if (!rooms[currentRoom]) rooms[currentRoom] = new Set();
        rooms[currentRoom].add(ws);
        console.log(`[JOIN] sala=${currentRoom} total=${rooms[currentRoom].size}`);
        return;
      }

      if (!currentRoom || !rooms[currentRoom]) return;

      let payload = null;

      // Imagem / vídeo / áudio / gif
      if (msg.type === 'image') {
        payload = JSON.stringify({
          type: 'image',
          from: msg.from,
          img:  msg.img,
          mime: msg.mime || 'image',
          msgId: msg.msgId || null,
          ts:   Date.now(),
        });
      }

      // Typing indicator
      if (msg.type === 'typing') {
        payload = JSON.stringify({
          type:     'typing',
          from:     msg.from,
          isTyping: !!msg.isTyping,
          ts:       Date.now(),
        });
      }

      // Bloco de código
      if (msg.type === 'code') {
        console.log(`[CODE] de ${msg.from}, tamanho=${msg.text?.length}, sala=${currentRoom}`);
        if (typeof msg.text !== 'string' || msg.text.length > MAX_CODE_SIZE) {
          console.warn('[BLOCKED] Código muito grande ou inválido');
          return;
        }
        payload = JSON.stringify({
          type:     'code',
          from:     msg.from,
          text:     msg.text,
          filename: msg.filename || null,
          msgId:    msg.msgId || null,
          ts:       Date.now(),
        });
      }

      // ── REACTION ──────────────────────────────────────────────────────────
      if (msg.type === 'reaction') {
        if (typeof msg.msgId !== 'string' || msg.msgId.length > 32) return;
        if (!VALID_EMOJIS.has(msg.emoji)) return; // só emojis permitidos
        const delta = msg.delta === -1 ? -1 : 1;  // só +1 ou -1
        payload = JSON.stringify({
          type:  'reaction',
          from:  msg.from,
          msgId: msg.msgId,
          emoji: msg.emoji,
          delta: delta,
          ts:    Date.now(),
        });
      }

      if (payload) {
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

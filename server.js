const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('VOID Server online');
});

const wss = new WebSocket.Server({ server });

// rooms[salaId] = Set de clientes
const rooms = {};

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // Entrar numa sala
      if (msg.type === 'join') {
        currentRoom = msg.room;
        if (!rooms[currentRoom]) rooms[currentRoom] = new Set();
        rooms[currentRoom].add(ws);
        console.log(`[JOIN] sala=${currentRoom} total=${rooms[currentRoom].size}`);
        return;
      }

      // Mandar imagem pra sala
      if (msg.type === 'image' && currentRoom && rooms[currentRoom]) {
        const payload = JSON.stringify({
          type: 'image',
          from: msg.from,
          img:  msg.img,   // base64
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

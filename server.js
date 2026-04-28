const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Railway requires the server to handle HTTP upgrades explicitly
const server = http.createServer((req, res) => {
  // Health check endpoint Railway uses
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('IRONBLOOD OK');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ noServer: true });

// Handle upgrade manually — required for Railway's proxy
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

const rooms = {};

function genCode() {
  let code;
  do { code = Math.random().toString(36).substring(2,7).toUpperCase(); }
  while (rooms[code]); // ensure unique
  return code;
}

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(obj));
  } catch(e) { /* ignore */ }
}

function broadcast(roomCode, obj, excludeWs) {
  const room = rooms[roomCode];
  if (!room) return;
  for (const p of room.players) {
    if (p !== excludeWs) safeSend(p, obj);
  }
}

function cleanRoom(code) {
  if (!code || !rooms[code]) return;
  // Notify remaining players
  const room = rooms[code];
  for (const p of room.players) {
    safeSend(p, { type: 'opponent_left' });
    p.room = null;
  }
  delete rooms[code];
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.slot = -1;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('error', (e) => {
    console.error('[ws error]', e.message);
  });

  ws.on('close', () => {
    if (ws.room) cleanRoom(ws.room);
  });

  ws.on('message', (raw) => {
    // Parse
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // Guard: room must exist for in-game messages
    const roomCode = ws.room;
    const room = roomCode ? rooms[roomCode] : null;

    try {
      switch (msg.type) {

        case 'create': {
          if (ws.room) return; // already in a room
          const code = genCode();
          rooms[code] = { players: [ws] };
          ws.room = code;
          ws.slot = 0;
          safeSend(ws, { type: 'created', code, slot: 0 });
          console.log(`[room] created ${code}`);
          break;
        }

        case 'join': {
          if (ws.room) return;
          const code = (typeof msg.code === 'string' ? msg.code : '').toUpperCase().trim();
          if (!code) { safeSend(ws, { type: 'error', msg: 'No code provided' }); return; }
          const r = rooms[code];
          if (!r) { safeSend(ws, { type: 'error', msg: 'Room not found' }); return; }
          if (r.players.length >= 2) { safeSend(ws, { type: 'error', msg: 'Room full' }); return; }
          r.players.push(ws);
          ws.room = code;
          ws.slot = 1;
          safeSend(ws, { type: 'joined', code, slot: 1 });
          // Tell both to start
          safeSend(r.players[0], { type: 'start' });
          safeSend(r.players[1], { type: 'start' });
          console.log(`[room] ${code} started`);
          break;
        }

        case 'state': {
          if (!room || !msg.data) return;
          broadcast(roomCode, { type: 'state', data: msg.data }, ws);
          break;
        }

        case 'event': {
          if (!room || !msg.data) return;
          broadcast(roomCode, { type: 'event', data: msg.data }, ws);
          break;
        }

        case 'weapon': {
          if (!room) return;
          broadcast(roomCode, { type: 'weapon', key: msg.key }, ws);
          break;
        }

        case 'rematch':
        case 'reselect': {
          if (!room) return;
          broadcast(roomCode, { type: msg.type }, ws);
          break;
        }
      }
    } catch(e) {
      console.error(`[handler error] type=${msg.type}:`, e.message);
    }
  });
});

// Heartbeat — terminate dead connections every 30s
const heartbeat = setInterval(() => {
  let dead = 0;
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); dead++; return; }
    ws.isAlive = false;
    try { ws.ping(); } catch(e) {}
  });
  if (dead) console.log(`[heartbeat] terminated ${dead} dead connections`);
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// Never crash on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`IRONBLOOD server listening on port ${PORT}`);
});

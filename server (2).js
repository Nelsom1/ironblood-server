const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('IRONBLOOD server running');
});

const wss = new WebSocket.Server({ server });

// rooms[code] = { players: [ws, ws], state: {} }
const rooms = {};

function genCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, excludeWs) {
  for (const p of room.players) {
    if (p !== excludeWs) send(p, obj);
  }
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.slot = null; // 0 = host, 1 = guest

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create': {
        const code = genCode();
        rooms[code] = { players: [ws], host: ws, started: false };
        ws.room = code;
        ws.slot = 0;
        send(ws, { type: 'created', code, slot: 0 });
        break;
      }

      case 'join': {
        const code = msg.code?.toUpperCase();
        const room = rooms[code];
        if (!room) { send(ws, { type: 'error', msg: 'Room not found' }); return; }
        if (room.players.length >= 2) { send(ws, { type: 'error', msg: 'Room full' }); return; }
        room.players.push(ws);
        ws.room = code;
        ws.slot = 1;
        send(ws, { type: 'joined', code, slot: 1 });
        // Tell host the guest joined and start the match
        room.started = true;
        send(room.players[0], { type: 'start', opponentSlot: 1 });
        send(room.players[1], { type: 'start', opponentSlot: 0 });
        break;
      }

      // Game state update — relay to opponent
      case 'state': {
        const room = rooms[ws.room];
        if (!room) return;
        broadcast(room, { type: 'state', slot: ws.slot, data: msg.data }, ws);
        break;
      }

      // Discrete events (attacks, hits, etc.) — relay to opponent
      case 'event': {
        const room = rooms[ws.room];
        if (!room) return;
        broadcast(room, { type: 'event', slot: ws.slot, data: msg.data }, ws);
        break;
      }

      case 'weapon': {
        const room = rooms[ws.room];
        if (!room) return;
        broadcast(room, { type: 'weapon', slot: ws.slot, key: msg.key }, ws);
        break;
      }

      // Relay rematch/reselect signals directly to opponent
      case 'rematch':
      case 'reselect': {
        const room = rooms[ws.room];
        if (!room) return;
        broadcast(room, { type: msg.type }, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];
    broadcast(room, { type: 'opponent_left' }, ws);
    delete rooms[ws.room];
  });
});

server.listen(PORT, () => console.log(`IRONBLOOD server on port ${PORT}`));

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('IRONBLOOD OK');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

const rooms = {};
let _nextId = 1;

function genId() { return _nextId++; }
function genCode() {
  let code;
  do { code = Math.random().toString(36).substring(2,7).toUpperCase(); }
  while (rooms[code]);
  return code;
}
function safeSend(ws, obj) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch(e) {}
}
function broadcastRoom(room, obj, excludeWs) {
  for (const p of room.players) if (p !== excludeWs) safeSend(p, obj);
}
function broadcastFight(fight, obj, excludeWs) {
  for (const p of [fight.p0, fight.p1]) if (p !== excludeWs) safeSend(p, obj);
}
function getFight(room, ws) {
  return room.fights.find(f => f.p0 === ws || f.p1 === ws);
}
function lobbyList(room) {
  return room.players.map(p => ({
    id: p.playerId, name: p.playerName,
    weapon: p.weapon, ready: !!p.lobbyReady,
  }));
}
function tallyArena(room) {
  const votes = {};
  for (const p of room.players) {
    const v = p.arenaVote || 'castle';
    votes[v] = (votes[v] || 0) + 1;
  }
  let best = [], bestCount = 0;
  for (const [arena, count] of Object.entries(votes)) {
    if (count > bestCount) { best = [arena]; bestCount = count; }
    else if (count === bestCount) best.push(arena);
  }
  return best[Math.floor(Math.random() * best.length)];
}
function launchFights(room) {
  room.state = 'fighting';
  room.fights = [];
  const shuffled = [...room.players].sort(() => Math.random() - 0.5);
  const arena = tallyArena(room);
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    const p0 = shuffled[i], p1 = shuffled[i+1];
    const fight = { p0, p1, arena };
    room.fights.push(fight);
    p0.currentFight = fight; p1.currentFight = fight;
    safeSend(p0, { type:'fight_start', slot:0, arena, opponentId:p1.playerId,
      opponentName:p1.playerName, opponentWeapon:p1.weapon, opponentSkins:p1.skins||{} });
    safeSend(p1, { type:'fight_start', slot:1, arena, opponentId:p0.playerId,
      opponentName:p0.playerName, opponentWeapon:p0.weapon, opponentSkins:p0.skins||{} });
  }
  if (shuffled.length % 2 === 1) {
    const odd = shuffled[shuffled.length-1];
    safeSend(odd, { type:'waiting', msg:'Odd number of players — waiting for next round.' });
  }
  console.log(`[room ${room.code}] launched, arena:${arena}, fights:${room.fights.length}`);
}
function removePlayer(ws) {
  const code = ws.room;
  if (!code || !rooms[code]) return;
  const room = rooms[code];
  const fight = getFight(room, ws);
  if (fight) {
    const partner = fight.p0 === ws ? fight.p1 : fight.p0;
    safeSend(partner, { type:'opponent_left' });
    partner.currentFight = null;
    room.fights = room.fights.filter(f => f !== fight);
  }
  room.players = room.players.filter(p => p !== ws);
  ws.room = null;
  if (room.players.length === 0) { delete rooms[code]; return; }
  if (room.host === ws) {
    room.host = room.players[0];
    room.host.isHost = true;
    safeSend(room.host, { type:'promoted_host' });
  }
  broadcastRoom(room, { type:'lobby_update', players:lobbyList(room), host:room.host.playerId });
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.isAlive = true;
  ws.playerId = genId();
  ws.playerName = 'Player ' + ws.playerId;
  ws.weapon = null;
  ws.skins = {};
  ws.arenaVote = 'castle';
  ws.lobbyReady = false;
  ws.currentFight = null;
  ws.isHost = false;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (e) => { console.error('[ws error]', e.message); });
  ws.on('close', () => { removePlayer(ws); });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const code = ws.room;
    const room = code ? rooms[code] : null;
    try {
      switch (msg.type) {

        case 'create': {
          if (ws.room) return;
          const nc = genCode();
          rooms[nc] = { code:nc, host:ws, players:[ws], state:'lobby', fights:[] };
          ws.room = nc; ws.isHost = true;
          if (msg.name) ws.playerName = String(msg.name).slice(0,20);
          safeSend(ws, { type:'created', code:nc, playerId:ws.playerId, isHost:true });
          break;
        }

        case 'join': {
          if (ws.room) return;
          const jc = (typeof msg.code==='string'?msg.code:'').toUpperCase().trim();
          if (!jc) { safeSend(ws,{type:'error',msg:'No code'}); return; }
          const r = rooms[jc];
          if (!r) { safeSend(ws,{type:'error',msg:'Room not found'}); return; }
          if (r.state!=='lobby') { safeSend(ws,{type:'error',msg:'Fight in progress'}); return; }
          if (r.players.length>=8) { safeSend(ws,{type:'error',msg:'Room full'}); return; }
          if (msg.name) ws.playerName = String(msg.name).slice(0,20);
          r.players.push(ws); ws.room = jc;
          safeSend(ws, { type:'joined', code:jc, playerId:ws.playerId,
            hostId:r.host.playerId, players:lobbyList(r) });
          broadcastRoom(r, { type:'lobby_update', players:lobbyList(r), host:r.host.playerId }, ws);
          break;
        }

        case 'lobby_settings': {
          if (!room) return;
          if (msg.name) ws.playerName = String(msg.name).slice(0,20);
          if (msg.weapon) ws.weapon = msg.weapon;
          if (msg.skins) ws.skins = msg.skins;
          if (msg.arena) ws.arenaVote = msg.arena;
          if (msg.ready !== undefined) ws.lobbyReady = !!msg.ready;
          broadcastRoom(room, { type:'lobby_update', players:lobbyList(room), host:room.host.playerId });
          break;
        }

        case 'launch': {
          if (!room || room.host!==ws) return;
          if (room.players.length<2) { safeSend(ws,{type:'error',msg:'Need 2+ players'}); return; }
          launchFights(room); break;
        }

        case 'return_lobby': {
          if (!room) return;
          ws.lobbyReady = false; ws.currentFight = null;
          broadcastRoom(room, { type:'lobby_update', players:lobbyList(room), host:room.host.playerId });
          safeSend(ws, { type:'lobby_returned', players:lobbyList(room), host:room.host.playerId });
          const allBack = room.players.every(p=>!p.currentFight);
          if (allBack) { room.state='lobby'; room.fights=[];
            broadcastRoom(room, { type:'all_returned', players:lobbyList(room), host:room.host.playerId }); }
          break;
        }

        case 'state': {
          if (!room||!msg.data) return;
          const f=getFight(room,ws); if(f) broadcastFight(f,{type:'state',data:msg.data},ws); break;
        }
        case 'event': {
          if (!room||!msg.data) return;
          const f=getFight(room,ws); if(f) broadcastFight(f,{type:'event',data:msg.data},ws); break;
        }
        case 'weapon': {
          if (!room) return;
          if (msg.key) ws.weapon=msg.key;
          if (msg.skins) ws.skins=msg.skins;
          const f=getFight(room,ws);
          if(f) broadcastFight(f,{type:'weapon',key:msg.key,arena:msg.arena,arenaVote:msg.arenaVote,skins:msg.skins},ws);
          break;
        }
        case 'proj':
        case 'rematch':
        case 'reselect': {
          if (!room) return;
          const f=getFight(room,ws); if(f) broadcastFight(f,msg,ws); break;
        }
        case 'chat': {
          if (!room||typeof msg.text!=='string') return;
          const text=msg.text.slice(0,120);
          broadcastRoom(room,{type:'chat',from:ws.playerName,text});
          break;
        }
      }
    } catch(e) { console.error(`[handler] type=${msg.type}:`,e.message); }
  });

  safeSend(ws, { type:'hello', playerId:ws.playerId });
});

const heartbeat = setInterval(() => {
  let dead=0;
  wss.clients.forEach(ws=>{
    if(!ws.isAlive){ws.terminate();dead++;return;}
    ws.isAlive=false; try{ws.ping();}catch(e){}
  });
  if(dead) console.log(`[heartbeat] terminated ${dead}`);
},30000);

wss.on('close', ()=>clearInterval(heartbeat));
process.on('uncaughtException',(err)=>console.error('[uncaught]',err.message));
process.on('unhandledRejection',(r)=>console.error('[unhandled]',r));
server.listen(PORT,'0.0.0.0',()=>console.log(`IRONBLOOD server :${PORT}`));

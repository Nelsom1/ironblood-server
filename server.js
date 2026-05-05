const WebSocket = require('ws');
const http = require('http');
const PORT = process.env.PORT || 8080;

const server = http.createServer((req,res)=>{
  if(req.url==='/health'||req.url==='/'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('IRONBLOOD OK');return;}
  res.writeHead(404);res.end();
});
const wss = new WebSocket.Server({noServer:true});
server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req)));

const rooms = {};
let _nid = 1;
const genId = ()=>_nid++;
function genCode(){let c;do{c=Math.random().toString(36).substring(2,7).toUpperCase();}while(rooms[c]);return c;}
function safe(ws,obj){try{if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}catch(e){}}

function broadcastRoom(room,obj,excludeWs){
  for(const p of room.players) if(p!==excludeWs) safe(p,obj);
}
function broadcastFight(room,obj,excludeWs){
  // Send to all alive players in the current fight
  for(const p of room.fightPlayers||[]) if(p!==excludeWs&&p.alive!==false) safe(p,obj);
}

function lobbyList(room){
  return room.players.map(p=>({id:p.pid,name:p.pname,weapon:p.weapon,ready:!!p.ready,elo:p.elo||800,mp_wins:p.mp_wins||0,mp_losses:p.mp_losses||0}));
}
function tallyArena(room){
  const v={};
  for(const p of room.players){const a=p.arenaVote||'castle';v[a]=(v[a]||0)+1;}
  let best=[],bc=0;
  for(const[a,c]of Object.entries(v)){if(c>bc){best=[a];bc=c;}else if(c===bc)best.push(a);}
  return best[Math.floor(Math.random()*best.length)];
}

function launchFight(room){
  room.state='fighting';
  const arena=tallyArena(room);
  room.arena=arena;
  room.fightPlayers=[...room.players];
  room.fightPlayers.forEach(p=>{p.alive=true;p.inFight=true;});
  // Tell each player about all OTHER players
  for(const p of room.fightPlayers){
    const opponents=room.fightPlayers
      .filter(o=>o!==p)
      .map(o=>({id:o.pid,name:o.pname,weapon:o.weapon||'sword',skins:o.skins||{}}));
    safe(p,{type:'fight_start',arena,opponents,myId:p.pid});
  }
  console.log(`[room ${room.code}] FFA started, arena:${arena}, players:${room.fightPlayers.length}`);
}

function removePlayer(ws){
  const code=ws.room;
  if(!code||!rooms[code])return;
  const room=rooms[code];
  // Notify fight partners
  if(ws.inFight){
    ws.alive=false; ws.inFight=false;
    broadcastFight(room,{type:'player_died',id:ws.pid,killed:false},ws);
    // Check if fight is over
    checkFightEnd(room);
  }
  room.players=room.players.filter(p=>p!==ws);
  if(room.fightPlayers) room.fightPlayers=room.fightPlayers.filter(p=>p!==ws);
  ws.room=null;
  if(room.players.length===0){delete rooms[code];return;}
  if(room.host===ws){
    room.host=room.players[0];
    room.host.isHost=true;
    safe(room.host,{type:'promoted_host'});
  }
  broadcastRoom(room,{type:'lobby_update',players:lobbyList(room),host:room.host.pid});
}

function checkFightEnd(room){
  if(!room.fightPlayers)return;
  const alive=room.fightPlayers.filter(p=>p.alive&&p.inFight);
  if(alive.length<=1){
    const winner=alive[0]||null;
    for(const p of room.fightPlayers){
      safe(p,{type:'fight_end',winnerId:winner?winner.pid:null,winnerName:winner?winner.pname:'Nobody'});
      p.inFight=false;
    }
    room.state='lobby';
    room.fightPlayers=[];
    // Notify whole room lobby is back
    broadcastRoom(room,{type:'lobby_update',players:lobbyList(room),host:room.host.pid});
    console.log(`[room ${room.code}] fight ended, winner:${winner?winner.pname:'none'}`);
  }
}

wss.on('connection',ws=>{
  ws.room=null; ws.isAlive=true;
  ws.pid=genId(); ws.pname='Player'+ws.pid;
  ws.weapon=null; ws.skins={}; ws.arenaVote='castle';
  ws.ready=false; ws.inFight=false; ws.alive=false; ws.isHost=false;

  ws.on('pong',()=>{ws.isAlive=true;});
  ws.on('error',e=>console.error('[ws]',e.message));
  ws.on('close',()=>removePlayer(ws));

  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw.toString());}catch{return;}
    if(!msg||typeof msg.type!=='string')return;
    const code=ws.room, room=code?rooms[code]:null;
    try{switch(msg.type){

      case 'create':{
        if(ws.room)return;
        const nc=genCode();
        rooms[nc]={code:nc,host:ws,players:[ws],state:'lobby',fightPlayers:[],arena:null};
        ws.room=nc; ws.isHost=true;
        if(msg.name)ws.pname=String(msg.name).slice(0,20);
        safe(ws,{type:'created',code:nc,playerId:ws.pid,isHost:true});
        break;
      }

      case 'join':{
        if(ws.room)return;
        const jc=(typeof msg.code==='string'?msg.code:'').toUpperCase().trim();
        if(!jc){safe(ws,{type:'error',msg:'No code'});return;}
        const r=rooms[jc];
        if(!r){safe(ws,{type:'error',msg:'Room not found'});return;}
        if(r.state!=='lobby'){safe(ws,{type:'error',msg:'Fight in progress'});return;}
        if(r.players.length>=8){safe(ws,{type:'error',msg:'Room full'});return;}
        if(msg.name)ws.pname=String(msg.name).slice(0,20);
        r.players.push(ws); ws.room=jc;
        safe(ws,{type:'joined',code:jc,playerId:ws.pid,hostId:r.host.pid,players:lobbyList(r)});
        broadcastRoom(r,{type:'lobby_update',players:lobbyList(r),host:r.host.pid},ws);
        break;
      }

      case 'lobby_settings':{
        if(!room)return;
        if(msg.name)ws.pname=String(msg.name).slice(0,20);
        if(msg.weapon)ws.weapon=msg.weapon;
        if(msg.skins)ws.skins=msg.skins;
        if(msg.arena)ws.arenaVote=msg.arena;
        if(msg.ready!==undefined)ws.ready=!!msg.ready;
        if(msg.elo)ws.elo=msg.elo;
        if(msg.mp_wins!==undefined)ws.mp_wins=msg.mp_wins;
        if(msg.mp_losses!==undefined)ws.mp_losses=msg.mp_losses;
        broadcastRoom(room,{type:'lobby_update',players:lobbyList(room),host:room.host.pid});
        break;
      }

      case 'launch':{
        if(!room||room.host!==ws)return;
        if(room.players.length<2){safe(ws,{type:'error',msg:'Need 2+ players'});return;}
        launchFight(room);break;
      }

      case 'state':{
        // Broadcast this player's state to all other fight players, tagged with sender id
        if(!room||!msg.data||!ws.inFight)return;
        broadcastFight(room,{type:'state',from:ws.pid,data:msg.data},ws);
        break;
      }

      case 'event':{
        if(!room||!msg.data)return;
        // Route to target if specified, else broadcast to fight
        if(msg.target){
          const tp=room.fightPlayers&&room.fightPlayers.find(p=>p.pid===msg.target);
          if(tp)safe(tp,{type:'event',from:ws.pid,data:msg.data});
        } else {
          broadcastFight(room,{type:'event',from:ws.pid,data:msg.data},ws);
        }
        break;
      }

      case 'died':{
        if(!room||!ws.inFight)return;
        ws.alive=false; ws.inFight=false;
        broadcastFight(room,{type:'player_died',id:ws.pid,name:ws.pname},ws);
        checkFightEnd(room);
        break;
      }

      case 'return_lobby':{
        if(!room)return;
        ws.ready=false; ws.inFight=false; ws.alive=false;
        broadcastRoom(room,{type:'lobby_update',players:lobbyList(room),host:room.host.pid});
        safe(ws,{type:'lobby_returned',players:lobbyList(room),host:room.host.pid});
        break;
      }

      case 'weapon':{
        if(!room)return;
        if(msg.key)ws.weapon=msg.key;
        if(msg.skins)ws.skins=msg.skins;
        broadcastFight(room,{type:'weapon',from:ws.pid,key:msg.key,skins:msg.skins},ws);
        break;
      }

      case 'proj':{
        if(!room)return;
        broadcastFight(room,Object.assign({},msg,{from:ws.pid}),ws);
        break;
      }

      case 'chat':{
        if(!room||typeof msg.text!=='string')return;
        const text=msg.text.slice(0,120);
        broadcastRoom(room,{type:'chat',from:ws.pname,text});
        break;
      }
    }}catch(e){console.error('[handler]',msg.type,e.message);}
  });
  safe(ws,{type:'hello',playerId:ws.pid});
});

const hb=setInterval(()=>{
  let d=0;
  wss.clients.forEach(ws=>{if(!ws.isAlive){ws.terminate();d++;return;}ws.isAlive=false;try{ws.ping();}catch(e){}});
  if(d)console.log('[hb] terminated',d);
},30000);
wss.on('close',()=>clearInterval(hb));
process.on('uncaughtException',e=>console.error('[unc]',e.message));
process.on('unhandledRejection',r=>console.error('[unr]',r));
server.listen(PORT,'0.0.0.0',()=>console.log('IRONBLOOD :'+PORT));

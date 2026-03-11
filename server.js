#!/usr/bin/env node
// Chess multiplayer server — pure Node.js, zero dependencies
// Uses raw HTTP upgrade + manual WebSocket (RFC 6455) handshake

const http = require('http');
const net  = require('net');
const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ─── WS helpers ────────────────────────────────────────────────
function wsAccept(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function wsFrame(data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsParse(buf) {
  if (buf.length < 2) return null;
  const fin    = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }

  if (buf.length < offset + (masked ? 4 : 0) + payloadLen) return null;

  let payload;
  if (masked) {
    const mask = buf.slice(offset, offset + 4); offset += 4;
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    payload = buf.slice(offset, offset + payloadLen);
  }

  return { opcode, payload, total: offset + payloadLen };
}

// ─── Game rooms ────────────────────────────────────────────────
const rooms = {};  // roomId -> { white, black, board... }

function makeRoom(id) {
  return {
    id, white: null, black: null,
    spectators: [],
    started: false,
  };
}

function getOrCreateRoom(id) {
  if (!rooms[id]) rooms[id] = makeRoom(id);
  return rooms[id];
}

function roomInfo(room) {
  return {
    type: 'room_info',
    roomId: room.id,
    whiteConnected: !!room.white,
    blackConnected: !!room.black,
  };
}

function send(socket, msg) {
  if (socket && !socket.destroyed) {
    try { socket.write(wsFrame(msg)); } catch(e) {}
  }
}

function broadcast(room, msg, except) {
  [room.white, room.black, ...room.spectators].forEach(s => {
    if (s && s !== except) send(s, msg);
  });
}

// ─── Client handling ───────────────────────────────────────────
function handleClient(socket, req) {
  let room = null;
  let role = null; // 'white' | 'black' | 'spectator'
  let buf = Buffer.alloc(0);

  const url = new URL(req.url, `http://localhost`);
  const roomId = (url.searchParams.get('room') || 'default').slice(0, 20).replace(/[^a-z0-9-]/gi, '');

  room = getOrCreateRoom(roomId);

  // Assign role
  if (!room.white) {
    role = 'white'; room.white = socket;
  } else if (!room.black) {
    role = 'black'; room.black = socket;
  } else {
    role = 'spectator'; room.spectators.push(socket);
  }

  console.log(`[${roomId}] ${role} connected`);

  // Welcome message
  send(socket, { type: 'welcome', role, roomId });
  send(socket, roomInfo(room));
  // Notify others
  broadcast(room, roomInfo(room), socket);

  if (room.white && room.black && !room.started) {
    room.started = true;
    broadcast(room, { type: 'start' });
  }

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const frame = wsParse(buf);
      if (!frame) break;
      buf = buf.slice(frame.total);

      if (frame.opcode === 0x8) { socket.destroy(); break; } // close
      if (frame.opcode === 0x9) { send(socket, Buffer.from([0x8A, 0x00])); continue; } // pong
      if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue;

      let msg;
      try { msg = JSON.parse(frame.payload.toString()); } catch { continue; }

      handleMessage(room, role, socket, msg);
    }
  });

  socket.on('close', () => cleanup());
  socket.on('error', () => cleanup());

  function cleanup() {
    if (!room) return;
    console.log(`[${roomId}] ${role} disconnected`);
    if (role === 'white') room.white = null;
    else if (role === 'black') room.black = null;
    else room.spectators = room.spectators.filter(s => s !== socket);
    room.started = false;
    broadcast(room, { type: 'opponent_left', role });
    broadcast(room, roomInfo(room));
    // Clean empty rooms
    if (!room.white && !room.black && room.spectators.length === 0) {
      delete rooms[roomId];
    }
    room = null;
  }
}

function handleMessage(room, role, socket, msg) {
  switch (msg.type) {
    case 'move':
      // Validate sender is the right player
      if (msg.turn === 'w' && role !== 'white') return;
      if (msg.turn === 'b' && role !== 'black') return;
      // Relay move to everyone else
      broadcast(room, { type: 'move', move: msg.move, turn: msg.turn }, socket);
      break;

    case 'resign':
      broadcast(room, { type: 'resign', role }, socket);
      break;

    case 'draw_offer':
      broadcast(room, { type: 'draw_offer', role }, socket);
      break;

    case 'draw_accept':
      broadcast(room, { type: 'draw_accept' });
      break;

    case 'draw_decline':
      broadcast(room, { type: 'draw_decline' }, socket);
      break;

    case 'chat':
      if (typeof msg.text === 'string') {
        broadcast(room, { type: 'chat', role, text: msg.text.slice(0, 200) });
      }
      break;

    case 'ping':
      send(socket, { type: 'pong' });
      break;
  }
}

// ─── HTTP server (serves client HTML + WS upgrade) ─────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    const file = path.join(__dirname, 'client.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
    '\r\n'
  );

  socket.setTimeout(0);
  socket.setNoDelay(true);
  handleClient(socket, req);
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log(`\n♟  Chess server running!\n`);
  console.log(`   Local:    http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`   Network:  http://${ip}:${PORT}`));
  console.log(`\n   Share the Network URL with players on your WiFi.\n`);
});

#!/usr/bin/env node
/**
 * STARSHIP SABOTAGE — Dedicated Multiplayer WebSocket & HTTP Server (Zero Dependencies)
 *
 * Usage:
 *   node server.js
 *   (Optional: PORT=8080 node server.js)
 *
 * Features:
 * - Serves index.html over HTTP so players can open http://localhost:8080 (or LAN IP / cloud URL)
 * - Implements native RFC 6455 WebSockets using Node's built-in `http` and `crypto` modules (no `npm install` needed)
 * - 6-character Among Us-style Room Codes (CREATE_ROOM, JOIN_ROOM, LEAVE_ROOM)
 * - Server-validated role & action checks (prevents non-impostors from killing/sabotaging or spoofing other player IDs)
 * - Automatic Host Migration if the original room creator disconnects
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const INDEX_PATH = path.join(__dirname, 'index.html');

// Active rooms: code -> { code, hostSlotId, state, clients: Map<slotId, Client>, matchRoles: Map<slotId, { isImpostor, alive, lastKillTime }> }
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return 'STAR' + Math.floor(10 + Math.random() * 89);
}

function sanitizeName(raw) {
  const cleaned = String(raw || '').replace(/[^\w\s\-]/g, '').trim().slice(0, 12);
  return cleaned || 'Astronaut';
}

// ============================================================================
// 1. NATIVE RFC 6455 WEBSOCKET FRAME ENCODER & DECODER
// ============================================================================
function encodeWsFrame(payloadData, opcode = 0x01) {
  const payload = Buffer.isBuffer(payloadData)
    ? payloadData
    : Buffer.from(String(payloadData), 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function sendJson(client, obj) {
  if (!client || client.closed || !client.socket.writable) return;
  try {
    const frame = encodeWsFrame(JSON.stringify(obj), 0x01);
    client.socket.write(frame);
  } catch (_) {
    // Ignore write errors on closing sockets
  }
}

function broadcastRoom(room, obj, excludeSlotId = null) {
  const rawFrame = encodeWsFrame(JSON.stringify(obj), 0x01);
  for (const [slotId, member] of room.clients.entries()) {
    if (slotId !== excludeSlotId && !member.closed && member.socket.writable) {
      try {
        member.socket.write(rawFrame);
      } catch (_) {}
    }
  }
}

// ============================================================================
// 2. ROOM & ANTI-CHEAT MANAGEMENT
// ============================================================================
function getRoomRosterPayload(room) {
  const members = [];
  for (const [slotId, c] of room.clients.entries()) {
    members.push({
      slotId,
      name: c.name,
      colorIdx: c.colorIdx,
      isHost: slotId === room.hostSlotId
    });
  }
  members.sort((a, b) => a.slotId - b.slotId);
  return {
    type: 'ROOM_ROSTER',
    roomCode: room.code,
    hostSlotId: room.hostSlotId,
    members
  };
}

function pickAvailableColor(room, preferredIdx) {
  const used = new Set();
  for (const c of room.clients.values()) {
    used.add(c.colorIdx);
  }
  const pref = Number.isInteger(preferredIdx) ? Math.max(0, Math.min(7, preferredIdx)) : 0;
  if (!used.has(pref)) return pref;
  for (let i = 0; i < 8; i++) {
    if (!used.has(i)) return i;
  }
  return pref;
}

function removeClientFromRoom(client) {
  const code = client.roomCode;
  if (!code) return;
  client.roomCode = null;

  const room = rooms.get(code);
  if (!room) return;

  room.clients.delete(client.slotId);

  if (room.clients.size === 0) {
    rooms.delete(code);
    return;
  }

  // Automatic Host Migration if the host disconnected
  if (room.hostSlotId === client.slotId) {
    const remainingSlots = [...room.clients.keys()].sort((a, b) => a - b);
    room.hostSlotId = remainingSlots[0];
  }

  broadcastRoom(room, {
    type: 'PLAYER_LEFT',
    slotId: client.slotId,
    name: client.name,
    newHostSlotId: room.hostSlotId
  });
  broadcastRoom(room, getRoomRosterPayload(room));
}

function handleClientMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'PING': {
      sendJson(client, { type: 'PONG' });
      break;
    }

    case 'CREATE_ROOM': {
      removeClientFromRoom(client);
      const code = generateRoomCode();
      client.name = sanitizeName(msg.name);
      client.colorIdx = Math.max(0, Math.min(7, parseInt(msg.colorIdx, 10) || 0));
      client.slotId = 0;
      client.roomCode = code;

      const room = {
        code,
        hostSlotId: 0,
        state: 'LOBBY',
        clients: new Map([[0, client]]),
        matchRoles: new Map()
      };
      rooms.set(code, room);

      sendJson(client, {
        type: 'ROOM_JOINED',
        roomCode: code,
        slotId: 0,
        hostSlotId: 0,
        colorIdx: client.colorIdx
      });
      broadcastRoom(room, getRoomRosterPayload(room));
      break;
    }

    case 'JOIN_ROOM': {
      const code = String(msg.roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        sendJson(client, { type: 'ROOM_ERROR', message: `Room "${code}" not found.` });
        return;
      }
      if (room.state === 'PLAYING') {
        sendJson(client, { type: 'ROOM_ERROR', message: `Room "${code}" is currently in a match.` });
        return;
      }
      if (room.clients.size >= 8) {
        sendJson(client, { type: 'ROOM_ERROR', message: `Room "${code}" is full (8/8 players).` });
        return;
      }

      removeClientFromRoom(client);

      let assignedSlot = 0;
      while (room.clients.has(assignedSlot)) assignedSlot++;

      client.slotId = assignedSlot;
      client.name = sanitizeName(msg.name);
      client.colorIdx = pickAvailableColor(room, parseInt(msg.colorIdx, 10));
      client.roomCode = code;
      room.clients.set(assignedSlot, client);

      sendJson(client, {
        type: 'ROOM_JOINED',
        roomCode: code,
        slotId: assignedSlot,
        hostSlotId: room.hostSlotId,
        colorIdx: client.colorIdx
      });
      broadcastRoom(room, getRoomRosterPayload(room));
      break;
    }

    case 'UPDATE_PROFILE': {
      const room = rooms.get(client.roomCode);
      if (!room) return;
      if (msg.name) client.name = sanitizeName(msg.name);
      if (msg.colorIdx !== undefined) {
        const reqCol = parseInt(msg.colorIdx, 10);
        const takenByOther = [...room.clients.values()].some(
          c => c.slotId !== client.slotId && c.colorIdx === reqCol
        );
        if (!takenByOther && reqCol >= 0 && reqCol < 8) {
          client.colorIdx = reqCol;
        }
      }
      broadcastRoom(room, getRoomRosterPayload(room));
      break;
    }

    case 'LEAVE_ROOM': {
      removeClientFromRoom(client);
      sendJson(client, { type: 'ROOM_LEFT' });
      break;
    }

    case 'MATCH_START': {
      const room = rooms.get(client.roomCode);
      if (!room || client.slotId !== room.hostSlotId) return;
      room.state = 'PLAYING';
      room.matchRoles.clear();

      if (Array.isArray(msg.players)) {
        for (const p of msg.players) {
          room.matchRoles.set(Number(p.id), {
            isImpostor: Boolean(p.isImpostor),
            alive: Boolean(p.alive),
            lastKillTime: 0
          });
        }
      }
      broadcastRoom(room, msg, client.slotId);
      break;
    }

    case 'RETURN_LOBBY': {
      const room = rooms.get(client.roomCode);
      if (!room || client.slotId !== room.hostSlotId) return;
      room.state = 'LOBBY';
      room.matchRoles.clear();
      broadcastRoom(room, { type: 'RETURN_LOBBY' }, client.slotId);
      break;
    }

    case 'STATE_SYNC': {
      const room = rooms.get(client.roomCode);
      if (!room || client.slotId !== room.hostSlotId) return;
      broadcastRoom(room, msg, client.slotId);
      break;
    }

    case 'CLIENT_MOVE': {
      const room = rooms.get(client.roomCode);
      if (!room) return;
      // Anti-Cheat: Force slotId to match authenticated socket client.slotId
      msg.playerId = client.slotId;
      broadcastRoom(room, msg, client.slotId);
      break;
    }

    case 'RPC_EVENT': {
      const room = rooms.get(client.roomCode);
      if (!room) return;

      // Server-side validation of sensitive actions
      const roleInfo = room.matchRoles.get(client.slotId);
      const isHost = client.slotId === room.hostSlotId;

      if (msg.action === 'KILL') {
        // Allow either the Impostor player themselves or the Host simulating an AI Impostor bot
        if (!isHost && (!roleInfo || !roleInfo.isImpostor || !roleInfo.alive)) {
          return;
        }
        const victimState = room.matchRoles.get(Number(msg.victimId));
        if (victimState) victimState.alive = false;
      }

      if (msg.action === 'SABOTAGE' || msg.action === 'DOOR_LOCK') {
        if (!isHost && (!roleInfo || !roleInfo.isImpostor)) {
          return;
        }
      }

      msg.senderSlotId = client.slotId;
      broadcastRoom(room, msg, client.slotId);
      break;
    }
  }
}

// ============================================================================
// 3. HTTP SERVER & WEBSOCKET UPGRADE HANDLER
// ============================================================================
const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      status: 'ok',
      activeRooms: rooms.size,
      uptimeSec: Math.round(process.uptime())
    }));
    return;
  }

  if (urlPath === '/' || urlPath === '/index.html') {
    fs.readFile(INDEX_PATH, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptHash = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-Websocket-Accept: ${acceptHash}`,
    '\r\n'
  ].join('\r\n');

  socket.write(responseHeaders);
  socket.setNoDelay(true);

  const client = {
    socket,
    closed: false,
    roomCode: null,
    slotId: 0,
    name: 'Astronaut',
    colorIdx: 0
  };

  let recvBuffer = Buffer.alloc(0);
  let fragmentOpcode = null;
  let fragmentChunks = [];
  let fragmentBytes = 0;
  const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

  const dispatchTextPayload = (buf) => {
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      handleClientMessage(client, parsed);
    } catch (_) {}
  };

  socket.on('data', (chunk) => {
    recvBuffer = Buffer.concat([recvBuffer, chunk]);

    while (recvBuffer.length >= 2) {
      const firstByte = recvBuffer[0];
      const secondByte = recvBuffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (recvBuffer.length < 4) return;
        payloadLen = recvBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (recvBuffer.length < 10) return;
        payloadLen = Number(recvBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLen > MAX_WS_MESSAGE_BYTES) {
        client.closed = true;
        removeClientFromRoom(client);
        socket.destroy();
        return;
      }

      const maskLen = isMasked ? 4 : 0;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (recvBuffer.length < totalFrameLen) return;

      let payload = recvBuffer.subarray(offset + maskLen, totalFrameLen);
      if (isMasked) {
        const mask = recvBuffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
        payload = unmasked;
      }

      recvBuffer = recvBuffer.subarray(totalFrameLen);

      if (opcode === 0x08) {
        // Close frame
        client.closed = true;
        removeClientFromRoom(client);
        if (socket.writable) socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
        return;
      } else if (opcode === 0x09) {
        // Ping -> Pong (RFC 6455 allows control frames between fragments)
        if (socket.writable) socket.write(encodeWsFrame(payload, 0x0a));
      } else if (opcode === 0x0a) {
        // Pong (no-op)
      } else if (opcode === 0x01 || opcode === 0x02) {
        if (fin) {
          fragmentOpcode = null;
          fragmentChunks = [];
          fragmentBytes = 0;
          if (opcode === 0x01) dispatchTextPayload(payload);
        } else {
          fragmentOpcode = opcode;
          fragmentChunks = [Buffer.from(payload)];
          fragmentBytes = payload.length;
        }
      } else if (opcode === 0x00 && fragmentOpcode !== null) {
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_WS_MESSAGE_BYTES) {
          client.closed = true;
          removeClientFromRoom(client);
          socket.destroy();
          return;
        }
        fragmentChunks.push(Buffer.from(payload));
        if (fin) {
          const fullPayload = Buffer.concat(fragmentChunks);
          const origOpcode = fragmentOpcode;
          fragmentOpcode = null;
          fragmentChunks = [];
          fragmentBytes = 0;
          if (origOpcode === 0x01) dispatchTextPayload(fullPayload);
        }
      }
    }
  });

  const cleanup = () => {
    if (!client.closed) {
      client.closed = true;
      removeClientFromRoom(client);
    }
  };

  socket.on('end', () => {
    cleanup();
    if (socket.writable) socket.end();
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

if (require.main === module) {
  server.listen(PORT, () => {
    const lanIp = getLocalLanIp();
    console.log('==============================================================');
    console.log(' 🚀 STARSHIP SABOTAGE — Online Multiplayer Server Running!');
    console.log(` 🌐 Local URL:   http://localhost:${PORT}`);
    console.log(` 📡 Network URL: http://${lanIp}:${PORT}`);
    console.log('==============================================================');
  });
}

module.exports = { server, rooms };


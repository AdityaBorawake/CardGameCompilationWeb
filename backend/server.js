/**
 * server.js — Host-authoritative WebSocket relay + static file server
 * Fixes: seat assignment for clients, proper capacity propagation
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const port    = process.env.PORT ? Number(process.env.PORT) : 8080;
const host    = process.env.HOST || '0.0.0.0';
const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MAX_CHAT_HISTORY  = 60;
const MAX_ROOM_CAPACITY = 5;
const MIN_ROOM_CAPACITY = 2;
const BOT_TIMEOUT_MS    = 12_000;

const MIME = {
  '.css':  'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico':  'image/x-icon',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

const rooms = new Map();

/* ── Helpers ── */
const roomKey = (gameId, roomId) => `${gameId}::${roomId}`;

function normSeat(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normCapacity(v, fallback = 3) {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(MIN_ROOM_CAPACITY, Math.min(MAX_ROOM_CAPACITY, n));
}

function sanitize(v, fallback = 'Player') {
  return String(v || fallback).trim().replace(/\s+/g, ' ').slice(0, 24) || fallback;
}

function makeMsg(partial) {
  return {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...partial
  };
}

function serializeOccupants(room) {
  return Array.from(room.playerSlots.values())
    .sort((a, b) => a.seat - b.seat)
    .map(s => ({
      connected: s.connected,
      isBot:     s.isBot,
      name:      s.name,
      playerId:  s.playerId,
      role:      s.role,
      seat:      s.seat,
    }));
}

/* ── Room factory ── */
function getOrCreateRoom(gameId, roomId, requestedCapacity) {
  const key = roomKey(gameId, roomId);
  if (!rooms.has(key)) {
    rooms.set(key, {
      capacity:     normCapacity(requestedCapacity, 3),
      chatHistory:  [],
      gameId,
      hostSocketId: null,
      occupants:    new Map(),   // socketId → slot ref
      playerSlots:  new Map(),   // seat     → slot
      roomId,
      roomKey:      key,
      snapshot:     null,
    });
  } else {
    // If host re-declares capacity, honour the larger value
    const room = rooms.get(key);
    if (requestedCapacity != null) {
      room.capacity = Math.max(room.capacity, normCapacity(requestedCapacity, room.capacity));
    }
  }
  return rooms.get(key);
}

/* ── Seat assignment ──
   BUG FIX: clients used to start scanning from seat 1, which meant they
   could never claim seat 0 (even when seat 0 was empty and they were the
   first guest).  Now:
   • hosts always get seat 0 if available, else next open seat
   • clients get their requested seat if open, else the LOWEST open seat
     (any seat including 0 if the host hasn't joined yet — rare edge case)
*/
function findOpenSeat(room, requested, role) {
  const taken = new Set(Array.from(room.playerSlots.keys()));

  if (role === 'host') {
    if (!taken.has(0)) return 0;
    for (let s = 0; s < room.capacity; s++) if (!taken.has(s)) return s;
    return null;
  }

  // Client: honour preference if open
  if (requested !== null && !taken.has(requested)) return requested;

  // Otherwise scan all seats (clients CAN sit at seat 0 if host never joined)
  for (let s = 0; s < room.capacity; s++) {
    if (!taken.has(s)) return s;
  }
  return null;
}

/* ── Broadcast helpers ── */
function emitPresence(room, io) {
  io.to(room.roomKey).emit('room-presence', { occupants: serializeOccupants(room) });
}

function pushSystem(room, io, text) {
  const msg = makeMsg({ kind: 'system', text });
  room.chatHistory.push(msg);
  room.chatHistory = room.chatHistory.slice(-MAX_CHAT_HISTORY);
  io.to(room.roomKey).emit('chat-message', msg);
}

/* ── Bot timer ── */
function scheduleBotPromotion(room, slot, io) {
  clearBotTimer(slot);
  slot.botTimer = setTimeout(() => {
    if (slot.connected || !rooms.has(room.roomKey)) return;
    slot.isBot = true;
    pushSystem(room, io, `${slot.name} was replaced by a bot.`);
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('activate-bot', { seat: slot.seat, name: slot.name });
    }
    emitPresence(room, io);
  }, BOT_TIMEOUT_MS);
}

function clearBotTimer(slot) {
  if (slot.botTimer) { clearTimeout(slot.botTimer); slot.botTimer = null; }
}

/* ── Host migration ── */
function migrateHost(room, io) {
  const candidates = Array.from(room.playerSlots.values())
    .filter(s => s.connected && s.role !== 'host')
    .sort((a, b) => a.seat - b.seat);

  if (!candidates.length) {
    io.to(room.roomKey).emit('room-closed', { message: 'All players left. Room closed.', reason: 'empty' });
    rooms.delete(room.roomKey);
    return;
  }

  Array.from(room.playerSlots.values()).forEach(s => { if (s.role === 'host') s.role = 'client'; });
  const newHost = candidates[0];
  const sock = io.sockets.sockets.get(newHost.socketId);
  if (!sock) return;

  newHost.role = 'host';
  room.hostSocketId = newHost.socketId;
  sock.emit('host-promoted', { message: 'The host left. You are now the host.', seat: newHost.seat, snapshot: room.snapshot });
  pushSystem(room, io, `${newHost.name} is now the host.`);
  emitPresence(room, io);
}

/* ── Leave helper ── */
function leaveRoom(socket, io) {
  const rKey = socket.data?.roomKey;
  if (!rKey) return;
  const room = rooms.get(rKey);
  socket.data.roomKey = null;
  if (!room) return;

  const slot = room.occupants.get(socket.id);
  room.occupants.delete(socket.id);
  socket.leave(rKey);
  if (!slot) return;

  slot.connected = false;
  slot.socketId  = null;

  io.to(rKey).emit('peer-left', { isBot: slot.isBot, name: slot.name, playerId: slot.playerId, seat: slot.seat });
  pushSystem(room, io, `${slot.name} disconnected.`);

  if (slot.role === 'host') {
    room.hostSocketId = null;
    scheduleBotPromotion(room, slot, io);
    emitPresence(room, io);
    setTimeout(() => { if (!room.hostSocketId && rooms.has(rKey)) migrateHost(room, io); }, 2000);
    return;
  }

  scheduleBotPromotion(room, slot, io);
  emitPresence(room, io);
}

/* ── Static file server ── */
const httpServer = createServer((req, res) => {
  const rawPath  = (req.url || '/').split('?')[0];
  const safePath = rawPath === '/' ? '/index.html' : normalize(rawPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(join(rootDir, safePath.replace(/^[/\\]/, '')));

  if (!filePath.startsWith(rootDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
});

/* ── Socket.IO ── */
const io = new Server(httpServer, { cors: { origin: '*' } });

io.on('connection', socket => {
  socket.data.userId  = `uid-${Math.random().toString(36).slice(2, 10)}`;
  socket.data.roomKey = null;

  /* join-room */
  socket.on('join-room', (payload = {}) => {
    leaveRoom(socket, io);

    const gameId   = String(payload.gameId  || '').trim();
    const roomId   = String(payload.roomId  || '').trim().toUpperCase();
    const role     = payload.role === 'host' ? 'host' : 'client';
    const playerId = sanitize(payload.playerId || socket.data.userId, socket.data.userId);
    const reqSeat  = normSeat(payload.preferredSeat ?? payload.seat);

    if (!gameId || !roomId) {
      socket.emit('join-error', { code: 'invalid-room', message: 'Room code is required.' });
      return;
    }

    // FIX: always use the capacity the HOST declared; clients cannot shrink it
    const room = getOrCreateRoom(gameId, roomId, role === 'host' ? payload.maxPlayers : null);
    const rKey = room.roomKey;

    // Block second host
    if (role === 'host' && room.hostSocketId && room.hostSocketId !== socket.id) {
      socket.emit('join-error', { code: 'host-exists', message: 'That room already has a host. Join as a guest.' });
      return;
    }

    // Try to reclaim slot by playerId (reconnect)
    let slot = Array.from(room.playerSlots.values()).find(s => s.playerId === playerId);
    let isReconnect = false;

    if (slot) {
      isReconnect = true;
      const revivedBot = slot.isBot;
      clearBotTimer(slot);
      slot.isBot     = false;
      slot.connected = true;
      slot.socketId  = socket.id;
      slot.name      = sanitize(payload.name, slot.name);
      if (slot.role === 'host') {
        if (!room.hostSocketId) room.hostSocketId = socket.id;
      } else if (role === 'host' && !room.hostSocketId) {
        slot.role = 'host'; room.hostSocketId = socket.id;
      }
      slot._revivedBot = revivedBot;
      room.occupants.set(socket.id, slot);
    } else {
      if (room.playerSlots.size >= room.capacity) {
        socket.emit('join-error', { code: 'room-full', message: 'This room is full.' });
        return;
      }
      const seat = findOpenSeat(room, reqSeat, role);
      if (seat === null) {
        socket.emit('join-error', { code: 'no-seat', message: `No open seat found in room ${roomId}. Capacity: ${room.capacity}, taken: ${room.playerSlots.size}.` });
        return;
      }
      slot = { botTimer: null, connected: true, isBot: false, name: sanitize(payload.name, role === 'host' ? 'Host' : `Player ${seat + 1}`), playerId, role, seat, socketId: socket.id };
      room.playerSlots.set(seat, slot);
      room.occupants.set(socket.id, slot);
      if (role === 'host') room.hostSocketId = socket.id;
    }

    socket.data.roomKey = rKey;
    socket.join(rKey);

    socket.emit('joined-room', {
      capacity: room.capacity, chatHistory: room.chatHistory, gameId,
      occupants: serializeOccupants(room), playerId: slot.playerId,
      role: slot.role, roomId, seat: slot.seat, snapshot: room.snapshot,
      userId: socket.data.userId,
    });

    socket.to(rKey).emit('peer-joined', { name: slot.name, playerId: slot.playerId, seat: slot.seat });
    pushSystem(room, io, isReconnect
      ? (slot._revivedBot ? `${slot.name} reconnected (took over from bot).` : `${slot.name} reconnected.`)
      : `${slot.name} joined.`
    );
    if (slot._revivedBot && room.hostSocketId) {
      io.to(room.hostSocketId).emit('deactivate-bot', { seat: slot.seat });
    }
    delete slot._revivedBot;
    emitPresence(room, io);
  });

  /* game-snapshot: HOST → server → clients */
  socket.on('game-snapshot', (payload = {}) => {
    const rKey = socket.data.roomKey; if (!rKey) return;
    const room = rooms.get(rKey);
    const occ  = room?.occupants.get(socket.id);
    if (!room || !occ || occ.role !== 'host') {
      socket.emit('authority-rejected', { reason: 'Only the host may push state.' }); return;
    }
    room.snapshot = payload.state ?? null;
    socket.to(rKey).emit('game-snapshot', { state: room.snapshot });
  });

  /* game-intent: CLIENT → server → host */
  socket.on('game-intent', (payload = {}) => {
    const rKey = socket.data.roomKey; if (!rKey) return;
    const room = rooms.get(rKey);
    const occ  = room?.occupants.get(socket.id);
    if (!room || !occ || occ.role === 'host') return;
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('game-intent', { intent: payload.intent ?? null, playerId: occ.playerId, seat: occ.seat });
    }
  });

  /* chat-message */
  socket.on('chat-message', (payload = {}) => {
    const rKey = socket.data.roomKey; if (!rKey) return;
    const room = rooms.get(rKey);
    const occ  = room?.occupants.get(socket.id);
    const text = String(payload.text || '').trim().slice(0, 240);
    if (!room || !occ || !text) return;
    const msg = makeMsg({ kind: 'user', name: occ.name, seat: occ.seat, text, userId: socket.data.userId, playerId: occ.playerId });
    room.chatHistory.push(msg);
    room.chatHistory = room.chatHistory.slice(-MAX_CHAT_HISTORY);
    io.to(rKey).emit('chat-message', msg);
  });

  socket.on('leave-room', () => leaveRoom(socket, io));
  socket.on('disconnect',  () => leaveRoom(socket, io));
});

httpServer.listen(port, host, () => {
  console.log(`[CGC] Server → http://${host}:${port}`);
});

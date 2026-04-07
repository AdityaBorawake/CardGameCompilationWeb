/**
 * server.js — Host-authoritative WebSocket backend
 *
 * Architecture:
 *   - Host is the ONLY authority for game logic
 *   - Server only relays messages, enforces host authority,
 *     handles reconnect, host migration, and bot fallback signals
 *   - Full state sync only (no partial updates)
 *   - Also serves static files from project root
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const port    = process.env.PORT ? Number(process.env.PORT) : 8080;
const host    = process.env.HOST || '0.0.0.0';
const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

/* ── Constants ── */
const MAX_CHAT_HISTORY      = 60;
const DEFAULT_ROOM_CAPACITY = 2;
const MAX_ROOM_CAPACITY     = 5;   // spec: 2-5 players
const BOT_TIMEOUT_MS        = 12_000; // promote to bot after 12s disconnect

/* ── MIME types for static serving ── */
const MIME = {
  '.css':  'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico':  'image/x-icon',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

/* ═══════════════════════════════════════════
   ROOM DATA MODEL
   ═══════════════════════════════════════════

   room {
     roomKey:       string          // "gameId::roomId"
     gameId:        string
     roomId:        string
     capacity:      number          // 2-5
     hostSocketId:  string | null
     snapshot:      object | null   // latest full game state
     chatHistory:   Message[]
     occupants:     Map<socketId, Occupant>
     playerSlots:   Map<seat, PlayerSlot>  // persistent across reconnects
   }

   PlayerSlot {
     seat:          number
     playerId:      string    // stable localStorage ID
     name:          string
     role:          'host' | 'client'
     connected:     boolean
     socketId:      string | null
     botTimer:      NodeJS.Timeout | null
     isBot:         boolean
   }
*/

const rooms = new Map();

/* ── Helpers ── */
const roomKey = (gameId, roomId) => `${gameId}::${roomId}`;

function normSeat(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function normCapacity(v) {
  const n = Number(v);
  if (!Number.isInteger(n)) return DEFAULT_ROOM_CAPACITY;
  return Math.max(2, Math.min(MAX_ROOM_CAPACITY, n));
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
function getOrCreateRoom(gameId, roomId, capacity) {
  const key = roomKey(gameId, roomId);
  if (!rooms.has(key)) {
    rooms.set(key, {
      capacity:    normCapacity(capacity),
      chatHistory: [],
      gameId,
      hostSocketId: null,
      occupants:   new Map(),     // socketId → PlayerSlot ref
      playerSlots: new Map(),     // seat     → PlayerSlot
      roomId,
      roomKey:     key,
      snapshot:    null,
    });
  }
  const room = rooms.get(key);
  room.capacity = Math.max(room.capacity, normCapacity(capacity));
  return room;
}

/* ── Seat assignment ── */
function findOpenSeat(room, requested, role) {
  const taken = new Set(Array.from(room.playerSlots.keys()));
  const open  = seat => !taken.has(seat) && seat >= 0 && seat < room.capacity;

  if (role === 'host' && open(0)) return 0;
  if (open(requested) && (role === 'host' || requested !== 0)) return requested;

  for (let s = role === 'host' ? 0 : 1; s < room.capacity; s++) {
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
    if (!slot.connected) {
      slot.isBot = true;
      const msg = makeMsg({ kind: 'system', text: `${slot.name} was replaced by a bot.` });
      room.chatHistory.push(msg);
      room.chatHistory = room.chatHistory.slice(-MAX_CHAT_HISTORY);
      io.to(room.roomKey).emit('chat-message', msg);
      // Signal the host to activate bot for this seat
      if (room.hostSocketId) {
        io.to(room.hostSocketId).emit('activate-bot', { seat: slot.seat, name: slot.name });
      }
      emitPresence(room, io);
    }
  }, BOT_TIMEOUT_MS);
}

function clearBotTimer(slot) {
  if (slot.botTimer) {
    clearTimeout(slot.botTimer);
    slot.botTimer = null;
  }
}

/* ── Host migration ── */
function migrateHost(room, io) {
  // Find oldest connected non-host client, promote them
  const candidates = Array.from(room.playerSlots.values())
    .filter(s => s.connected && s.role !== 'host')
    .sort((a, b) => a.seat - b.seat);

  if (!candidates.length) {
    // No one left — close room
    io.to(room.roomKey).emit('room-closed', {
      message: 'All players have left. Room closed.',
      reason:  'empty',
    });
    rooms.delete(room.roomKey);
    return;
  }

  const newHost = candidates[0];
  const newHostSocket = io.sockets.sockets.get(newHost.socketId);
  if (!newHostSocket) return;

  Array.from(room.playerSlots.values()).forEach(slot => {
    if (slot !== newHost && slot.role === 'host') slot.role = 'client';
  });
  newHost.role = 'host';
  room.hostSocketId = newHost.socketId;

  // Promote the new host
  newHostSocket.emit('host-promoted', {
    message: 'The previous host left. You are now the host.',
    seat:    newHost.seat,
    snapshot: room.snapshot,
  });

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

  io.to(rKey).emit('peer-left', {
    isBot:    slot.isBot,
    name:     slot.name,
    playerId: slot.playerId,
    seat:     slot.seat,
  });
  pushSystem(room, io, `${slot.name} disconnected.`);

  if (slot.role === 'host') {
    room.hostSocketId = null;
    scheduleBotPromotion(room, slot, io);
    emitPresence(room, io);
    // Give host 2s to reconnect before migrating
    setTimeout(() => {
      if (room.hostSocketId === null && rooms.has(rKey)) {
        migrateHost(room, io);
      }
    }, 2000);
    return;
  }

  // Schedule bot promotion for disconnected client
  scheduleBotPromotion(room, slot, io);
  emitPresence(room, io);
}

/* ─────────────────────────────────────────────
   STATIC FILE SERVER
───────────────────────────────────────────── */
const httpServer = createServer((req, res) => {
  const rawPath = (req.url || '/').split('?')[0];
  const safePath = rawPath === '/' ? '/index.html' : normalize(rawPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(join(rootDir, safePath.replace(/^[/\\]/, '')));

  if (!filePath.startsWith(rootDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
  });
  createReadStream(filePath).pipe(res);
});

/* ─────────────────────────────────────────────
   SOCKET.IO — HOST-AUTHORITATIVE RELAY
───────────────────────────────────────────── */
const io = new Server(httpServer, { cors: { origin: '*' } });

io.on('connection', socket => {
  socket.data.userId  = `uid-${Math.random().toString(36).slice(2, 10)}`;
  socket.data.roomKey = null;

  /* ── join-room ── */
  socket.on('join-room', (payload = {}) => {
    leaveRoom(socket, io);

    const gameId    = String(payload.gameId  || '').trim();
    const roomId    = String(payload.roomId  || '').trim().toUpperCase();
    const role      = payload.role === 'host' ? 'host' : 'client';
    const playerId  = sanitize(payload.playerId || socket.data.userId, socket.data.userId);
    const reqSeat   = normSeat(payload.preferredSeat ?? payload.seat);
    const reqCap    = payload.maxPlayers;

    if (!gameId || !roomId) {
      socket.emit('join-error', { code: 'invalid-room', message: 'Room code is required.' });
      return;
    }

    const room    = getOrCreateRoom(gameId, roomId, reqCap);
    const rKey    = room.roomKey;
    let slot      = Array.from(room.playerSlots.values()).find(s => s.playerId === playerId);
    const priorSlot = slot || null;

    // Block second host
    if (!slot && role === 'host' && room.hostSocketId && room.hostSocketId !== socket.id) {
      socket.emit('join-error', { code: 'host-exists', message: 'That room already has a host.' });
      return;
    }

    if (slot) {
      // Reconnecting — restore slot
      const previousSocketId = slot.socketId;
      const revivedFromBot = slot.isBot;
      clearBotTimer(slot);
      slot.isBot     = false;
      slot.connected = true;
      slot.socketId  = socket.id;
      slot.name      = sanitize(payload.name, slot.name || (slot.role === 'host' ? 'Host' : `Player ${slot.seat + 1}`));
      if (slot.role === 'host') {
        if (room.hostSocketId === null || room.hostSocketId === previousSocketId || room.hostSocketId === socket.id) {
          room.hostSocketId = socket.id;
        } else {
          slot.role = 'client';
        }
      } else if (role === 'host' && room.hostSocketId === null) {
        slot.role = 'host';
        room.hostSocketId = socket.id;
      }
      slot.wasBot = revivedFromBot;
      room.occupants.set(socket.id, slot);
    } else {
      // New player
      if (room.playerSlots.size >= room.capacity) {
        socket.emit('join-error', { code: 'room-full', message: 'This room is full.' });
        return;
      }
      const seat = findOpenSeat(room, reqSeat, role);
      if (seat === null) {
        socket.emit('join-error', { code: 'no-seat', message: 'No seat available.' });
        return;
      }
      slot = {
        botTimer:  null,
        connected: true,
        isBot:     false,
        name:      sanitize(payload.name, role === 'host' ? 'Host' : `Player ${seat + 1}`),
        playerId,
        role,
        seat,
        socketId:  socket.id,
      };
      room.playerSlots.set(seat, slot);
      room.occupants.set(socket.id, slot);
      if (role === 'host') room.hostSocketId = socket.id;
    }

    socket.data.roomKey = rKey;
    socket.join(rKey);

    // Ack to joining player
    socket.emit('joined-room', {
      capacity:    room.capacity,
      chatHistory: room.chatHistory,
      gameId,
      occupants:   serializeOccupants(room),
      playerId:    slot.playerId,
      roomId,
      role:        slot.role,
      seat:        slot.seat,
      snapshot:    room.snapshot,  // full state for reconnect
      userId:      socket.data.userId,
    });

    // Notify others
    socket.to(rKey).emit('peer-joined', {
      name:     slot.name,
      playerId: slot.playerId,
      seat:     slot.seat,
    });

    if (priorSlot) {
      pushSystem(
        room,
        io,
        slot.wasBot
          ? `${slot.name} reconnected and took over from the bot.`
          : `${slot.name} reconnected.`
      );
    } else {
      pushSystem(room, io, `${slot.name} joined the room.`);
    }

    // If player was a bot, tell host to remove bot
    if (slot.wasBot) {
      if (room.hostSocketId) {
        io.to(room.hostSocketId).emit('deactivate-bot', { seat: slot.seat });
      }
    }
    delete slot.wasBot;

    emitPresence(room, io);
  });

  /* ── game-snapshot: HOST → server → clients ── */
  socket.on('game-snapshot', (payload = {}) => {
    const rKey = socket.data.roomKey;
    if (!rKey) return;
    const room     = rooms.get(rKey);
    const occupant = room?.occupants.get(socket.id);

    // LOCK: reject non-host state pushes
    if (!room || !occupant || occupant.role !== 'host') {
      socket.emit('authority-rejected', { reason: 'Only the host may push game state.' });
      return;
    }

    room.snapshot = payload.state ?? null;
    // Relay FULL state to all clients
    socket.to(rKey).emit('game-snapshot', { state: room.snapshot });
  });

  /* ── game-intent: CLIENT → server → host ── */
  socket.on('game-intent', (payload = {}) => {
    const rKey = socket.data.roomKey;
    if (!rKey) return;
    const room     = rooms.get(rKey);
    const occupant = room?.occupants.get(socket.id);

    // Clients only — hosts process locally
    if (!room || !occupant || occupant.role === 'host') return;

    // Forward to host only
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('game-intent', {
        intent:   payload.intent ?? null,
        playerId: occupant.playerId,
        seat:     occupant.seat,
      });
    }
  });

  /* ── chat-message ── */
  socket.on('chat-message', (payload = {}) => {
    const rKey = socket.data.roomKey;
    if (!rKey) return;
    const room     = rooms.get(rKey);
    const occupant = room?.occupants.get(socket.id);
    const text     = String(payload.text || '').trim().slice(0, 240);
    if (!room || !occupant || !text) return;

    const msg = makeMsg({
      kind:     'user',
      name:     occupant.name,
      seat:     occupant.seat,
      text,
      userId:   socket.data.userId,
      playerId: occupant.playerId,
    });
    room.chatHistory.push(msg);
    room.chatHistory = room.chatHistory.slice(-MAX_CHAT_HISTORY);
    io.to(rKey).emit('chat-message', msg);
  });

  /* ── leave-room (explicit) ── */
  socket.on('leave-room', () => leaveRoom(socket, io));

  /* ── disconnect ── */
  socket.on('disconnect', () => leaveRoom(socket, io));
});

httpServer.listen(port, host, () => {
  console.log(`[CGC] Server running at http://${host}:${port}`);
});

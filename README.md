# Card Game Compilation — Multiplayer Architecture

## Folder structure

```
CardGameCompilationWeb/
├── backend/
│   ├── server.js          ← Host-authoritative Socket.IO relay + static file server
│   └── package.json
│
├── game-engine.js         ← Reusable host-authoritative GameEngine (all games share this)
├── room-bridge.js         ← Client networking (Socket.IO + BroadcastChannel fallback)
├── lobby-config.js        ← Reads sessionStorage config written by lobby.html
│
├── index.html             ← Landing page
├── lobby.html             ← Pre-game setup screen (mode, names, room code)
│
├── sevens.html            ← Sevens game page
├── sevens.js              ← Sevens logic + UI (uses GameEngine)
├── five-three-two.html
├── five-three-two.js
├── beggar-moneylender.html
├── beggar-moneylender.js
│
└── styles.css
```

---

## Architecture rules (strictly enforced)

| Rule | Where enforced |
|---|---|
| Host is the only game-logic authority | `game-engine.js` — only host calls `_handleIntent` |
| Clients never process logic | `game-engine.js` — clients only call `submitIntent` |
| Full state sync after every move | `game-engine._sync()` broadcasts complete state |
| Server rejects non-host state pushes | `server.js` — `game-snapshot` handler checks `role !== 'host'` |
| Host migration on disconnect | `server.js` — `migrateHost()`, client receives `host-promoted` |
| Reconnect restores slot by `playerId` | `server.js` — matches `playerId` from localStorage |
| Bot fallback after 12s disconnect | `server.js` — `scheduleBotPromotion()` emits `activate-bot` |
| Bots run only on host | `game-engine.js` — `_tickBots()` only called when `isHost` |
| 2–5 players per room | `server.js` — `MAX_ROOM_CAPACITY = 5` |
| 7♥ holder starts first | `sevens.js` — `sevensInit` finds 7♥ holder |

---

## Turn flow

```
Human clicks card
  → engine.submitIntent({ type: 'play', cardKey })
      if host  → engine._handleIntent(intent, seat)
                   → sevensApplyIntent(state, intent, seat) — pure, no DOM
                   → engine._sync() → render() + bridge.broadcastState(state)
      if client → bridge.sendIntent(intent)
                   → server relays to host socket only
                   → host receives 'game-intent' event
                   → engine._handleIntent(intent, seat)
                   → engine._sync() → render() + broadcastState
                   → all clients receive 'game-snapshot' with full state
```

---

## WebSocket message formats

### Client → Server

```json
{ "type": "join-room",
  "gameId": "sevens",
  "roomId": "SEVENS-1",
  "role": "host",
  "playerId": "stored-uuid-from-localStorage",
  "preferredSeat": 0,
  "maxPlayers": 3,
  "name": "Alice" }

{ "type": "game-intent",
  "intent": { "type": "play", "cardKey": "K-Hearts" } }

{ "type": "game-snapshot",
  "state": { ...fullGameState } }    ← host only; server rejects from clients

{ "type": "chat-message", "text": "Good move!" }
{ "type": "leave-room" }
```

### Server → Client

```json
{ "type": "joined-room",
  "seat": 0,
  "playerId": "...",
  "snapshot": { ...latestStateOrNull },
  "occupants": [...],
  "chatHistory": [...] }

{ "type": "game-snapshot",  "state": { ...fullGameState } }
{ "type": "game-intent",    "intent": {...}, "seat": 1 }     ← host only
{ "type": "peer-joined",    "name": "Bob", "seat": 1 }
{ "type": "peer-left",      "name": "Bob", "seat": 1 }
{ "type": "room-presence",  "occupants": [...] }
{ "type": "host-promoted",  "seat": 1, "snapshot": {...} }  ← host migration
{ "type": "activate-bot",   "seat": 2 }                     ← host: run bot for this seat
{ "type": "deactivate-bot", "seat": 2 }                     ← host: remove bot (player back)
{ "type": "room-closed",    "reason": "host-left" }
{ "type": "authority-rejected", "reason": "Only host may push state." }
{ "type": "join-error",     "code": "room-full" }
{ "type": "chat-message",   "kind": "user", "name": "Alice", "text": "hi" }
```

---

## GameEngine API

```js
const engine = new GameEngine({ gameId, bridge, onRender, mode, localSeat });

engine.setLogic({
  init(config)                → initialState,
  applyIntent(state, intent, seat) → { state, error? },
  getBotMove(state, seat)     → intent | null,
  isOver(state)               → boolean,
});

// Host
engine.start(config);                // deals, starts bots, syncs

// Client
engine.connectAsClient();            // just wires bridge; renders on snapshot

// Human action (works for both host and client)
engine.submitIntent({ type, ...});

// Called by server signals (via bridge)
engine.activateBot(seat);
engine.deactivateBot(seat);
engine.becomeHost(snapshot);         // host migration
```

---

## Reconnect flow

1. On first join, server assigns a `playerId` (UUID). Client stores it in `localStorage`.
2. On reconnect, client sends the same `playerId` in `join-room`.
3. Server finds the existing slot, cancels bot timer, marks `connected: true`.
4. Server sends full `snapshot` in the `joined-room` ack — client renders immediately.

---

## Running locally

```bash
cd backend
npm install
npm start
# Open http://localhost:8080
```

The server also serves all static files from the project root, so no separate web server needed.

---

## Skip button (Sevens)

The skip button appears in the player tray at all times but is **disabled and dimmed** until it is your turn AND you have zero legal card placements. When eligible it:

- Lights up with a **gold glow + pulse animation**
- Becomes clickable and sends `{ type: 'skip' }` to the host
- The host validates (rejects if you actually have legal cards) and advances the turn

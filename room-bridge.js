const REALTIME_SERVER_URL = (() => {
  if (window.CGC_SOCKET_URL) return window.CGC_SOCKET_URL;
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') return window.location.origin;
  return 'http://localhost:8080';
})();

const DEFAULT_MAX_PLAYERS = 5;
const ROOM_SESSION_KEY = 'cgc_active_room_session';
const ROOM_SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function normalizeSeat(value) {
  const seat = Number(value);
  return Number.isInteger(seat) ? seat : null;
}

function clampMaxPlayers(value) {
  const maxPlayers = Number(value);
  if (!Number.isInteger(maxPlayers)) return DEFAULT_MAX_PLAYERS;
  return Math.max(2, Math.min(5, maxPlayers));
}

function readSessionJson(key) {
  try {
    const raw = window.sessionStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSessionJson(key, value) {
  try {
    if (value === null) window.sessionStorage?.removeItem(key);
    else window.sessionStorage?.setItem(key, JSON.stringify(value));
  } catch {}
}

function makeStablePlayerId() {
  if (window.crypto?.randomUUID) return `pid-${window.crypto.randomUUID()}`;
  return `pid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildLocalMessage({ name, role, seat, text, userId }) {
  return {
    createdAt: new Date().toISOString(),
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'user',
    name: name || (role === 'host' ? 'Host' : 'Player'),
    seat,
    text,
    userId
  };
}

class GameChatUI {
  constructor() {
    this.toggleBtn = document.getElementById('toggle-chat');
    this.panel = document.getElementById('chat-panel');
    this.messagesEl = document.getElementById('chat-messages');
    this.form = document.getElementById('chat-form');
    this.input = document.getElementById('chat-input');
    this.badge = document.getElementById('chat-badge');
    this.roomLabel = document.getElementById('chat-room-label');
    this.presence = document.getElementById('chat-room-presence');
    this.bridge = null;
    this.localNameProvider = () => 'Player';
    this.isOpen = window.innerWidth > 980;
    this.unread = 0;
    this.messages = [];

    if (this.toggleBtn && this.panel) {
      this.toggleBtn.addEventListener('click', () => this.toggle());
      this.applyOpenState();
    }

    if (this.form && this.input) {
      this.form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = this.input.value.trim();
        if (!text || !this.bridge) return;
        this.bridge.sendChat(text, this.getLocalName());
        this.input.value = '';
      });
    }
  }

  setBridge(bridge) {
    this.bridge = bridge;
    if (this.input) this.input.disabled = !bridge;
    if (this.form) this.form.classList.toggle('disabled', !bridge);
  }

  setLocalNameProvider(provider) {
    this.localNameProvider = typeof provider === 'function' ? provider : () => 'Player';
  }

  getLocalName() {
    return String(this.localNameProvider() || 'Player').trim().slice(0, 24) || 'Player';
  }

  setContext({ mode, roomCode, playerName }) {
    this.setLocalNameProvider(() => playerName || 'Player');
    if (this.roomLabel) {
      this.roomLabel.textContent = mode === 'room-host' || mode === 'room-join'
        ? `Room ${roomCode || ''}`.trim()
        : 'Table chat';
    }
    if (this.input) {
      this.input.placeholder = mode === 'room-host' || mode === 'room-join'
        ? 'Type a message for the room'
        : 'Room chat appears here when you host or join';
      this.input.disabled = !(mode === 'room-host' || mode === 'room-join') || !this.bridge;
    }
  }

  setPresence(text) {
    if (this.presence) this.presence.textContent = text || '';
  }

  setEmptyState(text) {
    this.messages = [];
    if (this.messagesEl) this.messagesEl.innerHTML = `<div class="chat-empty">${text}</div>`;
    this.resetUnread();
  }

  replaceMessages(messages) {
    this.messages = Array.isArray(messages) ? [...messages] : [];
    this.renderMessages();
  }

  pushMessage(message) {
    this.messages.push(message);
    this.messages = this.messages.slice(-60);
    this.renderMessages();
    const isMine = this.bridge && message?.userId && message.userId === this.bridge.userId;
    if (!this.isOpen && !isMine && message?.kind !== 'system') this.setUnread(this.unread + 1);
  }

  renderMessages() {
    if (!this.messagesEl) return;
    if (!this.messages.length) {
      this.messagesEl.innerHTML = '<div class="chat-empty">No messages yet. Say hi when someone joins.</div>';
      return;
    }
    this.messagesEl.innerHTML = this.messages.map((message) => {
      if (message.kind === 'system') {
        return `<div class="chat-system">${escapeHtml(message.text || '')}</div>`;
      }
      const mine = this.bridge && message.userId === this.bridge.userId;
      const initials = escapeHtml((message.name || 'P').slice(0, 2).toUpperCase());
      const name = escapeHtml(message.name || 'Player');
      const text = escapeHtml(message.text || '');
      return `<article class="chat-message ${mine ? 'mine' : ''}">
        <div class="chat-avatar">${initials}</div>
        <div class="chat-bubble-wrap">
          <div class="chat-meta">${name}</div>
          <div class="chat-bubble">${text}</div>
        </div>
      </article>`;
    }).join('');
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  updatePresenceList(occupants) {
    if (!Array.isArray(occupants) || !occupants.length) {
      this.setPresence('Waiting for players...');
      return;
    }

    const names = [...occupants]
      .sort((left, right) => (left?.seat ?? 999) - (right?.seat ?? 999))
      .map((occupant) => occupant?.name || `Seat ${(occupant?.seat ?? 0) + 1}`);

    this.setPresence(names.join(' / '));
  }

  toggle(forceOpen) {
    this.isOpen = typeof forceOpen === 'boolean' ? forceOpen : !this.isOpen;
    this.applyOpenState();
    if (this.isOpen) this.resetUnread();
  }

  applyOpenState() {
    if (!this.panel || !this.toggleBtn) return;
    this.panel.classList.toggle('open', this.isOpen);
    this.toggleBtn.setAttribute('aria-expanded', String(this.isOpen));
  }

  setUnread(count) {
    this.unread = count;
    if (!this.badge) return;
    this.badge.textContent = String(Math.min(count, 9));
    this.badge.classList.toggle('hidden', count < 1);
  }

  resetUnread() {
    this.setUnread(0);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

window.initGameChat = function initGameChat() {
  if (!window.__cgcChatUI) window.__cgcChatUI = new GameChatUI();
  return window.__cgcChatUI;
};

class RoomBridge {
  constructor(gameId, onMessage, onStatus, options = {}) {
    this.gameId = gameId;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.options = options;
    this.maxPlayers = clampMaxPlayers(options.maxPlayers);
    this.allowBroadcastFallback = options.allowBroadcastFallback === true || window.location.protocol === 'file:';
    this.preferredSeat = normalizeSeat(options.preferredSeat);
    this.socket = null;
    this.channel = null;
    this.roomCode = null;
    this.role = null;
    this.seat = this.preferredSeat;
    this.playerId = null;
    this.userId = null;
    this.hadSocketConnection = false;
    this.chat = window.__cgcChatUI || null;
    if (this.chat) this.chat.setBridge(this);
  }

  readStoredRoomSession() {
    const session = readSessionJson(ROOM_SESSION_KEY);
    if (!session || session.game !== this.gameId) return null;
    if ((Date.now() - Number(session.savedAt || 0)) > ROOM_SESSION_TTL_MS) {
      writeSessionJson(ROOM_SESSION_KEY, null);
      return null;
    }
    return session;
  }

  persistRoomSession(extra = {}) {
    if (!this.roomCode || !this.role) return;
    writeSessionJson(ROOM_SESSION_KEY, {
      game: this.gameId,
      mode: this.role === 'host' ? 'room-host' : 'room-join',
      playerId: this.playerId,
      playerName: this.getJoinName(),
      preferredSeat: this.preferredSeat,
      roomCode: this.roomCode,
      savedAt: Date.now(),
      ...extra
    });
  }

  clearRoomSession() {
    const session = this.readStoredRoomSession();
    if (session?.game === this.gameId) writeSessionJson(ROOM_SESSION_KEY, null);
  }

  hydrateRoomSession(roomCode, role, preferredSeat) {
    const session = this.readStoredRoomSession();
    if (!session) return;
    if (session.roomCode !== roomCode) return;
    if (session.mode === 'room-host' && role !== 'host') return;
    if (session.mode === 'room-join' && role !== 'client') return;

    this.playerId = session.playerId || this.playerId;
    this.preferredSeat = normalizeSeat(session.preferredSeat) ?? normalizeSeat(preferredSeat);
    this.seat = this.preferredSeat;
  }

  host(roomCode, preferredSeat = this.preferredSeat ?? 0) {
    this.close();
    this.roomCode = String(roomCode || '').trim().toUpperCase();
    this.role = 'host';
    this.preferredSeat = normalizeSeat(preferredSeat) ?? 0;
    this.seat = this.preferredSeat;
    this.hydrateRoomSession(this.roomCode, this.role, this.preferredSeat);
    this.playerId = this.playerId || makeStablePlayerId();
    this.persistRoomSession();
    this.connect();
    return this.seat;
  }

  join(roomCode, preferredSeat = this.preferredSeat) {
    this.close();
    this.roomCode = String(roomCode || '').trim().toUpperCase();
    this.role = 'client';
    this.preferredSeat = normalizeSeat(preferredSeat);
    this.seat = this.preferredSeat;
    this.hydrateRoomSession(this.roomCode, this.role, this.preferredSeat);
    this.playerId = this.playerId || makeStablePlayerId();
    this.persistRoomSession();
    this.connect();
    return this.seat ?? 1;
  }

  getJoinName() {
    if (this.chat) return this.chat.getLocalName();
    return this.role === 'host' ? 'Host' : 'Player';
  }

  connect() {
    if (typeof window.io === 'function') {
      this.connectSocket();
      return;
    }
    this.connectBroadcastFallback();
  }

  connectSocket() {
    this.onStatus(`Connecting to realtime room ${this.roomCode}...`);
    this.hadSocketConnection = false;
    this.socket = window.io(REALTIME_SERVER_URL, {
      transports: ['websocket', 'polling']
    });

    this.socket.on('connect', () => {
      this.hadSocketConnection = true;
      this.socket.emit('join-room', {
        gameId: this.gameId,
        maxPlayers: this.maxPlayers,
        name: this.getJoinName(),
        playerId: this.playerId,
        preferredSeat: this.preferredSeat,
        role: this.role,
        roomId: this.roomCode
      });
    });

    this.socket.on('joined-room', (payload) => {
      this.playerId = payload?.playerId || this.playerId;
      this.role = payload?.role || this.role;
      this.userId = payload?.userId || null;
      if (typeof payload?.seat === 'number') {
        this.seat = payload.seat;
        this.preferredSeat = payload.seat;
      }
      this.persistRoomSession();

      this.onMessage({
        occupants: payload?.occupants || [],
        playerId: this.playerId,
        role: this.role,
        seat: this.seat,
        type: 'seat-assigned',
        userId: this.userId
      }, this);

      this.onStatus(
        this.role === 'host'
          ? `Hosting room ${this.roomCode}. Share the code so others can join.`
          : `Joined room ${this.roomCode} as Seat ${(this.seat ?? 0) + 1}. Waiting for the latest game state.`
      );

      if (payload?.snapshot !== undefined && payload?.snapshot !== null) {
        this.onMessage({ state: payload.snapshot, type: 'snapshot' }, this);
      }

      if (this.chat) {
        this.chat.replaceMessages(payload?.chatHistory || []);
        this.chat.updatePresenceList(payload?.occupants || []);
        this.chat.setBridge(this);
      }
    });

    this.socket.on('join-error', (payload) => {
      const message = payload?.message || 'Unable to join that room.';
      this.onStatus(message);
      if (this.chat) this.chat.setPresence(message);
      this.onMessage({
        code: payload?.code || 'join-error',
        message,
        type: 'join-error'
      }, this);
      this.close('join-error');
    });

    this.socket.on('game-snapshot', (payload) => {
      this.onMessage({ state: payload?.state ?? null, type: 'snapshot' }, this);
    });

    this.socket.on('game-intent', (payload) => {
      this.onMessage({
        intent: payload?.intent ?? null,
        seat: payload?.seat,
        type: 'intent'
      }, this);
    });

    this.socket.on('peer-joined', (payload) => {
      this.onMessage({
        name: payload?.name,
        seat: payload?.seat,
        type: 'join',
        userId: payload?.userId
      }, this);
    });

    this.socket.on('peer-left', (payload) => {
      this.onMessage({
        name: payload?.name,
        seat: payload?.seat,
        type: 'leave',
        userId: payload?.userId
      }, this);
    });

    this.socket.on('room-presence', (payload) => {
      if (this.chat) this.chat.updatePresenceList(payload?.occupants || []);
      this.onMessage({
        occupants: payload?.occupants || [],
        type: 'presence'
      }, this);
    });

    this.socket.on('chat-message', (payload) => {
      if (this.chat) this.chat.pushMessage(payload);
    });

    this.socket.on('host-promoted', (payload) => {
      this.role = 'host';
      if (typeof payload?.seat === 'number') {
        this.seat = payload.seat;
        this.preferredSeat = payload.seat;
      }
      this.persistRoomSession();
      this.onStatus(payload?.message || `You are now hosting room ${this.roomCode}.`);
      this.onMessage({
        message: payload?.message || 'You are now the host.',
        role: this.role,
        seat: this.seat,
        snapshot: payload?.snapshot ?? null,
        type: 'host-promoted'
      }, this);
    });

    this.socket.on('activate-bot', (payload) => {
      this.onMessage({
        seat: payload?.seat,
        type: 'activate-bot'
      }, this);
    });

    this.socket.on('deactivate-bot', (payload) => {
      this.onMessage({
        seat: payload?.seat,
        type: 'deactivate-bot'
      }, this);
    });

    this.socket.on('authority-rejected', (payload) => {
      const message = payload?.reason || 'Only the host may push game state.';
      this.onStatus(message);
      this.onMessage({
        message,
        type: 'authority-rejected'
      }, this);
    });

    this.socket.on('room-closed', (payload) => {
      const message = payload?.message || 'The room closed.';
      if (this.chat) {
        this.chat.pushMessage({ id: `system-${Date.now()}`, kind: 'system', text: message });
        this.chat.setPresence('Room closed');
      }
      this.onStatus(message);
      this.onMessage({
        message,
        reason: payload?.reason || 'closed',
        type: 'room-closed'
      }, this);
      this.close('room-closed');
    });

    this.socket.on('connect_error', () => {
      if (!this.hadSocketConnection && this.allowBroadcastFallback) {
        this.onStatus(`Realtime server unavailable at ${REALTIME_SERVER_URL}. Falling back to same-browser room mode.`);
        this.connectBroadcastFallback();
        return;
      }
      this.onStatus(`Realtime connection to ${REALTIME_SERVER_URL} failed. Retrying...`);
    });

    this.socket.on('disconnect', () => {
      if (!this.channel) this.onStatus(`Disconnected from room ${this.roomCode}. Reconnecting...`);
    });
  }

  connectBroadcastFallback() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }

    this.playerId = this.playerId || makeStablePlayerId();
    this.userId = this.userId || `${this.role || 'player'}-${Math.random().toString(36).slice(2, 8)}`;
    this.channel = new BroadcastChannel(`${this.gameId}-${this.roomCode}`);
    this.channel.onmessage = (event) => this.handleFallbackMessage(event.data);
    this.persistRoomSession();

    this.onMessage({
      playerId: this.playerId,
      role: this.role,
      seat: this.seat,
      type: 'seat-assigned',
      userId: this.userId
    }, this);

    this.onStatus(
      this.role === 'host'
        ? `Hosting room ${this.roomCode} in this browser only.`
        : `Joined room ${this.roomCode} in this browser only. Open another tab to test.`
    );

    if (this.chat) {
      this.chat.setPresence('Same-browser fallback');
      if (!this.chat.messages.length) {
        this.chat.setEmptyState('Socket.IO is unavailable, so room sync is limited to tabs in this browser.');
      }
      this.chat.setBridge(this);
    }

    if (this.role === 'client') {
      this.postFallback({
        name: this.getJoinName(),
        seat: this.seat,
        type: 'join',
        userId: this.userId
      });
    }
  }

  handleFallbackMessage(message) {
    if (!message) return;

    if (message.type === 'chat' && this.chat) {
      this.chat.pushMessage(message.payload);
      return;
    }

    this.onMessage(message, this);
  }

  postFallback(message) {
    if (this.channel) this.channel.postMessage(message);
  }

  broadcastState(state) {
    if (this.role !== 'host') return;
    if (this.socket) {
      this.socket.emit('game-snapshot', { state });
      return;
    }
    this.postFallback({ state, type: 'snapshot' });
  }

  sendIntent(intent) {
    if (this.role !== 'client') return;
    if (this.socket) {
      this.socket.emit('game-intent', { intent });
      return;
    }
    this.postFallback({
      intent,
      seat: this.seat,
      type: 'intent',
      userId: this.userId
    });
  }

  sendChat(text, name) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    if (this.socket) {
      this.socket.emit('chat-message', { text: trimmed, name });
      return;
    }

    const message = buildLocalMessage({
      name,
      role: this.role,
      seat: this.seat,
      text: trimmed,
      userId: this.userId || `${this.role || 'player'}-${this.seat ?? 'x'}`
    });

    if (this.chat) this.chat.pushMessage(message);
    this.postFallback({
      payload: message,
      type: 'chat'
    });
  }

  close(reason = 'manual') {
    if (this.socket) {
      if (this.socket.connected) this.socket.emit('leave-room');
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    if (reason !== 'preserve-session') this.clearRoomSession();

    this.roomCode = null;
    this.role = null;
    this.seat = null;
    this.playerId = null;
    this.userId = null;
    this.hadSocketConnection = false;

    if (this.chat) this.chat.setBridge(null);
  }
}

window.RoomBridge = RoomBridge;

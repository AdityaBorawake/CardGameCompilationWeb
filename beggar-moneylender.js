/* BEGGAR-MONEYLENDER — lobby-aware boot */
const SUITS = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];
const SUIT_CHAR = { Clubs: '♣', Diamonds: '♦', Hearts: '♥', Spades: '♠' };
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const AVATARS = ['P1','P2'];

const app = { mode: 'solo', localSeat: 0, bridge: null, state: null };
let lobbyCfg = null;

const modeEl        = document.getElementById('mode');
const roomCodeEl    = document.getElementById('room-code');
const setupStatusEl = document.getElementById('setup-status');
const setupDrawer   = document.getElementById('setup-drawer');
const toggleSetupBtn= document.getElementById('toggle-setup');
const goOverlay     = document.getElementById('gameover-overlay');
const goTitle       = document.getElementById('go-title');
const goMessage     = document.getElementById('go-message');
const chatUI        = window.initGameChat ? window.initGameChat() : null;

function suitClass(s) { return (s === 'Hearts' || s === 'Diamonds') ? 'red-suit' : 'black-suit'; }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function createDeck() { return SUITS.flatMap(s => RANKS.map(r => ({ suit: s, rank: r, key: `${r}-${s}` }))); }
function currentHumanSeat() { return app.mode === 'hotseat' ? app.state.turn : app.localSeat; }
function configuredLocalSeat(fallback = app.localSeat) {
  const preferredSeat = Number(lobbyCfg?.preferredSeat);
  if (Number.isInteger(preferredSeat)) return preferredSeat;
  const controllers = lobbyCfg?.controllers;
  if (Array.isArray(controllers)) {
    const seat = controllers.findIndex(controller => controller === 'local');
    if (seat >= 0) return seat;
  } else if (controllers && typeof controllers === 'object') {
    const match = Object.entries(controllers).find(([, controller]) => controller === 'local');
    if (match) {
      const seat = Number(match[0]);
      if (Number.isInteger(seat)) return seat;
    }
  }
  return Number.isInteger(fallback) ? fallback : 0;
}
function currentPlayerName() {
  const fallbackSeat = configuredLocalSeat(app.localSeat);
  return app.state?.players?.[currentHumanSeat()]?.name || lobbyCfg?.playerName || lobbyCfg?.names?.[fallbackSeat] || `Player ${fallbackSeat + 1}`;
}

function storedControllers() {
  if (app.mode === 'solo') return ['local', 'ai'];
  if (app.mode === 'hotseat') return ['local', 'local'];
  if (app.mode === 'room-host' || app.mode === 'room-join') {
    return Array.from({ length: 2 }, (_, seat) => {
      const controller = app.state?.players?.[seat]?.controller;
      if (controller === 'ai') return 'ai';
      return seat === app.localSeat ? 'local' : 'remote';
    });
  }
  return ['local', 'ai'];
}

function storedNames() {
  if (app.state?.players?.length) return app.state.players.map(player => player.name);
  if (lobbyCfg?.names?.length) return lobbyCfg.names.slice(0, 2);
  return ['Player 1', 'Player 2'];
}

function persistCurrentConfig(roomCode = roomCodeEl?.value?.trim?.() || 'BEGGAR-1') {
  window.persistLobbyConfig?.({
    controllers: storedControllers(),
    game: 'beggar',
    mode: app.mode,
    names: storedNames(),
    playerName: currentPlayerName(),
    preferredSeat: app.localSeat,
    roomCode
  });
}

function initState(mode) {
  const deck = shuffle(createDeck());
  const ctrl = lobbyCfg ? resolveControllers(lobbyCfg) : {
    0: (mode === 'room-join') ? 'remote' : 'local',
    1: (mode === 'hotseat') ? 'local' : (mode === 'room-join') ? 'local' : (mode === 'room-host') ? 'remote' : 'ai'
  };
  const names = lobbyCfg ? lobbyCfg.names : ['Player 1', 'Player 2'];
  const players = [0, 1].map(i => ({
    name: names[i] || `Player ${i + 1}`,
    hand: [], reserve: [],
    controller: Array.isArray(ctrl) ? ctrl[i] : ctrl[i],
    eliminated: false
  }));
  deck.forEach((card, i) => {
    const target = players[i % 2];
    if ((i % 4) < 2) target.hand.push(card); else target.reserve.push(card);
  });
  app.state = { players, pile: [], turn: 0, over: false, status: 'Flip to start.', lastFlipped: null };
  players.forEach(refill);
}

function refill(player) {
  while (player.hand.length < 4 && player.reserve.length) player.hand.push(player.reserve.pop());
  if (!player.hand.length && !player.reserve.length) player.eliminated = true;
}

function maybeWin() {
  const alive = app.state.players.filter(p => !p.eliminated);
  if (alive.length === 1) { app.state.over = true; app.state.status = `${alive[0].name} wins!`; return true; }
  if (alive.length === 0) { app.state.over = true; app.state.status = 'Draw — both players ran out!'; return true; }
  return false;
}

function doTurn() {
  const seat = app.state.turn;
  const player = app.state.players[seat];
  refill(player);
  if (!player.hand.length) { player.eliminated = true; if (!maybeWin()) app.state.turn = (app.state.turn + 1) % 2; return; }
  const card = player.hand.pop();
  app.state.pile.push(card);
  app.state.lastFlipped = { seat, card };
  const matched = app.state.pile.slice(0, -1).some(c => c.rank === card.rank);
  if (matched) {
    player.reserve.unshift(...app.state.pile);
    app.state.pile = [];
    refill(player);
    app.state.status = `${player.name} matched ${card.rank} and captured the pile!`;
  } else {
    refill(player);
    app.state.status = `${player.name} flipped ${card.rank}${SUIT_CHAR[card.suit]}.`;
  }
  if (!maybeWin()) app.state.turn = (app.state.turn + 1) % 2;
}

function processAIs() { while (!app.state.over && app.state.players[app.state.turn].controller === 'ai') doTurn(); }
function syncIfHost() { if (app.mode === 'room-host' && app.bridge) app.bridge.broadcastState(app.state); }

function render() {
  if (!app.state) return;
  const { state } = app;
  const seat = currentHumanSeat();
  chatUI?.setContext({ mode: app.mode, roomCode: roomCodeEl?.value?.trim?.() || '', playerName: currentPlayerName() });
  document.getElementById('turn-chip').textContent = state.over ? 'Finished' : `${state.players[state.turn].name}'s turn`;
  document.getElementById('status').textContent = state.status;
  const pileEl = document.getElementById('pile');
  if (state.pile.length) {
    const visible = state.pile.slice(-8);
    pileEl.innerHTML = visible.map((card, i) => {
      const isLatest = i === visible.length - 1;
      return `<div class="card board-card ${suitClass(card.suit)} ${isLatest ? 'latest-play' : ''}" style="width:clamp(42px,6vw,64px);height:calc(clamp(42px,6vw,64px)*1.4)"><span class="c-rank">${card.rank}</span><span class="c-suit">${SUIT_CHAR[card.suit]}</span></div>`;
    }).join('') + (state.pile.length > 8 ? `<span class="pile-empty">+${state.pile.length - 8} more</span>` : '');
  } else { pileEl.innerHTML = `<span class="pile-empty">Pile is empty</span>`; }
  document.getElementById('pile-stats').innerHTML = `
    <div class="stat-chip">Pile: <strong>${state.pile.length}</strong></div>
    <div class="stat-chip">${state.players[0].name}: H<strong>${state.players[0].hand.length}</strong> R<strong>${state.players[0].reserve.length}</strong></div>
    <div class="stat-chip">${state.players[1].name}: H<strong>${state.players[1].hand.length}</strong> R<strong>${state.players[1].reserve.length}</strong></div>`;
  document.getElementById('player-profile').innerHTML = `<div class="player-avatar">${AVATARS[seat]}</div><div><div class="player-name">${state.players[seat].name}</div><div class="player-sub">Hand ${state.players[seat].hand.length} | Reserve ${state.players[seat].reserve.length}</div></div>`;
  const canAct = state.turn === seat && !state.over;
  document.getElementById('hand-title').textContent = canAct ? 'Your Turn — Flip!' : `${state.players[state.turn].name}'s Turn`;
  const flipBtn = document.getElementById('flip-btn');
  flipBtn.disabled = !canAct;
  flipBtn.onclick = () => {
    if (!canAct) return;
    if (app.mode === 'room-join') { app.bridge.sendIntent({ type: 'flip' }); setupStatusEl.textContent = 'Flip sent.'; return; }
    doTurn(); processAIs(); syncIfHost(); render();
    if (state.over) showGameOver(state.status, '');
  };
  const dv = document.getElementById('deck-visual');
  dv.onclick = () => { if (canAct) flipBtn.click(); };
  dv.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && canAct) { e.preventDefault(); flipBtn.click(); } };
  const lastEl = document.getElementById('last-card-display');
  if (state.lastFlipped) {
    const { card, seat: fb } = state.lastFlipped;
    lastEl.innerHTML = `<div class="card ${suitClass(card.suit)}" style="width:44px;height:62px;border-radius:8px;font-size:0.8rem;padding:3px 4px;display:inline-flex;flex-direction:column;justify-content:space-between;background:linear-gradient(180deg,#fffdf8,#f2e8d8);border:1.5px solid rgba(0,0,0,0.08);box-shadow:0 4px 10px rgba(0,0,0,0.14);color:#1d1a16"><span style="font-weight:700">${card.rank}</span><span>${SUIT_CHAR[card.suit]}</span></div><div style="font-size:0.72rem;color:var(--table-muted);margin-top:4px">by ${state.players[fb].name}</div>`;
  } else { lastEl.textContent = '—'; }
  renderSeat('seat-top', 1);
  if (state.over) showGameOver(state.status, '');
}

function renderSeat(targetId, seatIdx) {
  const el = document.getElementById(targetId);
  if (!el || !app.state) return;
  const player = app.state.players[seatIdx];
  if (!player || seatIdx === currentHumanSeat()) { el.innerHTML = ''; return; }
  const isActive = app.state.turn === seatIdx && !app.state.over;
  const cardBacks = Array.from({ length: Math.min(player.hand.length, 6) }, () => `<div class="seat-mini-card"></div>`).join('');
  el.innerHTML = `<div class="seat-badge ${isActive ? 'active-seat' : ''}"><div class="seat-avatar">${AVATARS[seatIdx]}</div><div class="seat-name-label">${player.name}</div><div class="seat-sub-label">H${player.hand.length} R${player.reserve.length}</div><div class="seat-card-row">${cardBacks}</div></div>`;
}

function showGameOver(title, message) { goTitle.textContent = title; goMessage.textContent = message || ''; goOverlay.classList.remove('hidden'); }

function startGame(fromLobby) {
  if (fromLobby) {
    lobbyCfg = getLobbyConfig('beggar', 2);
    app.mode = resolveMode(lobbyCfg);
    if (roomCodeEl) roomCodeEl.value = lobbyCfg.roomCode;
    if (modeEl) modeEl.value = app.mode;
  } else {
    lobbyCfg = null;
    app.mode = modeEl ? modeEl.value : 'solo';
  }
  app.localSeat = app.mode === 'room-host' || app.mode === 'room-join' ? configuredLocalSeat(app.mode === 'room-host' ? 0 : 1) : 0;
  goOverlay.classList.add('hidden');
  if (app.bridge) app.bridge.close();
  const rc = (roomCodeEl ? roomCodeEl.value.trim() : null) || 'BEGGAR-1';
  chatUI?.setContext({ mode: app.mode, roomCode: rc, playerName: currentPlayerName() });
  if (app.mode === 'room-host' || app.mode === 'room-join') {
    app.bridge = new RoomBridge('beggar-room', handleRoomMessage, t => { if (setupStatusEl) setupStatusEl.textContent = t; }, { maxPlayers: 2, preferredSeat: app.localSeat });
    app.localSeat = app.mode === 'room-host' ? app.bridge.host(rc, app.localSeat) : app.bridge.join(rc, app.localSeat);
  } else { app.bridge = null; app.localSeat = 0; }
  if (chatUI) chatUI.setBridge(app.bridge || null);
  if (app.mode !== 'room-join') {
    initState(app.mode); processAIs(); syncIfHost(); render();
    const msgs = { solo: 'Solo match started.', hotseat: 'Hotseat — pass device each turn.', 'room-host': `Hosting room ${rc}.` };
    if (setupStatusEl) setupStatusEl.textContent = msgs[app.mode] || '';
  } else {
    app.state = null;
    ['pile','pile-stats','seat-top','player-profile'].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ''; });
    chatUI?.setEmptyState('Connected room chat will appear here as soon as the host shares a snapshot.');
    document.getElementById('status').textContent = 'Waiting for host snapshot…';
  }
  persistCurrentConfig(rc);
  if (setupDrawer) { setupDrawer.classList.remove('open'); setupDrawer.setAttribute('aria-hidden', 'true'); }
  if (toggleSetupBtn) toggleSetupBtn.setAttribute('aria-expanded', 'false');
}

function handleRoomMessage(message) {
  if (message.type === 'seat-assigned') {
    if (typeof message.seat === 'number') app.localSeat = message.seat;
    if (message.role === 'host' || message.role === 'client') app.mode = message.role === 'host' ? 'room-host' : 'room-join';
    chatUI?.setContext({ mode: app.mode, roomCode: roomCodeEl?.value?.trim?.() || '', playerName: currentPlayerName() });
    persistCurrentConfig();
    if (app.state) render();
  }
  if (app.mode === 'room-host' && message.type === 'join') {
    if (typeof message.seat === 'number' && app.state?.players?.[message.seat] && message.name) {
      app.state.players[message.seat].name = message.name;
      app.state.players[message.seat].controller = 'remote';
      render();
    }
    if (setupStatusEl) setupStatusEl.textContent = message.name ? `${message.name} joined.` : 'Guest joined.';
    syncIfHost();
  }
  if (app.mode === 'room-host' && message.type === 'leave' && typeof message.seat === 'number') {
    if (setupStatusEl) setupStatusEl.textContent = `${message.name || 'Player'} disconnected. Waiting before bot takeover.`;
  }
  if (app.mode === 'room-host' && message.type === 'activate-bot' && typeof message.seat === 'number' && app.state?.players?.[message.seat]) {
    app.state.players[message.seat].controller = 'ai';
    if (setupStatusEl) setupStatusEl.textContent = `${app.state.players[message.seat].name} is now controlled by a bot.`;
    processAIs(); syncIfHost(); render();
    if (app.state.over) showGameOver(app.state.status, '');
  }
  if (app.mode === 'room-host' && message.type === 'deactivate-bot' && typeof message.seat === 'number' && app.state?.players?.[message.seat]) {
    app.state.players[message.seat].controller = message.seat === app.localSeat ? 'local' : 'remote';
    if (setupStatusEl) setupStatusEl.textContent = `${app.state.players[message.seat].name} rejoined the room.`;
    syncIfHost(); render();
  }
  if (app.mode === 'room-host' && message.type === 'intent' && message.intent?.type === 'flip' && typeof message.seat === 'number' && app.state.turn === message.seat) { doTurn(); processAIs(); syncIfHost(); render(); if (app.state.over) showGameOver(app.state.status, ''); }
  if (message.type === 'host-promoted') {
    app.mode = 'room-host';
    if (typeof message.seat === 'number') app.localSeat = message.seat;
    app.state = message.snapshot || app.state;
    if (app.state?.players?.length) {
      app.state.players.forEach((player, seat) => {
        if (player.controller !== 'ai') player.controller = seat === app.localSeat ? 'local' : 'remote';
      });
    }
    persistCurrentConfig();
    processAIs(); syncIfHost(); render();
    if (app.state?.over) showGameOver(app.state.status, '');
    if (setupStatusEl) setupStatusEl.textContent = message.message || 'You are now the host.';
  }
  if (app.mode === 'room-join' && message.type === 'snapshot') { app.state = message.state; render(); if (setupStatusEl) setupStatusEl.textContent = 'Connected to room.'; }
  if (message.type === 'join-error') {
    if (setupStatusEl) setupStatusEl.textContent = message.message || 'Unable to join room.';
    document.getElementById('status').textContent = message.message || 'Unable to join room.';
  }
  if (message.type === 'authority-rejected') {
    if (setupStatusEl) setupStatusEl.textContent = message.message || 'Only the host can sync room state.';
    document.getElementById('status').textContent = message.message || 'Only the host can sync room state.';
  }
  if (message.type === 'room-closed' && app.mode === 'room-join') {
    app.state = null;
    ['pile','pile-stats','seat-top','player-profile'].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ''; });
    chatUI?.setEmptyState(message.message || 'Room closed.');
    if (setupStatusEl) setupStatusEl.textContent = message.message || 'Room closed.';
    document.getElementById('status').textContent = message.message || 'Room closed.';
  }
}

document.getElementById('start-btn')?.addEventListener('click', () => startGame(false));
document.getElementById('go-restart')?.addEventListener('click', () => startGame(false));
toggleSetupBtn?.addEventListener('click', () => {
  const isOpen = setupDrawer.classList.contains('open');
  setupDrawer.classList.toggle('open', !isOpen);
  setupDrawer.setAttribute('aria-hidden', String(isOpen));
  toggleSetupBtn.setAttribute('aria-expanded', String(!isOpen));
});

startGame(true);

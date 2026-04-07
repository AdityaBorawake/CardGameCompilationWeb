/**
 * sevens.js — Sevens game, built on GameEngine
 *
 * Architecture:
 *   HOST  → runs all game logic via GameEngine._handleIntent
 *   CLIENT → sends intents, renders snapshots
 *   BOTS   → run on host only, with 700ms delay
 *
 * Intent types:
 *   { type: 'play', cardKey: string }
 *   { type: 'skip' }          — only legal when player has no valid cards
 *
 * Skip button:
 *   Visible always in player tray.
 *   Glows + enabled ONLY when it is your turn AND you have zero legal cards.
 *   Clicking it sends a 'skip' intent (host validates).
 */

/* ═══════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════ */
const SUITS      = ['Clubs','Diamonds','Hearts','Spades'];
const SUIT_CHAR  = { Clubs:'♣', Diamonds:'♦', Hearts:'♥', Spades:'♠' };
const RANKS      = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const AVATARS    = ['P1','P2','P3'];

/* ═══════════════════════════════════════════
   PURE GAME LOGIC (no DOM, no side effects)
   These functions are used by the GameEngine.
═══════════════════════════════════════════ */

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rankVal(r)      { return RANKS.indexOf(r); }
function suitCls(s)      { return (s === 'Hearts' || s === 'Diamonds') ? 'red-suit' : 'black-suit'; }
function sortCards(cards) {
  return [...cards].sort((a, b) =>
    a.suit === b.suit
      ? rankVal(a.rank) - rankVal(b.rank)
      : SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit)
  );
}
function createDeck() {
  return SUITS.flatMap(s => RANKS.map(r => ({ suit: s, rank: r, key: `${r}-${s}` })));
}
function laneCanPlace(lane, card) {
  if (!lane.length) return card.rank === '7';
  const vals = lane.map(c => rankVal(c.rank));
  const lo = Math.min(...vals), hi = Math.max(...vals), v = rankVal(card.rank);
  return v === lo - 1 || v === hi + 1;
}
function legalMoves(state, seat) {
  return state.players[seat].hand.filter(c => laneCanPlace(state.board[c.suit], c));
}

/**
 * Build visible lane slots (placed cards + empty edge slots)
 */
function getLaneSlots(board, suit) {
  const lane = board[suit];
  if (!lane.length) return [{ rank: '7', suit, empty: true, starter: true }];
  const vals  = lane.map(c => rankVal(c.rank));
  const lo    = Math.min(...vals), hi = Math.max(...vals);
  const slots = [];
  for (let i = Math.max(0, lo - 1); i <= Math.min(RANKS.length - 1, hi + 1); i++) {
    const rank     = RANKS[i];
    const existing = lane.find(c => c.rank === rank);
    slots.push(existing || { rank, suit, empty: true, playable: i === lo - 1 || i === hi + 1 });
  }
  return slots;
}

/* ── GameEngine hooks ── */

/**
 * init(config) → initialState
 * Called once by the host to create a fresh game.
 */
function sevensInit(config) {
  const numPlayers = config.players?.length ?? 3;
  const deck       = shuffle(createDeck());
  const players    = (config.players || []).map((p, i) => ({
    name:       p.name       || `Player ${i + 1}`,
    controller: p.controller || 'ai',
    hand:       [],
  }));
  deck.forEach((card, i) => players[i % numPlayers].hand.push(card));
  players.forEach(p => { p.hand = sortCards(p.hand); });

  // Rule: player holding 7♥ goes first
  const starter = players.findIndex(p => p.hand.some(c => c.rank === '7' && c.suit === 'Hearts'));

  return {
    board:         Object.fromEntries(SUITS.map(s => [s, []])),
    lastPlacedKey: null,
    lastAction:    null,  // { seat, type, cardKey? } — shown in announce banner
    over:          false,
    players,
    status:        'Build the board outward from the sevens. 7♥ must be placed first.',
    turn:          starter >= 0 ? starter : 0,
    winner:        null,
  };
}

/**
 * applyIntent(state, intent, seat) → { state, error? }
 * Host calls this to validate + apply a move.
 * Always returns a new state object (deep-cloned by engine).
 */
function sevensApplyIntent(state, intent, seat) {
  // Enforce turn order
  if (state.turn !== seat) {
    return { state, error: 'Not your turn.' };
  }
  if (state.over) {
    return { state, error: 'Game is over.' };
  }

  if (intent.type === 'skip') {
    const legal = legalMoves(state, seat);
    if (legal.length > 0) {
      return { state, error: 'You have legal moves — skip not allowed.' };
    }
    state.lastAction  = { seat, type: 'skip' };
    state.turn        = _advanceTurn(state);
    state.status      = `${state.players[state.turn].name}'s turn.`;
    return { state };
  }

  if (intent.type === 'play') {
    const { cardKey } = intent;
    const player      = state.players[seat];
    const cardIdx     = player.hand.findIndex(c => c.key === cardKey);

    if (cardIdx < 0) {
      return { state, error: 'Card not in hand.' };
    }

    const card = player.hand[cardIdx];

    if (!laneCanPlace(state.board[card.suit], card)) {
      return { state, error: 'Card cannot be placed on that lane.' };
    }

    // Apply move
    player.hand.splice(cardIdx, 1);
    state.lastPlacedKey = card.key;
    state.board[card.suit] = sortCards([...state.board[card.suit], card]);
    state.lastAction   = { seat, type: 'play', cardKey, card };

    if (!player.hand.length) {
      state.over   = true;
      state.winner = seat;
      state.status = `${player.name} wins Sevens!`;
      return { state };
    }

    state.turn   = _advanceTurn(state);
    state.status = `${state.players[state.turn].name}'s turn.`;
    return { state };
  }

  return { state, error: `Unknown intent type: ${intent.type}` };
}

/**
 * Advance to the next seat in turn order.
 * Humans must explicitly use Skip when they have no legal moves.
 */
function _advanceTurn(state) {
  return (state.turn + 1) % state.players.length;
}

/**
 * getBotMove(state, seat) → intent
 * Simple AI: prefer non-sevens moves, else play any legal card.
 */
function sevensGetBotMove(state, seat) {
  const options = legalMoves(state, seat);
  if (!options.length) return { type: 'skip' };
  const preferred = options.find(c => c.rank !== '7') || options[0];
  return { type: 'play', cardKey: preferred.key };
}

/**
 * isOver(state) → boolean
 */
function sevensIsOver(state) {
  return state.over;
}

/* ═══════════════════════════════════════════
   APP STATE
═══════════════════════════════════════════ */

const app = {
  engine:    null,
  mode:      'solo',
  localSeat: 0,
  bridge:    null,
};

let lobbyCfg = null;

/* ── DOM refs ── */
const modeEl         = document.getElementById('mode');
const roomCodeEl     = document.getElementById('room-code');
const setupStatusEl  = document.getElementById('setup-status');
const setupDrawer    = document.getElementById('setup-drawer');
const toggleSetupBtn = document.getElementById('toggle-setup');
const goOverlay      = document.getElementById('gameover-overlay');
const goTitle        = document.getElementById('go-title');
const goMessage      = document.getElementById('go-message');
const statusEl       = document.getElementById('status');
const announceEl     = document.getElementById('announce');
const skipBtn        = document.getElementById('skip-btn');

/* ── Chat ── */
const chatUI = window.initGameChat ? window.initGameChat() : null;

/* ═══════════════════════════════════════════
   ANNOUNCE BANNER
═══════════════════════════════════════════ */
let _announceTimer = null;
function announce(msg, dur = 2400) {
  if (!announceEl) return;
  announceEl.classList.remove('fade');
  announceEl.textContent = msg;
  clearTimeout(_announceTimer);
  _announceTimer = setTimeout(() => announceEl.classList.add('fade'), dur);
}

function configuredLocalSeat(fallback = app.localSeat) {
  const preferredSeat = Number(lobbyCfg?.preferredSeat);
  if (Number.isInteger(preferredSeat)) return preferredSeat;

  const controllers = lobbyCfg ? resolveControllers(lobbyCfg) : null;
  if (Array.isArray(controllers)) {
    const seat = controllers.findIndex(controller => controller === 'local');
    if (seat >= 0) return seat;
  }
  return Number.isInteger(fallback) ? fallback : 0;
}

function storedControllers() {
  if (app.mode === 'solo') return ['local', 'ai', 'ai'];
  if (app.mode === 'hotseat') return ['local', 'local', 'local'];
  if (app.mode === 'room-host' || app.mode === 'room-join') {
    return Array.from({ length: 3 }, (_, seat) => {
      const controller = app.engine?.state?.players?.[seat]?.controller;
      if (controller === 'ai') return 'ai';
      return seat === app.localSeat ? 'local' : 'remote';
    });
  }
  return _defaultControllers(app.mode);
}

function storedNames() {
  if (app.engine?.state?.players?.length) return app.engine.state.players.map(player => player.name);
  if (Array.isArray(lobbyCfg?.names)) return lobbyCfg.names.slice(0, 3);
  return ['Player 1', 'Player 2', 'Player 3'];
}

function persistCurrentConfig(roomCode) {
  window.persistLobbyConfig?.({
    controllers: storedControllers(),
    game: 'sevens',
    mode: app.mode,
    names: storedNames(),
    preferredSeat: app.localSeat,
    roomCode: roomCode || roomCodeEl?.value?.trim?.() || 'SEVENS-1'
  });
}

/* ═══════════════════════════════════════════
   RENDER
   Called by GameEngine on every state update.
   Clients AND host both call this.
═══════════════════════════════════════════ */
function render(state, engine) {
  if (!state) return;

  /* Turn chip */
  document.getElementById('turn-chip').textContent = state.over
    ? '🏆 Finished'
    : `${state.players[state.turn].name}'s turn`;

  /* Status bar */
  statusEl.textContent = state.status;

  /* Announce last action */
  if (state.lastAction) {
    const { seat, type, card } = state.lastAction;
    const name = state.players[seat]?.name || `Seat ${seat}`;
    if (type === 'play' && card) {
      announce(`${name} placed ${card.rank}${SUIT_CHAR[card.suit]} on ${card.suit}`);
    } else if (type === 'skip') {
      announce(`${name} was skipped (no legal moves)`);
    }
  }

  /* Board lanes */
  const humanSeat  = _humanSeat();
  const myLegal    = new Set(legalMoves(state, humanSeat).map(c => c.key));

  document.getElementById('board').innerHTML = SUITS.map(suit => {
    const slots = getLaneSlots(state.board, suit);
    const cards = slots.map(slot => {
      if (slot.empty) {
        const cls = (slot.playable || slot.starter) ? 'playable-slot' : '';
        return `<div class="card board-card empty-slot ${cls}" aria-hidden="true">
          <span class="c-suit" style="opacity:0.28;align-self:center;margin:auto;font-size:1rem">
            ${slot.starter ? SUIT_CHAR[suit] : ''}
          </span>
        </div>`;
      }
      const isLatest = slot.key === state.lastPlacedKey;
      return `<div class="card board-card ${suitCls(slot.suit)} ${isLatest ? 'latest-play' : ''} ${slot.rank === '7' ? 'highlight' : ''}"
                   aria-label="${slot.rank} of ${slot.suit}">
        <span class="c-rank">${slot.rank}</span>
        <span class="c-suit">${SUIT_CHAR[slot.suit]}</span>
      </div>`;
    }).join('');
    return `<div>
      <div class="suit-lane-header">${suit} ${SUIT_CHAR[suit]}</div>
      <div class="lane-cards-wrap">${cards}</div>
    </div>`;
  }).join('');

  /* Hand */
  const isMyTurn  = state.turn === humanSeat && !state.over;
  const myPlayer  = state.players[humanSeat];
  document.getElementById('hand-title').textContent =
    `${myPlayer.name} — ${myPlayer.hand.length} cards`;

  const handEl = document.getElementById('hand');
  handEl.innerHTML = myPlayer.hand.map(card => {
    const disabled = !isMyTurn || !myLegal.has(card.key);
    return `<div class="card hand-card ${suitCls(card.suit)} ${disabled ? 'disabled' : 'playable'}"
                 role="button" tabindex="${disabled ? -1 : 0}"
                 aria-label="${card.rank} of ${card.suit}"
                 data-card="${card.key}">
      <span class="c-rank">${card.rank}</span>
      <span class="c-suit">${SUIT_CHAR[card.suit]}</span>
    </div>`;
  }).join('');

  handEl.querySelectorAll('[data-card]').forEach(el => {
    const handler = () => {
      if (el.classList.contains('disabled')) return;
      engine.submitIntent({ type: 'play', cardKey: el.dataset.card });
    };
    el.addEventListener('click', handler);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  });

  /* Skip button — glows only when usable */
  const canSkip = isMyTurn && myLegal.size === 0;
  if (skipBtn) {
    skipBtn.disabled = !canSkip;
    skipBtn.classList.toggle('skip-glow', canSkip);
    skipBtn.classList.toggle('skip-ready', canSkip);
    skipBtn.title = canSkip
      ? 'No legal moves — click to skip your turn'
      : 'Skip is only available when you have no legal moves';
  }

  /* Player profile */
  document.getElementById('player-profile').innerHTML = `
    <div class="player-avatar">${AVATARS[humanSeat]}</div>
    <div>
      <div class="player-name">${myPlayer.name}</div>
      <div class="player-sub">${myPlayer.hand.length} cards left</div>
    </div>`;

  /* Opponent seats */
  _renderSeat('seat-top',   1, state, humanSeat, engine);
  _renderSeat('seat-left',  2, state, humanSeat, engine);
  _renderSeat('seat-right', 0, state, humanSeat, engine);

  /* Game over */
  if (state.over && state.winner !== null) {
    const winner = state.players[state.winner];
    showGameOver(`${winner.name} wins! 🎉`, `${winner.name} emptied their hand first.`);
  }
}

function _humanSeat() {
  if (app.mode === 'hotseat' && app.engine?.state) return app.engine.state.turn;
  return app.localSeat;
}

function _renderSeat(targetId, seatIdx, state, humanSeat, engine) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const player = state.players[seatIdx];
  if (!player || seatIdx === humanSeat) { el.innerHTML = ''; return; }

  const isActive   = state.turn === seatIdx && !state.over;
  const isAI       = player.controller === 'ai';
  const cardBacks  = Array.from({ length: Math.min(player.hand.length, 6) }, () =>
    '<div class="seat-mini-card"></div>').join('');

  el.innerHTML = `
    <div class="seat-badge ${isActive ? 'active-seat' : ''} ${isAI && isActive ? 'thinking' : ''}">
      <div class="seat-avatar">${AVATARS[seatIdx]}</div>
      <div class="seat-name-label">${player.name}${isAI ? ' 🤖' : ''}</div>
      <div class="seat-sub-label">${player.hand.length} cards${isAI && isActive ? ' · thinking…' : ''}</div>
      <div class="seat-card-row">${cardBacks}</div>
    </div>`;
}

/* ═══════════════════════════════════════════
   SKIP BUTTON HANDLER
═══════════════════════════════════════════ */
skipBtn?.addEventListener('click', () => {
  if (skipBtn.disabled) return;
  app.engine?.submitIntent({ type: 'skip' });
});

/* ═══════════════════════════════════════════
   GAME OVER OVERLAY
═══════════════════════════════════════════ */
function showGameOver(title, message) {
  if (goTitle)   goTitle.textContent   = title;
  if (goMessage) goMessage.textContent = message;
  goOverlay?.classList.remove('hidden');
}

/* ═══════════════════════════════════════════
   START / RESTART
═══════════════════════════════════════════ */
function startGame(fromLobby = false) {
  if (fromLobby) {
    lobbyCfg   = getLobbyConfig('sevens', 3);
    app.mode   = resolveMode(lobbyCfg);
    if (roomCodeEl) roomCodeEl.value = lobbyCfg.roomCode;
    if (modeEl)     modeEl.value     = app.mode;
  } else {
    lobbyCfg = null;
    app.mode = modeEl?.value || 'solo';
  }

  goOverlay?.classList.add('hidden');

  // Destroy old engine
  app.engine?.destroy();
  app.bridge?.close();
  app.bridge = null;

  const rc = roomCodeEl?.value.trim() || 'SEVENS-1';

  /* Build players config */
  const ctrl  = lobbyCfg ? resolveControllers(lobbyCfg) : _defaultControllers(app.mode);
  const names = lobbyCfg ? lobbyCfg.names       : ['Player 1', 'Player 2', 'Player 3'];

  const isHost = app.mode === 'solo' || app.mode === 'hotseat' || app.mode === 'room-host';
  app.localSeat = isHost ? 0 : configuredLocalSeat(Array.isArray(ctrl) ? ctrl.findIndex(c => c === 'local') : 1);
  if (app.localSeat < 0) app.localSeat = 1;

  /* Bridge */
  if (app.mode === 'room-host' || app.mode === 'room-join') {
    app.bridge = new RoomBridge('sevens-room', () => {}, t => {
      if (setupStatusEl) setupStatusEl.textContent = t;
    }, { maxPlayers: 3, preferredSeat: app.localSeat });

    if (app.mode === 'room-host') {
      app.localSeat = app.bridge.host(rc, 0);
    } else {
      app.bridge.join(rc, app.localSeat);
    }
  }

  chatUI?.setBridge(app.bridge || null);
  chatUI?.setContext({ mode: app.mode, roomCode: rc, playerName: names[app.localSeat] || 'Player' });

  /* Build engine */
  app.engine = new GameEngine({
    gameId:    'sevens',
    bridge:    app.bridge,
    mode:      app.mode,
    localSeat: app.localSeat,
    onRender:  render,
  });

  app.engine.setLogic({
    init:        sevensInit,
    applyIntent: sevensApplyIntent,
    getBotMove:  sevensGetBotMove,
    isOver:      sevensIsOver,
  });

  // Wire up bridge events through engine
  if (app.bridge) {
    app.bridge.onMessage = (message, bridge) => {
      _handleBridgeMessage(message, bridge);
    };
  }

  if (isHost) {
    const playersConfig = Array.from({ length: 3 }, (_, i) => ({
      name:       names[i] || `Player ${i + 1}`,
      controller: Array.isArray(ctrl) ? (ctrl[i] || 'ai') : (ctrl[i] || 'ai'),
    }));
    app.engine.start({ players: playersConfig });
    if (setupStatusEl) {
      setupStatusEl.textContent = {
        solo:        'Solo match started.',
        hotseat:     'Hotseat — pass the device each turn.',
        'room-host': `Hosting room ${rc}. Share the code with others.`,
      }[app.mode] || '';
    }
  } else {
    // Client — wait for snapshot
    if (statusEl) statusEl.textContent = 'Waiting for host to start the game…';
    ['hand','board','seat-top','seat-left','seat-right','player-profile'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    chatUI?.setEmptyState('Connected room chat will appear here as soon as the host shares a snapshot.');
  }

  setupDrawer?.classList.remove('open');
  setupDrawer?.setAttribute('aria-hidden', 'true');
  toggleSetupBtn?.setAttribute('aria-expanded', 'false');
  persistCurrentConfig(rc);
}

/* ── Bridge message handler ── */
function _handleBridgeMessage(message) {
  const engine = app.engine;
  if (!engine) return;

  switch (message.type) {
    case 'seat-assigned':
      if (typeof message.seat === 'number') {
        app.localSeat = message.seat;
        engine.localSeat = message.seat;
      }
      if (message.role === 'host' || message.role === 'client') {
        app.mode = message.role === 'host' ? 'room-host' : 'room-join';
      }
      chatUI?.setContext({
        mode: app.mode,
        playerName: storedNames()[app.localSeat] || 'Player',
        roomCode: roomCodeEl?.value?.trim?.() || 'SEVENS-1'
      });
      persistCurrentConfig();
      if (engine.state) render(engine.state, engine);
      break;

    case 'snapshot':
      engine.state = message.state;
      render(engine.state, engine);
      if (setupStatusEl) setupStatusEl.textContent = 'Connected to room.';
      break;

    case 'intent':
      // Host only: validate + apply
      if (engine.isHost) {
        engine._handleIntent(message.intent, message.seat);
      }
      break;

    case 'host-promoted':
      app.mode = 'room-host';
      if (typeof message.seat === 'number') {
        app.localSeat = message.seat;
        engine.localSeat = message.seat;
      }
      engine.becomeHost(message.snapshot || engine.state);
      if (engine.state?.players?.[app.localSeat]) {
        engine.state.players.forEach((player, seat) => {
          if (player.controller !== 'ai') player.controller = seat === app.localSeat ? 'local' : 'remote';
        });
        engine._sync();
      }
      persistCurrentConfig();
      if (setupStatusEl) setupStatusEl.textContent = message.message || 'You are now the host.';
      break;

    case 'activate-bot':
      if (engine.isHost && engine.state?.players?.[message.seat]) {
        engine.state.players[message.seat].controller = 'ai';
        engine.activateBot(message.seat);
        engine._sync();
      }
      break;

    case 'deactivate-bot':
      if (engine.isHost && engine.state?.players?.[message.seat]) {
        engine.state.players[message.seat].controller = message.seat === app.localSeat ? 'local' : 'remote';
        engine.deactivateBot(message.seat);
        engine._sync();
      }
      break;

    case 'join':
      if (engine.isHost && engine.state && typeof message.seat === 'number') {
        // Update player name if they sent one
        if (message.name && engine.state.players[message.seat]) {
          engine.state.players[message.seat].name = message.name;
          engine.state.players[message.seat].controller = 'remote';
          engine._sync();
        }
        if (setupStatusEl) setupStatusEl.textContent = `${message.name || 'Player'} joined.`;
      }
      break;

    case 'leave':
      if (engine.isHost && engine.state && typeof message.seat === 'number') {
        if (setupStatusEl) {
          setupStatusEl.textContent = `${message.name || 'Player'} disconnected. Waiting for reconnect before bot takeover.`;
        }
      }
      break;

    case 'room-closed':
      engine.state = null;
      ['hand','board','seat-top','seat-left','seat-right','player-profile'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
      });
      chatUI?.setEmptyState(message.message || 'Room closed.');
      if (statusEl) statusEl.textContent = message.message || 'Room closed.';
      if (setupStatusEl) setupStatusEl.textContent = message.message || 'Room closed.';
      break;

    case 'join-error':
      if (statusEl)      statusEl.textContent      = message.message || 'Could not join room.';
      if (setupStatusEl) setupStatusEl.textContent = message.message || 'Could not join room.';
      break;

    case 'authority-rejected':
      if (setupStatusEl) setupStatusEl.textContent = message.message || 'Only the host may sync state.';
      if (statusEl) statusEl.textContent = message.message || 'Only the host may sync state.';
      break;

    default:
      break;
  }
}

/* ── Default controllers when no lobby config ── */
function _defaultControllers(mode) {
  if (mode === 'solo')      return ['local', 'ai',    'ai'];
  if (mode === 'hotseat')   return ['local', 'local', 'local'];
  if (mode === 'room-host') return ['local', 'remote','remote'];
  if (mode === 'room-join') return ['remote','local', 'remote'];
  return ['local','ai','ai'];
}

/* ═══════════════════════════════════════════
   UI EVENT LISTENERS
═══════════════════════════════════════════ */
document.getElementById('start-btn')?.addEventListener('click',  () => startGame(false));
document.getElementById('go-restart')?.addEventListener('click', () => startGame(false));

toggleSetupBtn?.addEventListener('click', () => {
  const isOpen = setupDrawer.classList.contains('open');
  setupDrawer.classList.toggle('open', !isOpen);
  setupDrawer.setAttribute('aria-hidden', String(isOpen));
  toggleSetupBtn.setAttribute('aria-expanded', String(!isOpen));
});

/* ═══════════════════════════════════════════
   BOOT
═══════════════════════════════════════════ */
startGame(true);

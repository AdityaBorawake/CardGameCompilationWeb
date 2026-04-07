/**
 * game-engine.js — Reusable host-authoritative GameEngine
 *
 * Rules:
 *  - Only the host runs game logic
 *  - Clients send intents; host validates, mutates, and broadcasts full state
 *  - Bots run only on the host
 *  - Full state sync after every action
 *
 * Usage (host):
 *   const engine = new GameEngine({ gameId: 'sevens', bridge, onRender });
 *   engine.setLogic({ init, applyIntent, getBotMove, isOver });
 *   engine.start(config);
 *
 * Usage (client):
 *   const engine = new GameEngine({ gameId: 'sevens', bridge, onRender });
 *   engine.connectAsClient();
 *   // engine.onRender is called whenever a new snapshot arrives
 */

class GameEngine {
  /**
   * @param {object} opts
   * @param {string}   opts.gameId
   * @param {object}   opts.bridge     - RoomBridge instance (or null for local)
   * @param {Function} opts.onRender   - called with (state, engine) after every update
   * @param {string}   opts.mode       - 'solo' | 'hotseat' | 'room-host' | 'room-join'
   * @param {number}   opts.localSeat  - which seat this client controls
   */
  constructor({ gameId, bridge, onRender, mode = 'solo', localSeat = 0 }) {
    this.gameId    = gameId;
    this.bridge    = bridge;
    this.onRender  = onRender || (() => {});
    this.mode      = mode;
    this.localSeat = localSeat;
    this.state     = null;
    this.isHost    = mode === 'solo' || mode === 'hotseat' || mode === 'room-host';

    // Logic hooks (set by setLogic)
    this._init        = null; // (config) → initialState
    this._applyIntent = null; // (state, intent, seat) → { state, error? }
    this._getBotMove  = null; // (state, seat) → intent | null
    this._isOver      = null; // (state) → boolean

    // Bot tick handle
    this._botTimer = null;
    this._botActive = new Set(); // seats currently run by bot

    if (bridge) this._hookBridge();
  }

  /* ── Logic registration ── */
  setLogic({ init, applyIntent, getBotMove, isOver }) {
    this._init        = init;
    this._applyIntent = applyIntent;
    this._getBotMove  = getBotMove || (() => null);
    this._isOver      = isOver || (() => false);
    return this;
  }

  /* ── Start (host / local) ── */
  start(config = {}) {
    if (!this.isHost) throw new Error('GameEngine.start() only allowed on the host.');
    if (!this._init) throw new Error('Call setLogic() before start().');
    this.state = this._init(config);
    this._sync();
    this._tickBots();
    return this;
  }

  /* ── Connect as client ── */
  connectAsClient() {
    if (this.isHost) throw new Error('connectAsClient() only for clients.');
    // Bridge hooks handle snapshot delivery; nothing else to do
    return this;
  }

  /* ── Human sends an intent ── */
  submitIntent(intent) {
    if (this.isHost) {
      this._handleIntent(intent, this.localSeat);
    } else {
      this.bridge?.sendIntent(intent);
    }
  }

  /* ── Host migration: become the new host ── */
  becomeHost(snapshot) {
    this.isHost    = true;
    this.mode      = 'room-host';
    this.state     = snapshot;
    this._sync();
    this._tickBots();
  }

  /* ── Activate / deactivate bot for a seat ── */
  activateBot(seat) {
    this._botActive.add(seat);
    this._tickBots();
  }

  deactivateBot(seat) {
    this._botActive.delete(seat);
  }

  /* ── Internal: apply intent (host only) ── */
  _handleIntent(intent, seat) {
    if (!this.isHost || !this._applyIntent || !this.state) return;
    if (this._isOver(this.state)) return;

    const { state: next, error } = this._applyIntent(
      JSON.parse(JSON.stringify(this.state)), // deep clone — never mutate in place
      intent,
      seat
    );

    if (error) {
      // Reject invalid moves silently (or surface to UI)
      console.warn(`[GameEngine] Intent rejected for seat ${seat}:`, error);
      return;
    }

    this.state = next;
    this._sync();

    if (this._isOver(this.state)) {
      this._stopBots();
    } else {
      this._tickBots();
    }
  }

  /* ── Internal: broadcast full state ── */
  _sync() {
    this.onRender(this.state, this);
    if (this.isHost && this.bridge) {
      this.bridge.broadcastState(this.state);
    }
  }

  /* ── Internal: bot logic (host only) ── */
  _tickBots() {
    clearTimeout(this._botTimer);
    if (!this.isHost || !this._getBotMove || !this.state) return;
    if (this._isOver(this.state)) return;

    const currentSeat = this.state.turn;

    // Is the current seat a bot?
    const isBot = this._botActive.has(currentSeat)
      || this.state.players?.[currentSeat]?.controller === 'ai';

    if (!isBot) return;

    this._botTimer = setTimeout(() => {
      if (!this.state || this._isOver(this.state)) return;
      const intent = this._getBotMove(
        JSON.parse(JSON.stringify(this.state)),
        currentSeat
      );
      if (intent) this._handleIntent(intent, currentSeat);
    }, 700); // deliberate delay so bots feel natural
  }

  _stopBots() {
    clearTimeout(this._botTimer);
    this._botTimer = null;
  }

  /* ── Internal: wire up bridge events ── */
  _hookBridge() {
    const bridge = this.bridge;

    bridge.onMessage = (message) => {
      switch (message.type) {

        // Full state from host → render
        case 'snapshot':
          this.state = message.state;
          this.onRender(this.state, this);
          break;

        // Client move → host validates
        case 'intent':
          if (this.isHost) {
            this._handleIntent(message.intent, message.seat);
          }
          break;

        // Host migration
        case 'host-promoted':
          this.becomeHost(message.snapshot || this.state);
          break;

        // Server says: turn a seat into a bot
        case 'activate-bot':
          if (this.isHost) this.activateBot(message.seat);
          break;

        // Player reconnected — remove their bot
        case 'deactivate-bot':
          if (this.isHost) this.deactivateBot(message.seat);
          break;

        default:
          break;
      }
    };
  }

  destroy() {
    this._stopBots();
    this.bridge?.close();
  }
}

window.GameEngine = GameEngine;

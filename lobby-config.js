/* lobby-config.js
   Shared game-launch config helpers.
   Games read from sessionStorage on boot so refresh/reconnect can reopen
   the same mode instead of silently dropping back to solo mode.
*/
const CGC_LOBBY_CONFIG_KEY = 'cgc_lobby_config';
const CGC_ACTIVE_ROOM_KEY = 'cgc_active_room_session';
const CGC_ROOM_TTL_MS = 1000 * 60 * 60 * 12;

const CGC_DEFAULTS = {
  sevens: { defaultCode:'SEVENS-1', defaultNames:['Player 1','Player 2','Player 3'] },
  ftt:    { defaultCode:'FTT-1',    defaultNames:['Player 1','Player 2','Player 3'] },
  beggar: { defaultCode:'BEGGAR-1', defaultNames:['Player 1','Player 2'] }
};

function readStoredJson(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredJson(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function normalizePreferredSeat(value) {
  const seat = Number(value);
  return Number.isInteger(seat) ? seat : null;
}

function deriveControllers(mode, numPlayers, preferredSeat = null) {
  const seat = normalizePreferredSeat(preferredSeat);

  if (mode === 'semi') {
    return ['local', 'local', 'ai'].slice(0, numPlayers);
  }
  if (mode === 'solo') {
    return ['local', ...Array(Math.max(0, numPlayers - 1)).fill('ai')];
  }
  if (mode === 'hotseat') {
    return Array(numPlayers).fill('local');
  }
  if (mode === 'room-host') {
    return ['local', ...Array(Math.max(0, numPlayers - 1)).fill('remote')];
  }
  if (mode === 'room-join') {
    const localSeat = seat !== null ? Math.max(0, Math.min(numPlayers - 1, seat)) : Math.min(1, numPlayers - 1);
    return Array.from({ length: numPlayers }, (_, index) => index === localSeat ? 'local' : 'remote');
  }
  return ['local', ...Array(Math.max(0, numPlayers - 1)).fill('ai')];
}

function normalizeNames(names, defaults, numPlayers, playerName, preferredSeat) {
  const base = Array.isArray(names) ? names.slice(0, numPlayers) : defaults.slice(0, numPlayers);
  while (base.length < numPlayers) base.push(defaults[base.length] || `Player ${base.length + 1}`);
  if (playerName) {
    const seat = normalizePreferredSeat(preferredSeat);
    if (seat !== null && seat >= 0 && seat < base.length) {
      base[seat] = playerName;
    }
  }
  return base;
}

function normalizeConfig(rawCfg, gameKey, numPlayers) {
  const def = CGC_DEFAULTS[gameKey] || CGC_DEFAULTS.sevens;
  const mode = rawCfg?.mode || 'solo';
  const preferredSeat = normalizePreferredSeat(rawCfg?.preferredSeat);
  const controllers = Array.isArray(rawCfg?.controllers)
    ? rawCfg.controllers.slice(0, numPlayers)
    : deriveControllers(mode, numPlayers, preferredSeat);
  const names = normalizeNames(rawCfg?.names, def.defaultNames, numPlayers, rawCfg?.playerName, preferredSeat);

  return {
    game: gameKey,
    mode,
    roomCode: String(rawCfg?.roomCode || def.defaultCode).trim().toUpperCase() || def.defaultCode,
    names,
    controllers,
    playerName: rawCfg?.playerName || '',
    preferredSeat
  };
}

function getLobbyConfig(gameKey, numPlayers) {
  const def = CGC_DEFAULTS[gameKey] || CGC_DEFAULTS.sevens;
  const storedCfg = readStoredJson(CGC_LOBBY_CONFIG_KEY);
  if (storedCfg?.game === gameKey) {
    return normalizeConfig(storedCfg, gameKey, numPlayers);
  }

  const roomSession = readStoredJson(CGC_ACTIVE_ROOM_KEY);
  if (roomSession?.game === gameKey && (Date.now() - Number(roomSession.savedAt || 0)) <= CGC_ROOM_TTL_MS) {
    return normalizeConfig(roomSession, gameKey, numPlayers);
  }

  // Direct navigation fallback: solo mode
  return {
    game: gameKey,
    mode: 'solo',
    roomCode: def.defaultCode,
    names: def.defaultNames.slice(0, numPlayers),
    controllers: deriveControllers('solo', numPlayers),
    playerName: '',
    preferredSeat: 0
  };
}

/* Map lobby controller strings to what the game JS expects. */
function resolveControllers(cfg) {
  if (!cfg) return [];
  if (cfg.mode === 'semi') return deriveControllers('semi', cfg.names?.length || 3, cfg.preferredSeat);
  if (Array.isArray(cfg.controllers)) return cfg.controllers;
  return deriveControllers(cfg.mode || 'solo', cfg.names?.length || 3, cfg.preferredSeat);
}

function resolveMode(cfg) {
  return cfg?.mode || 'solo';
}

function persistLobbyConfig(cfg) {
  if (!cfg?.game) return;
  writeStoredJson(CGC_LOBBY_CONFIG_KEY, cfg);
}

window.getLobbyConfig = getLobbyConfig;
window.persistLobbyConfig = persistLobbyConfig;
window.resolveControllers = resolveControllers;
window.resolveMode = resolveMode;

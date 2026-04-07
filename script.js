
const suits = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];
const suitSymbols = { Clubs: 'C', Diamonds: 'D', Hearts: 'H', Spades: 'S' };
const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const highRanks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const gameData = {
  sevens: {
    title: 'Sevens',
    subtitle: 'Board-building race',
    players: '3 players',
    mode: 'Playable now',
    description: 'Start from the sevens and build each suit line outward. The first player to empty their hand wins.',
    bullets: [
      'Only the next adjacent rank can be placed onto a started suit lane.',
      'If a player has no legal move, the turn automatically skips.',
      'This browser version includes two CPU opponents.'
    ]
  },
  fivethreetwo: {
    title: 'Five-Three-Two',
    subtitle: 'Quota-driven trick taking',
    players: '3 players',
    mode: 'Playable now',
    description: 'Use a 30-card deck, follow suit, and try to meet your rotating quota without overshooting too hard.',
    bullets: [
      'Three players each receive ten cards from a reduced 6-to-A deck.',
      'After a round, quotas rotate and excess tricks become penalties.',
      'This version tracks scores across rounds until someone reaches 3 points.'
    ]
  },
  beggar: {
    title: 'Beggar-Moneylender',
    subtitle: 'Fast pile capture loop',
    players: '2 players',
    mode: 'Playable now',
    description: 'Flip the top card of your hand into the pile. If its rank already exists there, you take the pile and refill your hand from reserve.',
    bullets: [
      'Each player has a hand and a reserve stack.',
      'Matching any prior rank captures the whole center pile.',
      'The last player with cards left wins the match.'
    ]
  }
};

const detailPanel = document.getElementById('game-detail');
const gameCards = [...document.querySelectorAll('.game-card')];
const tabButtons = [...document.querySelectorAll('.tab-button')];
const screens = [...document.querySelectorAll('.play-screen')];
let activeTab = 'sevens';

function renderGameDetails(gameKey) {
  const game = gameData[gameKey];
  detailPanel.innerHTML = `
    <div class="detail-meta">
      <span>${game.players}</span>
      <span>${game.mode}</span>
      <span>${game.subtitle}</span>
    </div>
    <h4>${game.title}</h4>
    <p>${game.description}</p>
    <ul class="detail-list">
      ${game.bullets.map((item) => `<li>${item}</li>`).join('')}
    </ul>
  `;
  gameCards.forEach((card) => card.classList.toggle('active', card.dataset.game === gameKey));
}

for (const button of document.querySelectorAll('[data-select-game]')) {
  button.addEventListener('click', () => {
    const game = button.dataset.selectGame;
    renderGameDetails(game);
    setActiveTab(game);
    document.getElementById('playable').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function setActiveTab(tab) {
  activeTab = tab;
  tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  screens.forEach((screen) => screen.classList.toggle('active', screen.dataset.screen === tab));
}

for (const button of tabButtons) {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createDeck(ranks = rankOrder) {
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank, key: `${rank}-${suit}` });
    }
  }
  return deck;
}

function rankValue(rank, order = rankOrder) {
  return order.indexOf(rank);
}

function cardLabel(card) {
  return `${card.rank}${suitSymbols[card.suit]}`;
}

function sortCards(cards, order = rankOrder) {
  return [...cards].sort((a, b) => {
    if (a.suit === b.suit) return rankValue(a.rank, order) - rankValue(b.rank, order);
    return suits.indexOf(a.suit) - suits.indexOf(b.suit);
  });
}

function renderCard(card, disabled = false) {
  return `
    <div class="playing-card ${disabled ? 'disabled' : ''}">
      <button ${disabled ? 'disabled' : ''} data-card="${card.key}">
        <span class="card-rank">${card.rank}</span>
        <span class="card-suit">${suitSymbols[card.suit]}</span>
        <span class="card-name">${card.suit}</span>
      </button>
    </div>
  `;
}
const sevens = {
  players: [],
  board: {},
  turn: 0,
  over: false,
  status: ''
};

function initSevens() {
  const deck = shuffle(createDeck());
  sevens.players = [
    { name: 'You', hand: [] },
    { name: 'CPU East', hand: [] },
    { name: 'CPU West', hand: [] }
  ];
  sevens.board = Object.fromEntries(suits.map((suit) => [suit, []]));
  sevens.turn = 0;
  sevens.over = false;
  sevens.status = 'Find a legal extension and empty your hand before the CPUs do.';

  deck.forEach((card, index) => sevens.players[index % 3].hand.push(card));
  sevens.players.forEach((player) => {
    player.hand = sortCards(player.hand);
  });
  const starter = sevens.players.findIndex((player) => player.hand.some((card) => card.rank === '7' && card.suit === 'Hearts'));
  sevens.turn = starter >= 0 ? starter : 0;
  renderSevens();
  processSevensAI();
}

function sevensLaneCanPlace(lane, card) {
  if (!lane.length) return card.rank === '7';
  const values = lane.map((entry) => rankValue(entry.rank));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const current = rankValue(card.rank);
  return current === low - 1 || current === high + 1;
}

function legalSevensCards(player) {
  return player.hand.filter((card) => sevensLaneCanPlace(sevens.board[card.suit], card));
}

function playSevensCard(index) {
  if (sevens.over || sevens.turn !== 0) return;
  const player = sevens.players[0];
  const card = player.hand[index];
  if (!card || !sevensLaneCanPlace(sevens.board[card.suit], card)) {
    sevens.status = 'That card cannot be played onto its suit lane right now.';
    renderSevens();
    return;
  }
  player.hand.splice(index, 1);
  sevens.board[card.suit].push(card);
  sevens.board[card.suit] = sortCards(sevens.board[card.suit]);
  if (!player.hand.length) {
    sevens.over = true;
    sevens.status = 'You win Sevens.';
    renderSevens();
    return;
  }
  advanceSevensTurn();
  renderSevens();
  processSevensAI();
}

function advanceSevensTurn() {
  let loops = 0;
  do {
    sevens.turn = (sevens.turn + 1) % sevens.players.length;
    const player = sevens.players[sevens.turn];
    const legal = legalSevensCards(player);
    if (legal.length) {
      sevens.status = `${player.name} has the turn.`;
      return;
    }
    sevens.status = `${player.name} had no legal move and was skipped.`;
    loops += 1;
    if (loops > sevens.players.length) break;
  } while (true);
}

function processSevensAI() {
  while (!sevens.over && sevens.turn !== 0) {
    const player = sevens.players[sevens.turn];
    const legal = legalSevensCards(player);
    if (!legal.length) {
      advanceSevensTurn();
      renderSevens();
      continue;
    }
    const nonSevens = legal.filter((card) => card.rank !== '7');
    const chosen = nonSevens[0] || legal[0];
    const index = player.hand.findIndex((card) => card.key === chosen.key);
    player.hand.splice(index, 1);
    sevens.board[chosen.suit].push(chosen);
    sevens.board[chosen.suit] = sortCards(sevens.board[chosen.suit]);
    if (!player.hand.length) {
      sevens.over = true;
      sevens.status = `${player.name} wins Sevens.`;
      renderSevens();
      return;
    }
    advanceSevensTurn();
    renderSevens();
  }
}

function renderSevens() {
  document.getElementById('sevens-turn').textContent = sevens.over ? 'Finished' : `${sevens.players[sevens.turn].name} turn`;
  document.getElementById('sevens-status').textContent = sevens.status;
  const board = document.getElementById('sevens-board');
  board.innerHTML = suits.map((suit) => `
    <div class="suit-lane">
      <h5>${suit}</h5>
      <div class="lane-cards">
        ${(sevens.board[suit].length ? sevens.board[suit] : [{ rank: '...', suit }]).map((card) => card.rank === '...' ? `<div class="pile-card"><span class="card-rank">...</span><span class="card-suit">${suitSymbols[suit]}</span></div>` : `<div class="pile-card"><span class="card-rank">${card.rank}</span><span class="card-suit">${suitSymbols[card.suit]}</span></div>`).join('')}
      </div>
    </div>
  `).join('');

  const hand = document.getElementById('sevens-hand');
  const legalKeys = new Set(legalSevensCards(sevens.players[0]).map((card) => card.key));
  hand.innerHTML = sevens.players[0].hand.map((card) => renderCard(card, sevens.turn !== 0 || !legalKeys.has(card.key))).join('');
  [...hand.querySelectorAll('button[data-card]')].forEach((button) => {
    button.addEventListener('click', () => {
      const index = sevens.players[0].hand.findIndex((card) => card.key === button.dataset.card);
      playSevensCard(index);
    });
  });

  document.getElementById('sevens-opponents').innerHTML = sevens.players.slice(1).map((player) => `
    <div class="opponent-card">
      <strong>${player.name}</strong>
      <span>${player.hand.length} cards left</span>
    </div>
  `).join('');
}
const ftt = {
  players: [],
  turn: 0,
  leader: 0,
  roundOffset: 0,
  trump: null,
  currentTrick: [],
  trickPlayers: [],
  tricksWon: [0, 0, 0],
  scores: [0, 0, 0],
  over: false,
  status: ''
};

function getQuota(index) {
  return [5, 3, 2][(index + ftt.roundOffset) % 3];
}

function initFiveThreeTwo(fullReset = true) {
  if (fullReset) {
    ftt.roundOffset = 0;
    ftt.scores = [0, 0, 0];
    ftt.over = false;
  }
  const deck = shuffle(createDeck(highRanks));
  ftt.players = [
    { name: 'You', hand: [] },
    { name: 'CPU North', hand: [] },
    { name: 'CPU South', hand: [] }
  ];
  deck.forEach((card, index) => ftt.players[index % 3].hand.push(card));
  ftt.players.forEach((player) => player.hand = sortCards(player.hand, highRanks));
  ftt.turn = 0;
  ftt.leader = 0;
  ftt.currentTrick = [];
  ftt.trickPlayers = [];
  ftt.tricksWon = [0, 0, 0];
  ftt.trump = suits[Math.floor(Math.random() * suits.length)];
  ftt.status = `Trump suit is ${ftt.trump}. Hit your quota without overcommitting.`;
  renderFiveThreeTwo();
  processFiveThreeTwoAI();
}

function legalFTTCards(player) {
  if (!ftt.currentTrick.length) return [...player.hand];
  const leadSuit = ftt.currentTrick[0].card.suit;
  const sameSuit = player.hand.filter((card) => card.suit === leadSuit);
  return sameSuit.length ? sameSuit : [...player.hand];
}

function fttCardBeats(challenger, current, leadSuit) {
  const challengerTrump = challenger.suit === ftt.trump;
  const currentTrump = current.suit === ftt.trump;
  if (challengerTrump && !currentTrump) return true;
  if (!challengerTrump && currentTrump) return false;
  if (challenger.suit === current.suit) return rankValue(challenger.rank, highRanks) > rankValue(current.rank, highRanks);
  if (challenger.suit === leadSuit && current.suit !== leadSuit) return true;
  return false;
}

function resolveFTTTrick() {
  const leadSuit = ftt.currentTrick[0].card.suit;
  let winner = 0;
  for (let i = 1; i < ftt.currentTrick.length; i += 1) {
    if (fttCardBeats(ftt.currentTrick[i].card, ftt.currentTrick[winner].card, leadSuit)) winner = i;
  }
  const winnerSeat = ftt.trickPlayers[winner];
  ftt.tricksWon[winnerSeat] += 1;
  ftt.status = `${ftt.players[winnerSeat].name} wins the trick.`;
  ftt.currentTrick = [];
  ftt.trickPlayers = [];
  ftt.turn = winnerSeat;
  ftt.leader = winnerSeat;

  const roundOver = ftt.players.every((player) => player.hand.length === 0);
  if (roundOver) resolveFTTRound();
}

function resolveFTTRound() {
  const winners = [];
  ftt.players.forEach((player, index) => {
    const quota = getQuota(index);
    if (ftt.tricksWon[index] === quota) winners.push(index);
  });
  if (!winners.length) {
    const closest = [...ftt.tricksWon].map((won, index) => ({ index, diff: Math.abs(getQuota(index) - won) }))
      .sort((a, b) => a.diff - b.diff)[0];
    winners.push(closest.index);
  }
  winners.forEach((index) => { ftt.scores[index] += 1; });

  const champion = ftt.scores.findIndex((score) => score >= 3);
  if (champion >= 0) {
    ftt.over = true;
    ftt.status = `${ftt.players[champion].name} wins the Five-Three-Two match.`;
    renderFiveThreeTwo();
    return;
  }

  ftt.roundOffset = (ftt.roundOffset + 1) % 3;
  initFiveThreeTwo(false);
}

function playFTTCard(index) {
  if (ftt.over || ftt.turn !== 0) return;
  const player = ftt.players[0];
  const legal = legalFTTCards(player);
  const card = player.hand[index];
  if (!card || !legal.some((item) => item.key === card.key)) {
    ftt.status = 'You must follow suit if you can.';
    renderFiveThreeTwo();
    return;
  }
  player.hand.splice(index, 1);
  ftt.currentTrick.push({ seat: 0, card });
  ftt.trickPlayers.push(0);
  ftt.turn = 1;
  if (ftt.currentTrick.length === 3) resolveFTTTrick();
  renderFiveThreeTwo();
  processFiveThreeTwoAI();
}

function chooseAIFTTCard(player, seat) {
  const legal = legalFTTCards(player);
  if (!ftt.currentTrick.length) return legal[0];
  const leadSuit = ftt.currentTrick[0].card.suit;
  const currentBest = ftt.currentTrick.reduce((best, entry) => fttCardBeats(entry.card, best.card, leadSuit) ? entry : best, ftt.currentTrick[0]);
  const winningCandidates = legal.filter((card) => fttCardBeats(card, currentBest.card, leadSuit));
  const quota = getQuota(seat);
  if (ftt.tricksWon[seat] >= quota && legal.length > 1) return sortCards(legal, highRanks)[0];
  return winningCandidates[0] || sortCards(legal, highRanks)[0];
}

function processFiveThreeTwoAI() {
  while (!ftt.over && ftt.turn !== 0) {
    const seat = ftt.turn;
    const player = ftt.players[seat];
    const card = chooseAIFTTCard(player, seat);
    const index = player.hand.findIndex((entry) => entry.key === card.key);
    player.hand.splice(index, 1);
    ftt.currentTrick.push({ seat, card });
    ftt.trickPlayers.push(seat);
    ftt.turn = (ftt.turn + 1) % 3;
    if (ftt.currentTrick.length === 3) resolveFTTTrick();
    renderFiveThreeTwo();
  }
}

function renderFiveThreeTwo() {
  document.getElementById('ftt-turn').textContent = ftt.over ? 'Finished' : `${ftt.players[ftt.turn].name} turn`;
  document.getElementById('ftt-status').textContent = ftt.status;
  document.getElementById('ftt-quotas').innerHTML = ftt.players.map((player, index) => `
    <div class="quota-card">
      <strong>${player.name}</strong>
      <span>Quota ${getQuota(index)} | Tricks ${ftt.tricksWon[index]} | Score ${ftt.scores[index]}</span>
    </div>
  `).join('');
  document.getElementById('ftt-trick').innerHTML = ftt.currentTrick.length
    ? ftt.currentTrick.map((entry) => `<div class="trick-card"><span class="card-rank">${entry.card.rank}</span><span class="card-suit">${suitSymbols[entry.card.suit]}</span><span class="card-name">${ftt.players[entry.seat].name}</span></div>`).join('')
    : `<div class="metric-box">Trump: ${ftt.trump}. The next lead decides the suit to follow.</div>`;

  const hand = document.getElementById('ftt-hand');
  const legal = new Set(legalFTTCards(ftt.players[0]).map((card) => card.key));
  hand.innerHTML = ftt.players[0].hand.map((card) => renderCard(card, ftt.turn !== 0 || !legal.has(card.key))).join('');
  [...hand.querySelectorAll('button[data-card]')].forEach((button) => {
    button.addEventListener('click', () => {
      const index = ftt.players[0].hand.findIndex((card) => card.key === button.dataset.card);
      playFTTCard(index);
    });
  });

  document.getElementById('ftt-opponents').innerHTML = ftt.players.slice(1).map((player, idx) => `
    <div class="opponent-card">
      <strong>${player.name}</strong>
      <span>${player.hand.length} cards left</span>
      <span>Quota ${getQuota(idx + 1)} | Score ${ftt.scores[idx + 1]}</span>
    </div>
  `).join('');
}
const beggar = {
  players: [],
  centralPile: [],
  turn: 0,
  over: false,
  status: ''
};

function refillBeggarHand(player) {
  while (player.hand.length < 4 && player.reserve.length) {
    player.hand.push(player.reserve.pop());
  }
  if (!player.hand.length && !player.reserve.length) player.eliminated = true;
}

function initBeggar() {
  const deck = shuffle(createDeck());
  beggar.players = [
    { name: 'You', hand: [], reserve: [], eliminated: false },
    { name: 'CPU Dealer', hand: [], reserve: [], eliminated: false }
  ];
  beggar.centralPile = [];
  beggar.turn = 0;
  beggar.over = false;
  beggar.status = 'Flip the top card from your hand. A repeated rank captures the pile.';

  deck.forEach((card, index) => {
    const target = beggar.players[index % 2];
    if ((index % 4) < 2) target.hand.push(card); else target.reserve.push(card);
  });
  beggar.players.forEach(refillBeggarHand);
  renderBeggar();
  processBeggarAI();
}

function captureBeggarPile(player) {
  player.reserve.unshift(...beggar.centralPile);
  beggar.centralPile = [];
  refillBeggarHand(player);
}

function checkBeggarMatch(card) {
  return beggar.centralPile.slice(0, -1).some((entry) => entry.rank === card.rank);
}

function advanceBeggarTurn() {
  beggar.turn = (beggar.turn + 1) % beggar.players.length;
  if (beggar.players[beggar.turn].eliminated && !beggar.over) advanceBeggarTurn();
}

function maybeEndBeggar() {
  const alive = beggar.players.filter((player) => !player.eliminated);
  if (alive.length === 1) {
    beggar.over = true;
    beggar.status = `${alive[0].name} wins Beggar-Moneylender.`;
    return true;
  }
  return false;
}

function doBeggarTurn(playerIndex) {
  const player = beggar.players[playerIndex];
  if (!player.hand.length) refillBeggarHand(player);
  if (!player.hand.length) {
    player.eliminated = true;
    if (maybeEndBeggar()) return;
    advanceBeggarTurn();
    return;
  }
  const card = player.hand.pop();
  beggar.centralPile.push(card);
  if (checkBeggarMatch(card)) {
    captureBeggarPile(player);
    beggar.status = `${player.name} matched ${card.rank} and captured the pile.`;
  } else {
    refillBeggarHand(player);
    beggar.status = `${player.name} flipped ${cardLabel(card)}.`;
  }
  maybeEndBeggar();
  if (!beggar.over) advanceBeggarTurn();
}

function playerBeggarFlip() {
  if (beggar.over || beggar.turn !== 0) return;
  doBeggarTurn(0);
  renderBeggar();
  processBeggarAI();
}

function processBeggarAI() {
  while (!beggar.over && beggar.turn !== 0) {
    doBeggarTurn(beggar.turn);
    renderBeggar();
  }
}

function renderBeggar() {
  document.getElementById('beggar-turn').textContent = beggar.over ? 'Finished' : `${beggar.players[beggar.turn].name} turn`;
  document.getElementById('beggar-status').textContent = beggar.status;
  document.getElementById('beggar-pile').innerHTML = beggar.centralPile.length
    ? beggar.centralPile.map((card) => `<div class="pile-card"><span class="card-rank">${card.rank}</span><span class="card-suit">${suitSymbols[card.suit]}</span></div>`).join('')
    : `<div class="metric-box">The central pile is empty.</div>`;
  document.getElementById('beggar-player-meta').innerHTML = `
    <div class="metric-box">Hand: ${beggar.players[0].hand.length} cards</div>
    <div class="metric-box">Reserve: ${beggar.players[0].reserve.length} cards</div>
  `;
  document.getElementById('beggar-opponents').innerHTML = beggar.players.slice(1).map((player) => `
    <div class="opponent-card">
      <strong>${player.name}</strong>
      <span>Hand ${player.hand.length}</span>
      <span>Reserve ${player.reserve.length}</span>
    </div>
  `).join('');
}

document.getElementById('beggar-flip').addEventListener('click', playerBeggarFlip);
document.getElementById('restart-game').addEventListener('click', () => {
  if (activeTab === 'sevens') initSevens();
  if (activeTab === 'fivethreetwo') initFiveThreeTwo(true);
  if (activeTab === 'beggar') initBeggar();
});

renderGameDetails('sevens');
setActiveTab('sevens');
initSevens();
initFiveThreeTwo(true);
initBeggar();

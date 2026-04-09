/**
 * sevens.js — 2-5 player Sevens with:
 *  - GameEngine (host-authoritative)
 *  - Deal button: host deals when ready (not auto)
 *  - Skip button (glows when no legal moves)
 *  - Hotseat guard (P2/P3 see hidden hand until Reveal pressed)
 *  - Fill bots (from lobby or in-game button)
 *  - Proper room-join seat assignment
 */

const SUITS     = ['Clubs','Diamonds','Hearts','Spades'];
const SUIT_CHAR = { Clubs:'♣', Diamonds:'♦', Hearts:'♥', Spades:'♠' };
const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const AVATARS   = ['P1','P2','P3','P4','P5'];
const AV_CLASS  = ['av0','av1','av2','av3','av4'];

/* ════════════════════════════════════════
   PURE GAME LOGIC
════════════════════════════════════════ */
function shuffle(arr) {
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
function rankVal(r)    { return RANKS.indexOf(r); }
function suitCls(s)   { return (s==='Hearts'||s==='Diamonds')?'red-suit':'black-suit'; }
function sortCards(c) { return [...c].sort((a,b)=>a.suit===b.suit?rankVal(a.rank)-rankVal(b.rank):SUITS.indexOf(a.suit)-SUITS.indexOf(b.suit)); }
function createDeck() { return SUITS.flatMap(s=>RANKS.map(r=>({suit:s,rank:r,key:`${r}-${s}`}))); }

function laneCanPlace(lane, card) {
  if(!lane.length) return card.rank==='7';
  const vals=lane.map(c=>rankVal(c.rank));
  const lo=Math.min(...vals),hi=Math.max(...vals),v=rankVal(card.rank);
  return v===lo-1||v===hi+1;
}
function legalMoves(state, seat) {
  return state.players[seat].hand.filter(c=>laneCanPlace(state.board[c.suit],c));
}
function getLaneSlots(board, suit) {
  const lane=board[suit];
  if(!lane.length) return [{rank:'7',suit,empty:true,starter:true}];
  const vals=lane.map(c=>rankVal(c.rank));
  const lo=Math.min(...vals),hi=Math.max(...vals);
  const slots=[];
  for(let i=Math.max(0,lo-1);i<=Math.min(RANKS.length-1,hi+1);i++){
    const rank=RANKS[i],existing=lane.find(c=>c.rank===rank);
    slots.push(existing||{rank,suit,empty:true,playable:i===lo-1||i===hi+1});
  }
  return slots;
}

/* init — called by host after Deal is pressed */
function sevensInit(config) {
  const players=(config.players||[]).map((p,i)=>({
    name:p.name||`Player ${i+1}`,
    controller:p.controller||'ai',
    hand:[],
  }));
  const n=players.length;
  const deck=shuffle(createDeck());
  deck.forEach((card,i)=>players[i%n].hand.push(card));
  players.forEach(p=>{p.hand=sortCards(p.hand);});
  const starter=players.findIndex(p=>p.hand.some(c=>c.rank==='7'&&c.suit==='Hearts'));
  return {
    board:Object.fromEntries(SUITS.map(s=>[s,[]])),
    lastPlacedKey:null,lastAction:null,
    over:false,players,
    status:`${players[starter>=0?starter:0].name} goes first (has 7♥).`,
    turn:starter>=0?starter:0,winner:null,
  };
}

function sevensApplyIntent(state, intent, seat) {
  if(state.turn!==seat) return {state,error:'Not your turn.'};
  if(state.over)        return {state,error:'Game over.'};

  if(intent.type==='skip'){
    if(legalMoves(state,seat).length>0) return {state,error:'You have legal moves.'};
    state.lastAction={seat,type:'skip'};
    state.turn=(state.turn+1)%state.players.length;
    state.status=`${state.players[state.turn].name}'s turn.`;
    return {state};
  }
  if(intent.type==='play'){
    const {cardKey}=intent;
    const player=state.players[seat];
    const idx=player.hand.findIndex(c=>c.key===cardKey);
    if(idx<0) return {state,error:'Card not in hand.'};
    const card=player.hand[idx];
    if(!laneCanPlace(state.board[card.suit],card)) return {state,error:'Cannot place there.'};
    player.hand.splice(idx,1);
    state.lastPlacedKey=card.key;
    state.board[card.suit]=sortCards([...state.board[card.suit],card]);
    state.lastAction={seat,type:'play',cardKey,card};
    if(!player.hand.length){
      state.over=true;state.winner=seat;
      state.status=`${player.name} wins Sevens!`;
      return {state};
    }
    state.turn=(state.turn+1)%state.players.length;
    state.status=`${state.players[state.turn].name}'s turn.`;
    return {state};
  }
  return {state,error:`Unknown intent: ${intent.type}`};
}

function sevensGetBotMove(state, seat) {
  const opts=legalMoves(state,seat);
  if(!opts.length) return {type:'skip'};
  return {type:'play',cardKey:(opts.find(c=>c.rank!=='7')||opts[0]).key};
}

function sevensIsOver(state) { return state.over; }

/* ════════════════════════════════════════
   APP STATE
════════════════════════════════════════ */
const app={engine:null,mode:'solo',localSeat:0,bridge:null,revealedSeat:null,guardSeat:null,dealt:false};
let lobbyCfg=null;

/* DOM */
const modeEl        =document.getElementById('mode');
const roomCodeEl    =document.getElementById('room-code');
const setupStatusEl =document.getElementById('setup-status');
const setupDrawer   =document.getElementById('setup-drawer');
const toggleSetupBtn=document.getElementById('toggle-setup');
const goOverlay     =document.getElementById('gameover-overlay');
const goTitle       =document.getElementById('go-title');
const goMessage     =document.getElementById('go-message');
const statusEl      =document.getElementById('status');
const announceEl    =document.getElementById('announce');
const skipBtn       =document.getElementById('skip-btn');
const dealBtn       =document.getElementById('deal-btn');
const dealBanner    =document.getElementById('deal-banner');
const fillBotsBtn   =document.getElementById('fill-bots-ingame');
const guardEl       =document.getElementById('turn-guard');
const guardTitle    =document.getElementById('turn-guard-title');
const guardCopy     =document.getElementById('turn-guard-copy');
const guardBtn      =document.getElementById('turn-guard-btn');
const chatUI        =window.initGameChat?window.initGameChat():null;

let _annTimer=null;
function announce(msg,dur=2400){
  if(!announceEl)return;
  announceEl.classList.remove('fade');
  announceEl.textContent=msg;
  clearTimeout(_annTimer);
  _annTimer=setTimeout(()=>announceEl.classList.add('fade'),dur);
}

/* ── Shared-device helpers ── */
function isShared() { return app.mode==='hotseat'||app.mode==='semi'; }

function activeSharedSeat(state) {
  if(!state||!isShared()) return null;
  const s=state.turn;
  return state.players[s]?.controller==='local'?s:null;
}
function turnGuardActive(state) {
  if(!state||state.over) return false;
  const s=activeSharedSeat(state);
  return s!==null&&app.revealedSeat!==s;
}
function syncGuardSeat(state) {
  const ns=activeSharedSeat(state);
  if(app.guardSeat!==ns){app.guardSeat=ns;app.revealedSeat=null;}
}

/* ── Seat helpers ── */
function humanSeat(state) {
  if(isShared()&&state) return activeSharedSeat(state)??app.localSeat;
  return app.localSeat;
}

/* ════════════════════════════════════════
   RENDER
════════════════════════════════════════ */
function render(state, engine) {
  if(!state) return;
  syncGuardSeat(state);

  const isHost = engine?.isHost||app.mode!=='room-join';
  const guardOn = turnGuardActive(state);
  const mySeat  = humanSeat(state);
  const myPlayer= state.players[mySeat];

  /* Turn chip */
  document.getElementById('turn-chip').textContent=
    state.over?'🏆 Finished':`${state.players[state.turn].name}'s turn`;

  /* Status */
  statusEl.textContent=state.status;

  /* Announce */
  if(state.lastAction){
    const {seat,type,card}=state.lastAction;
    const n=state.players[seat]?.name||`Seat ${seat}`;
    if(type==='play'&&card) announce(`${n} placed ${card.rank}${SUIT_CHAR[card.suit]} on ${card.suit}`);
    else if(type==='skip')  announce(`${n} skipped — no legal moves`);
  }

  /* Board */
  const myLegal=new Set(legalMoves(state,mySeat).map(c=>c.key));
  document.getElementById('board').innerHTML=SUITS.map(suit=>{
    const slots=getLaneSlots(state.board,suit);
    const cards=slots.map(sl=>{
      if(sl.empty){
        const cls=(sl.playable||sl.starter)?'playable-slot':'';
        return `<div class="card board-card empty-slot ${cls}" aria-hidden="true">
          <span class="c-suit" style="opacity:.28;align-self:center;margin:auto;font-size:1rem">${sl.starter?SUIT_CHAR[suit]:''}</span>
        </div>`;
      }
      return `<div class="card board-card ${suitCls(sl.suit)} ${sl.key===state.lastPlacedKey?'latest-play':''} ${sl.rank==='7'?'highlight':''}"
                   aria-label="${sl.rank} of ${sl.suit}">
        <span class="c-rank">${sl.rank}</span><span class="c-suit">${SUIT_CHAR[sl.suit]}</span>
      </div>`;
    }).join('');
    return `<div><div class="suit-lane-header">${suit} ${SUIT_CHAR[suit]}</div><div class="lane-cards-wrap">${cards}</div></div>`;
  }).join('');

  /* Hand label */
  document.getElementById('hand-title').textContent=
    guardOn?`${myPlayer.name} — hidden hand`:`${myPlayer.name} — ${myPlayer.hand.length} cards`;

  /* Hand cards */
  const handEl=document.getElementById('hand');
  const myTurn=state.turn===mySeat&&!state.over&&!guardOn;
  handEl.classList.toggle('guarded',guardOn);

  if(guardOn){
    handEl.innerHTML=Array.from({length:Math.min(myPlayer.hand.length,8)},()=>'<div class="guard-card"></div>').join('');
  } else {
    handEl.innerHTML=myPlayer.hand.map(card=>{
      const dis=!myTurn||!myLegal.has(card.key);
      return `<div class="card hand-card ${suitCls(card.suit)} ${dis?'disabled':'playable'}"
                   role="button" tabindex="${dis?-1:0}"
                   aria-label="${card.rank} of ${card.suit}" data-card="${card.key}">
        <span class="c-rank">${card.rank}</span><span class="c-suit">${SUIT_CHAR[card.suit]}</span>
      </div>`;
    }).join('');
    handEl.querySelectorAll('[data-card]').forEach(el=>{
      const h=()=>{
        if(el.classList.contains('disabled'))return;
        if(app.mode==='room-join'){
          app.bridge?.sendIntent({type:'play',cardKey:el.dataset.card});
          if(setupStatusEl)setupStatusEl.textContent='Move sent.';
          return;
        }
        engine.submitIntent({type:'play',cardKey:el.dataset.card});
      };
      el.addEventListener('click',h);
      el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();h();}});
    });
  }

  /* Guard overlay */
  if(guardEl){
    guardEl.classList.toggle('hidden',!guardOn);
    if(guardOn){
      guardTitle.textContent=`Pass to ${myPlayer.name}`;
      guardCopy.textContent='When they are ready, press Reveal cards.';
    }
  }

  /* Skip button */
  const canSkip=myTurn&&myLegal.size===0;
  if(skipBtn){
    skipBtn.disabled=!canSkip;
    skipBtn.classList.toggle('skip-glow',canSkip);
    skipBtn.classList.toggle('skip-ready',canSkip);
  }

  /* Player profile */
  document.getElementById('player-profile').innerHTML=`
    <div class="player-avatar ${AV_CLASS[mySeat]||'av0'}">${AVATARS[mySeat]}</div>
    <div>
      <div class="player-name">${myPlayer.name}</div>
      <div class="player-sub">${myPlayer.hand.length} cards left</div>
    </div>`;

  /* Opponent seats — dynamic for 2-5 players */
  _renderOpponents(state,mySeat,engine);

  /* Deal banner */
  if(dealBanner) dealBanner.classList.toggle('hidden',app.dealt||!isHost||state.over);
  if(dealBtn)    dealBtn.classList.toggle('hidden',app.dealt||!isHost||state.over);
  if(fillBotsBtn) {
    const hasRemote=state.players.some(p=>p.controller==='remote');
    fillBotsBtn.classList.toggle('hidden',!isHost||!hasRemote);
  }

  /* Game over */
  if(state.over&&state.winner!=null)
    showGameOver(`${state.players[state.winner].name} wins! 🎉`,`${state.players[state.winner].name} emptied their hand first.`);
}

function _renderOpponents(state, mySeat, engine) {
  const others=state.players.map((p,i)=>({...p,seat:i})).filter(p=>p.seat!==mySeat);
  const slots=['seat-top','seat-left','seat-right','seat-extra1','seat-extra2'];
  // Fill slots round-robin
  slots.forEach((id,idx)=>{
    const el=document.getElementById(id);
    if(!el)return;
    const p=others[idx];
    if(!p){el.innerHTML='';return;}
    const isActive=state.turn===p.seat&&!state.over;
    const isBot=p.controller==='ai';
    const isRemote=p.controller==='remote';
    const backs=Array.from({length:Math.min(p.hand.length,6)},()=>'<div class="seat-mini-card"></div>').join('');
    el.innerHTML=`<div class="seat-badge ${isActive?'active-seat':''} ${isBot&&isActive?'thinking':''}">
      <div class="seat-avatar ${AV_CLASS[p.seat]||'av0'}">${AVATARS[p.seat]}</div>
      <div class="seat-name-label">${p.name}${isBot?' 🤖':isRemote?' 🌐':''}</div>
      <div class="seat-sub-label">${p.hand.length} cards${isBot&&isActive?' · thinking…':''}</div>
      <div class="seat-card-row">${backs}</div>
    </div>`;
  });
}

/* ════════════════════════════════════════
   BUTTON HANDLERS
════════════════════════════════════════ */
skipBtn?.addEventListener('click',()=>{
  if(skipBtn.disabled)return;
  app.engine?.submitIntent({type:'skip'});
});

guardBtn?.addEventListener('click',()=>{
  const s=activeSharedSeat(app.engine?.state);
  if(s===null)return;
  app.revealedSeat=s;
  if(app.engine?.state)render(app.engine.state,app.engine);
});

dealBtn?.addEventListener('click',()=>{
  if(!app.engine?.isHost)return;
  app.dealt=true;
  dealBanner?.classList.add('hidden');
  dealBtn.classList.add('hidden');
  const cfg=_buildPlayersConfig();
  app.engine.start({players:cfg});
});

/* Fill bots in-game */
fillBotsBtn?.addEventListener('click',()=>{
  if(!app.engine?.isHost||!app.engine.state)return;
  app.engine.state.players.forEach((p,seat)=>{
    if(p.controller==='remote'){
      p.controller='ai';
      app.engine.activateBot(seat);
    }
  });
  app.engine._sync();
  if(fillBotsBtn)fillBotsBtn.classList.add('hidden');
});

function showGameOver(title,msg){
  if(goTitle)goTitle.textContent=title;
  if(goMessage)goMessage.textContent=msg;
  goOverlay?.classList.remove('hidden');
}

/* ════════════════════════════════════════
   START
════════════════════════════════════════ */
function startGame(fromLobby=false) {
  if(fromLobby){
    lobbyCfg=getLobbyConfig('sevens',3);
    app.mode=resolveMode(lobbyCfg);
    if(roomCodeEl)roomCodeEl.value=lobbyCfg.roomCode;
    if(modeEl)modeEl.value=app.mode;
  } else {
    lobbyCfg=null;
    app.mode=modeEl?.value||'solo';
  }

  app.dealt=false;
  app.revealedSeat=null;
  app.guardSeat=null;
  goOverlay?.classList.add('hidden');

  app.engine?.destroy();
  app.bridge?.close();
  app.bridge=null;

  const numP = lobbyCfg?.numPlayers||3;
  const rc   = roomCodeEl?.value.trim()||'SEVENS-1';
  const ctrl = lobbyCfg?resolveControllers(lobbyCfg):_defaultControllers(app.mode,numP);
  const names= lobbyCfg?.names||Array.from({length:numP},(_,i)=>`Player ${i+1}`);

  const isHost=app.mode!=='room-join';
  app.localSeat=isHost?0:Math.max(0,ctrl.findIndex(c=>c==='local')||(lobbyCfg?.preferredSeat??1));

  /* Bridge */
  if(app.mode==='room-host'||app.mode==='room-join'){
    app.bridge=new RoomBridge('sevens-room',()=>{},t=>{if(setupStatusEl)setupStatusEl.textContent=t;},{
      maxPlayers:numP,
      preferredSeat:app.localSeat,
    });
    if(app.mode==='room-host') app.bridge.host(rc,0);
    else                        app.bridge.join(rc,app.localSeat);
  }

  chatUI?.setBridge(app.bridge||null);
  chatUI?.setContext({mode:app.mode,roomCode:rc,playerName:names[app.localSeat]||'Player'});

  /* Engine */
  app.engine=new GameEngine({
    gameId:'sevens',bridge:app.bridge,mode:app.mode,
    localSeat:app.localSeat,onRender:render,
  });
  app.engine.setLogic({init:sevensInit,applyIntent:sevensApplyIntent,getBotMove:sevensGetBotMove,isOver:sevensIsOver});

  if(app.bridge){
    app.bridge.onMessage=(msg)=>_handleBridge(msg);
  }

  if(isHost){
    // Show Deal button — do NOT auto-deal
    dealBanner?.classList.remove('hidden');
    dealBtn?.classList.remove('hidden');

    // If lobby said _fillBots, replace remote with ai immediately
    if(lobbyCfg?._fillBots){
      ctrl.forEach((c,i)=>{if(c==='remote'||c==='ai'){ctrl[i]='ai';}});
    }

    // Render a "waiting to deal" state
    statusEl.textContent='Press Deal when all players are ready.';
    document.getElementById('turn-chip').textContent='Waiting to deal…';
    _clearBoard(numP,names,ctrl);

    const msgs={solo:'Solo game ready. Press Deal.',semi:'2P vs CPU. Press Deal.',hotseat:'Hotseat ready. Press Deal.','room-host':`Room ${rc} open. Share the code, then press Deal.`};
    if(setupStatusEl)setupStatusEl.textContent=msgs[app.mode]||'Press Deal when ready.';

  } else {
    statusEl.textContent='Waiting for host to deal…';
    document.getElementById('turn-chip').textContent='Waiting…';
    ['hand','board','seat-top','seat-left','seat-right','seat-extra1','seat-extra2','player-profile'].forEach(id=>{
      const el=document.getElementById(id);if(el)el.innerHTML='';
    });
  }

  setupDrawer?.classList.remove('open');
  setupDrawer?.setAttribute('aria-hidden','true');
  toggleSetupBtn?.setAttribute('aria-expanded','false');
}

function _buildPlayersConfig(){
  const numP=lobbyCfg?.numPlayers||3;
  const ctrl=lobbyCfg?resolveControllers(lobbyCfg):_defaultControllers(app.mode,numP);
  const names=lobbyCfg?.names||Array.from({length:numP},(_,i)=>`Player ${i+1}`);
  // Apply in-game remote overrides from actual connected state
  if(app.engine?.state){
    app.engine.state.players.forEach((p,i)=>{
      if(p.controller) ctrl[i]=p.controller;
      if(p.name)       names[i]=p.name;
    });
  }
  return Array.from({length:numP},(_,i)=>({
    name:names[i]||`Player ${i+1}`,
    controller:ctrl[i]||'ai',
  }));
}

function _clearBoard(numP,names,ctrl){
  /* Render placeholder board with empty lanes + seat badges while waiting */
  document.getElementById('board').innerHTML=SUITS.map(suit=>
    `<div><div class="suit-lane-header">${suit} ${SUIT_CHAR[suit]}</div>
    <div class="lane-cards-wrap"><div class="card board-card empty-slot playable-slot" aria-hidden="true">
      <span class="c-suit" style="opacity:.28;align-self:center;margin:auto;font-size:1rem">${SUIT_CHAR[suit]}</span>
    </div></div></div>`
  ).join('');

  document.getElementById('hand').innerHTML='';
  document.getElementById('hand-title').textContent='Waiting for deal…';

  document.getElementById('player-profile').innerHTML=`
    <div class="player-avatar ${AV_CLASS[app.localSeat]||'av0'}">${AVATARS[app.localSeat]}</div>
    <div><div class="player-name">${names[app.localSeat]||`Player ${app.localSeat+1}`}</div>
    <div class="player-sub">—</div></div>`;
}

function _defaultControllers(mode,n){
  if(mode==='solo')      return Array.from({length:n},(_,i)=>i===0?'local':'ai');
  if(mode==='semi')      return ['local','local','ai'].slice(0,n);
  if(mode==='hotseat')   return Array(n).fill('local');
  if(mode==='room-host') return Array.from({length:n},(_,i)=>i===0?'local':'remote');
  if(mode==='room-join') return Array.from({length:n},(_,i)=>i===1?'local':'remote');
  return Array.from({length:n},(_,i)=>i===0?'local':'ai');
}

/* ── Bridge message handler ── */
function _handleBridge(message){
  const engine=app.engine;
  if(!engine)return;
  switch(message.type){
    case 'seat-assigned':
      if(typeof message.seat==='number'){app.localSeat=message.seat;engine.localSeat=message.seat;}
      break;
    case 'snapshot':
      app.dealt=true;
      engine.state=message.state;
      render(engine.state,engine);
      if(setupStatusEl)setupStatusEl.textContent='Connected.';
      break;
    case 'intent':
      if(engine.isHost)engine._handleIntent(message.intent,message.seat);
      break;
    case 'host-promoted':
      app.mode='room-host';
      if(typeof message.seat==='number'){app.localSeat=message.seat;engine.localSeat=message.seat;}
      engine.becomeHost(message.snapshot||engine.state);
      if(setupStatusEl)setupStatusEl.textContent=message.message||'You are now the host.';
      break;
    case 'activate-bot':
      if(engine.isHost&&engine.state?.players?.[message.seat]){
        engine.state.players[message.seat].controller='ai';
        engine.activateBot(message.seat);
        engine._sync();
      }
      break;
    case 'deactivate-bot':
      if(engine.isHost&&engine.state?.players?.[message.seat]){
        engine.state.players[message.seat].controller=message.seat===app.localSeat?'local':'remote';
        engine.deactivateBot(message.seat);
        engine._sync();
      }
      break;
    case 'join':
      if(engine.isHost&&engine.state&&typeof message.seat==='number'){
        if(message.name&&engine.state.players[message.seat]){
          engine.state.players[message.seat].name=message.name;
          engine.state.players[message.seat].controller='remote';
          engine._sync();
        }
        if(setupStatusEl)setupStatusEl.textContent=`${message.name||'Player'} joined seat ${message.seat+1}.`;
      }
      break;
    case 'leave':
      if(setupStatusEl)setupStatusEl.textContent=`${message.name||'Player'} disconnected.`;
      break;
    case 'room-closed':
      ['hand','board','seat-top','seat-left','seat-right','seat-extra1','seat-extra2','player-profile'].forEach(id=>{
        const el=document.getElementById(id);if(el)el.innerHTML='';
      });
      if(statusEl)statusEl.textContent=message.message||'Room closed.';
      if(setupStatusEl)setupStatusEl.textContent=message.message||'Room closed.';
      break;
    case 'join-error':
      if(statusEl)statusEl.textContent=message.message||'Could not join.';
      if(setupStatusEl)setupStatusEl.textContent=message.message||'Could not join.';
      break;
    default: break;
  }
}

/* UI */
document.getElementById('start-btn')?.addEventListener('click',()=>startGame(false));
document.getElementById('go-restart')?.addEventListener('click',()=>startGame(false));
toggleSetupBtn?.addEventListener('click',()=>{
  const o=setupDrawer.classList.contains('open');
  setupDrawer.classList.toggle('open',!o);
  setupDrawer.setAttribute('aria-hidden',String(o));
  toggleSetupBtn.setAttribute('aria-expanded',String(!o));
});

startGame(true);

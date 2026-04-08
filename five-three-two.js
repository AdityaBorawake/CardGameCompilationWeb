/* FIVE-THREE-TWO
   Trump selection rule:
   - Player with quota-5 (the "caller") picks trump
   - They see their first 5 cards privately
   - They may either: (a) name any suit as trump, OR
     (b) request 2 extra cards from the deck be flipped face-up for ALL to see
       → if they request extras, they MUST pick trump from one of the 2 exposed cards' suits
   - After trump chosen, remaining 5 cards dealt, play begins
*/
const SUITS=['Clubs','Diamonds','Hearts','Spades'];
const SUIT_CHAR={Clubs:'♣',Diamonds:'♦',Hearts:'♥',Spades:'♠'};
const RANKS=['6','7','8','9','10','J','Q','K','A'];
const DEFAULT_NAMES=['Player 1','Player 2','Player 3'];
const AVATARS=['P1','P2','P3'];

const app={mode:'solo',localSeat:0,bridge:null,state:null,busy:false,guardSeat:null,revealedSeat:null};
let pendingNextRound=null;
const ROOM_WORDS=['AMBER','COMET','FABLE','FJORD','LUNAR','MAPLE','NOVA','RAVEN','SOLAR','TIGER','VELVET','WILLOW'];

const modeEl        =document.getElementById('mode');
const roomCodeEl    =document.getElementById('room-code');
const setupStatusEl =document.getElementById('setup-status');
const setupDrawer   =document.getElementById('setup-drawer');
const toggleSetupBtn=document.getElementById('toggle-setup');
const goOverlay     =document.getElementById('gameover-overlay');
const goTitle       =document.getElementById('go-title');
const goMessage     =document.getElementById('go-message');
const roundOverlay  =document.getElementById('round-overlay');
const roundHeadline =document.getElementById('round-headline');
const roundEyebrow  =document.getElementById('round-eyebrow');
const roundResults  =document.getElementById('round-results');
const roundContinue =document.getElementById('round-continue');
const statusEl      =document.getElementById('status');
const announceEl    =document.getElementById('announce');
const trumpModal    =document.getElementById('trump-modal');
const newRoomCodeBtn=document.getElementById('new-room-code');
const guardEl       =document.getElementById('turn-guard');
const guardTitleEl  =document.getElementById('turn-guard-title');
const guardCopyEl   =document.getElementById('turn-guard-copy');
const guardBtn      =document.getElementById('turn-guard-btn');
const chatUI        =window.initGameChat?window.initGameChat():null;
let lobbyCfg=null;

/* ── Helpers ── */
function shuffle(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function rankVal(r){return RANKS.indexOf(r);}
function suitClass(s){return(s==='Hearts'||s==='Diamonds')?'red-suit':'black-suit';}
function sortCards(cards){return[...cards].sort((a,b)=>a.suit===b.suit?rankVal(a.rank)-rankVal(b.rank):SUITS.indexOf(a.suit)-SUITS.indexOf(b.suit));}
function createDeck(){return SUITS.flatMap(s=>RANKS.map(r=>({suit:s,rank:r,key:`${r}-${s}`})));}
function quota(i,ro){return[5,3,2][(i+ro)%3];}
function randomTail(length=3){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from({length},()=>chars[Math.floor(Math.random()*chars.length)]).join('');}
function makeRoomCode(){const first=ROOM_WORDS[Math.floor(Math.random()*ROOM_WORDS.length)];let second=ROOM_WORDS[Math.floor(Math.random()*ROOM_WORDS.length)];if(second===first)second=ROOM_WORDS[(ROOM_WORDS.indexOf(first)+5)%ROOM_WORDS.length];return`${first}-${second}-${randomTail(3)}`;}
function isSharedDeviceMode(){return app.mode==='hotseat'||app.mode==='semi';}
function activeSharedSeat(state=app.state){
  if(!state||!isSharedDeviceMode())return null;
  if(state.phase==='trump-select'){
    return state.players?.[state.caller]?.controller==='local'?state.caller:null;
  }
  return state.players?.[state.turn]?.controller==='local'?state.turn:null;
}
function currentHumanSeat(){return activeSharedSeat(app.state)??app.localSeat;}
function syncTurnGuard(state=app.state){
  const nextSeat=activeSharedSeat(state);
  if(app.guardSeat!==nextSeat){app.guardSeat=nextSeat;app.revealedSeat=null;}
}
function turnGuardActive(state=app.state){
  if(!state||state.over)return false;
  const seat=activeSharedSeat(state);
  return seat!==null&&app.revealedSeat!==seat;
}
function renderGuardCards(count){return Array.from({length:Math.max(1,Math.min(count,8))},()=>'<div class="guard-card" aria-hidden="true"></div>').join('');}
function configuredLocalSeat(fallback=app.localSeat){
  const preferredSeat=Number(lobbyCfg?.preferredSeat);
  if(Number.isInteger(preferredSeat))return preferredSeat;
  const controllers=lobbyCfg?.controllers;
  if(Array.isArray(controllers)){
    const seat=controllers.findIndex(controller=>controller==='local');
    if(seat>=0)return seat;
  }else if(controllers&&typeof controllers==='object'){
    const match=Object.entries(controllers).find(([,controller])=>controller==='local');
    if(match){
      const seat=Number(match[0]);
      if(Number.isInteger(seat))return seat;
    }
  }
  return Number.isInteger(fallback)?fallback:0;
}
function currentPlayerName(){
  const fallbackSeat=configuredLocalSeat(app.localSeat);
  return app.state?.players?.[currentHumanSeat()]?.name||lobbyCfg?.playerName||lobbyCfg?.names?.[fallbackSeat]||DEFAULT_NAMES[fallbackSeat]||'Player 1';
}
function callerSeat(ro){return ro%3;} // seat 0 rotates: offset 0→seat0, 1→seat1, 2→seat2

function storedControllers(){
  if(app.mode==='solo')return['local','ai','ai'];
  if(app.mode==='semi')return['local','local','ai'];
  if(app.mode==='hotseat')return['local','local','local'];
  if(app.mode==='room-host'||app.mode==='room-join'){
    return Array.from({length:3},(_,seat)=>{
      const controller=app.state?.players?.[seat]?.controller;
      if(controller==='ai')return'ai';
      return seat===app.localSeat?'local':'remote';
    });
  }
  return['local','ai','ai'];
}

function storedNames(){
  if(app.state?.players?.length)return app.state.players.map(player=>player.name);
  if(document.getElementById('name-0'))return getNames();
  if(lobbyCfg?.names?.length)return lobbyCfg.names.slice(0,3);
  return DEFAULT_NAMES.slice(0,3);
}

function persistCurrentConfig(roomCode=roomCodeEl?.value?.trim?.()||'FTT-1'){
  window.persistLobbyConfig?.({
    controllers:storedControllers(),
    game:'ftt',
    mode:app.mode,
    names:storedNames(),
    playerName:currentPlayerName(),
    preferredSeat:app.localSeat,
    roomCode
  });
}

let announceTimer=null;
function announce(msg,dur=2400){
  if(!announceEl)return;
  announceEl.classList.remove('fade');
  announceEl.textContent=msg;
  clearTimeout(announceTimer);
  announceTimer=setTimeout(()=>announceEl.classList.add('fade'),dur);
}

/* ── Names ── */
function getNames(){return[0,1,2].map(i=>document.getElementById(`name-${i}`)?.value.trim()||DEFAULT_NAMES[i]);}
function syncNameInputs(names){names?.forEach((name,i)=>{const input=document.getElementById(`name-${i}`);if(input)input.value=name||DEFAULT_NAMES[i];});}
function applyNames(players){const n=getNames();players.forEach((p,i)=>p.name=n[i]);}

/* ═══════════════════════════════════════════
   DEALING + TRUMP SELECTION PHASE
   ═══════════════════════════════════════════ */

/*
  app.state phases:
    'trump-select'  — caller choosing trump (modal shown)
    'playing'       — normal trick play
*/

function initState(mode){
  const ctrl=lobbyCfg?resolveControllers(lobbyCfg):{
    0:(mode==='room-join')?'remote':'local',
    1:(mode==='hotseat'||mode==='semi')?'local':(mode==='room-join')?'local':(mode==='room-host')?'remote':'ai',
    2:(mode==='hotseat')?'local':((mode==='room-host'||mode==='room-join')?'remote':'ai')
  };
  const names=lobbyCfg?.names||DEFAULT_NAMES;
  const players=[0,1,2].map(i=>({name:names[i]||DEFAULT_NAMES[i],hand:[],controller:Array.isArray(ctrl)?ctrl[i]:ctrl[i],score:0}));
  if(!lobbyCfg)applyNames(players);
  startTrumpSelection(players,0,[0,0,0]);
}

function startTrumpSelection(players,roundOffset,scores){
  const deck=shuffle(createDeck());

  // Deal first 5 cards to each player
  const first15=deck.slice(0,15);
  const remaining=deck.slice(15); // 15 cards left (5 per player second half)

  players.forEach(p=>p.hand=[]);
  first15.forEach((card,i)=>players[i%3].hand.push(card));
  players.forEach((p,i)=>{p.hand=sortCards(p.hand);p.score=scores[i];});
  applyNames(players);

  const caller=callerSeat(roundOffset); // who has quota 5 this round

  app.state={
    players,
    roundOffset,
    trump:null,
    phase:'trump-select',
    caller,            // seat index of the trump-picker
    deck,              // full shuffled deck kept for dealing second half
    remaining,         // cards not yet dealt (last 15)
    exposedCards:null, // null until caller requests extras
    turn:caller,       // for display purposes during selection
    leader:caller,
    trick:[],trickPlayers:[],tricksWon:[0,0,0],
    over:false,
    status:'',
    lastTrickCardKey:null,
    trickWinner:null
  };
  app.busy=false;

  const callerName=players[caller].name;
  app.state.status=`${callerName} must choose trump.`;
  announce(`${callerName} is choosing trump…`);

  // If caller is AI, decide automatically after short delay
  if(players[caller].controller==='ai'){
    setTimeout(()=>aiChooseTrump(),900);
  } else if(players[caller].controller==='local'){
    showTrumpModal();
  } else if(trumpModal){
    trumpModal.classList.remove('visible');
  }
  render();
}

function dealSecondHalf(){
  // Deal remaining 5 cards to each player
  const remaining=app.state.remaining;
  remaining.forEach((card,i)=>app.state.players[i%3].hand.push(card));
  app.state.players.forEach(p=>{p.hand=sortCards(p.hand);});
  app.state.phase='playing';
  app.state.turn=app.state.caller; // caller leads first trick
  app.state.leader=app.state.caller;
  app.state.status=`Trump is ${app.state.trump} ${SUIT_CHAR[app.state.trump]}. ${app.state.players[app.state.caller].name} leads.`;
  announce(`Trump: ${app.state.trump} ${SUIT_CHAR[app.state.trump]}`);
}

/* ── Trump modal logic ── */
function showTrumpModal(){
  if(!trumpModal)return;
  const{state}=app;
  const caller=state.caller;
  const callerName=state.players[caller].name;
  const hand=state.players[caller].hand; // first 5 cards

  // Suit counts from current hand
  const suitCounts=Object.fromEntries(SUITS.map(s=>[s,hand.filter(c=>c.suit===s).length]));

  const hasExposed=!!state.exposedCards;
  const allowedSuits=hasExposed?state.exposedCards.map(c=>c.suit):SUITS;
  const uniqueAllowed=[...new Set(allowedSuits)];

  document.getElementById('tm-title').textContent=hasExposed
    ?`${callerName}, pick trump from the exposed cards`
    :`${callerName}, choose trump`;

  document.getElementById('tm-subtitle').textContent=hasExposed
    ?`You must pick a suit from the two revealed cards (visible to all).`
    :`You have quota 5 this round. Pick any suit, or reveal 2 extra cards first.`;

  // Render caller's first-5 hand
  document.getElementById('tm-hand').innerHTML=hand.map(card=>
    `<div class="card ${suitClass(card.suit)}" style="width:clamp(44px,5.5vw,64px);height:calc(clamp(44px,5.5vw,64px)*1.42);border-radius:10px;flex-shrink:0">
      <span class="c-rank">${card.rank}</span><span class="c-suit">${SUIT_CHAR[card.suit]}</span>
    </div>`
  ).join('');

  // Render exposed cards (if any)
  const expZone=document.getElementById('tm-exposed-zone');
  if(hasExposed){
    expZone.style.display='block';
    document.getElementById('tm-exposed-cards').innerHTML=state.exposedCards.map(card=>
      `<div class="card ${suitClass(card.suit)}" style="width:clamp(48px,6vw,70px);height:calc(clamp(48px,6vw,70px)*1.42);border-radius:10px;flex-shrink:0;box-shadow:0 0 0 2px rgba(255,220,100,0.6),0 10px 24px rgba(0,0,0,0.22)">
        <span class="c-rank">${card.rank}</span><span class="c-suit">${SUIT_CHAR[card.suit]}</span>
      </div>`
    ).join('');
  } else {
    expZone.style.display='none';
  }

  // Suit buttons — only allowed suits are active
  document.getElementById('tm-suits').innerHTML=SUITS.map(suit=>{
    const count=suitCounts[suit];
    const allowed=uniqueAllowed.includes(suit);
    const disabled=!allowed;
    return `<button class="tm-suit-btn ${disabled?'tm-suit-disabled':''}" data-suit="${suit}" ${disabled?'disabled':''}>
      <span class="tm-suit-sym ${suitClass(suit)}">${SUIT_CHAR[suit]}</span>
      <span class="tm-suit-name">${suit}</span>
      <span class="tm-suit-count">${count} in hand</span>
    </button>`;
  }).join('');

  // Expose button — only shown before extras have been requested
  const expBtn=document.getElementById('tm-expose-btn');
  if(expBtn){
    expBtn.style.display=hasExposed?'none':'block';
    expBtn.onclick=requestExposed;
  }

  // Suit button listeners
  trumpModal.querySelectorAll('.tm-suit-btn:not(.tm-suit-disabled)').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const suit=btn.dataset.suit;
      confirmTrump(suit);
    });
  });

  trumpModal.classList.add('visible');
}

function requestExposed(){
  if(app.mode==='room-join'){
    app.bridge?.sendIntent({type:'request-exposed'});
    setupStatusEl.textContent='Exposed-card request sent.';
    return;
  }
  const{state}=app;
  // Flip the next 2 cards from the undealt portion
  // remaining = deck.slice(15) → indices 0-1 are the "extra" reveal cards
  const extras=state.remaining.slice(0,2);
  state.exposedCards=extras;
  // Remove them from remaining so they aren't dealt again
  state.remaining=state.remaining.slice(2);
  // These extra cards go to NO ONE's hand — they are just revealed then discarded after trump pick
  announce(`${state.players[state.caller].name} requested extra cards — revealed to all!`);
  syncIfHost();
  render(); // update seats so everyone "sees" them
  if(state.players[state.caller].controller==='local')showTrumpModal(); // re-render modal with exposed cards
}

function confirmTrump(suit){
  if(app.mode==='room-join'){
    app.bridge?.sendIntent({type:'choose-trump',suit});
    setupStatusEl.textContent='Trump choice sent.';
    return;
  }
  app.state.trump=suit;
  trumpModal.classList.remove('visible');
  announce(`${app.state.players[app.state.caller].name} chose ${suit} ${SUIT_CHAR[suit]} as trump!`);
  dealSecondHalf();
  syncIfHost();render();scheduleAI();
}

/* ── AI trump selection ── */
function aiChooseTrump(){
  if(!app.state||app.state.phase!=='trump-select')return;
  const{state}=app;
  const hand=state.players[state.caller].hand;

  if(!state.exposedCards){
    // Count suits in first 5 cards
    const counts=Object.fromEntries(SUITS.map(s=>[s,hand.filter(c=>c.suit===s).length]));
    const best=SUITS.reduce((a,b)=>counts[a]>=counts[b]?a:b);
    // If best suit has ≥2 cards, just pick it; otherwise request extras
    if(counts[best]>=2){
      confirmTrump(best);
    } else {
      // Request exposed cards then pick best of those 2
      requestExposed();
      setTimeout(()=>{
        const exposed=state.exposedCards;
        const expSuits=[...new Set(exposed.map(c=>c.suit))];
        // Pick the exposed suit where AI has most cards in hand, else first
        const expCounts=Object.fromEntries(expSuits.map(s=>[s,hand.filter(c=>c.suit===s).length]));
        const chosen=expSuits.reduce((a,b)=>expCounts[a]>=expCounts[b]?a:b);
        confirmTrump(chosen);
      },800);
    }
  } else {
    const exposed=state.exposedCards;
    const expSuits=[...new Set(exposed.map(c=>c.suit))];
    const counts=Object.fromEntries(expSuits.map(s=>[s,hand.filter(c=>c.suit===s).length]));
    const chosen=expSuits.reduce((a,b)=>counts[a]>=counts[b]?a:b);
    confirmTrump(chosen);
  }
}

/* ═══════════════════════════════════════════
   NORMAL TRICK PLAY
   ═══════════════════════════════════════════ */

function legalCards(seat){
  const p=app.state.players[seat];
  if(!app.state.trick.length)return[...p.hand];
  const ls=app.state.trick[0].suit;
  const m=p.hand.filter(c=>c.suit===ls);
  return m.length?m:[...p.hand];
}

function beats(ch,cur,ls){
  const cT=ch.suit===app.state.trump,curT=cur.suit===app.state.trump;
  if(cT&&!curT)return true;if(!cT&&curT)return false;
  if(ch.suit===cur.suit)return rankVal(ch.rank)>rankVal(cur.rank);
  return ch.suit===ls&&cur.suit!==ls;
}

function resolveTrick(){
  const ls=app.state.trick[0].suit;
  let winner=0;
  for(let i=1;i<app.state.trick.length;i++)if(beats(app.state.trick[i],app.state.trick[winner],ls))winner=i;
  const seat=app.state.trickPlayers[winner];
  app.state.tricksWon[seat]++;
  app.state.trickWinner=seat;
  const wname=app.state.players[seat].name;
  app.state.status=`${wname} wins the trick!`;
  announce(`${wname} takes the trick ★`);
  app.busy=true;
  render();
  const flash=document.getElementById('trick-flash');
  if(flash){flash.classList.add('show');setTimeout(()=>flash.classList.remove('show'),700);}
  setTimeout(()=>{
    app.state.trick=[];app.state.trickPlayers=[];
    app.state.turn=seat;app.state.leader=seat;
    app.state.trickWinner=null;
    app.busy=false;
    if(app.state.players.every(p=>p.hand.length===0)){resolveRound();return;}
    syncIfHost();render();scheduleAI();
  },1100);
}

function resolveRound(){
  const{state}=app;
  const exactSeats=state.players.map((_,i)=>state.tricksWon[i]===quota(i,state.roundOffset)?i:-1).filter(i=>i>=0);
  let scorers=exactSeats;
  if(!scorers.length){
    let minDiff=Infinity;
    state.players.forEach((_,i)=>{const d=Math.abs(quota(i,state.roundOffset)-state.tricksWon[i]);if(d<minDiff)minDiff=d;});
    scorers=state.players.map((_,i)=>Math.abs(quota(i,state.roundOffset)-state.tricksWon[i])===minDiff?i:-1).filter(i=>i>=0);
  }
  scorers.forEach(i=>state.players[i].score++);
  const champion=state.players.find(p=>p.score>=3);

  const eyebrow=champion?'Match over':`Round ${state.roundOffset+1} complete`;
  const headline=champion?`${champion.name} wins!`:(()=>{
    const ns=scorers.map(i=>state.players[i].name);
    return ns.length===1?`${ns[0]} scores!`:`${ns.join(' & ')} score!`;
  })();

  const rows=state.players.map((p,i)=>{
    const q=quota(i,state.roundOffset);
    const got=state.tricksWon[i];
    const diff=got-q;
    const diffStr=diff>0?`+${diff}`:`${diff}`;
    const didScore=scorers.includes(i);
    return `<div class="round-row ${didScore?'scored':''}">
      <div><div class="rr-name">${p.name}</div><div class="rr-detail">Quota ${q} &middot; Got ${got} (${diffStr})</div></div>
      <div class="rr-score ${didScore?'':'no-point'}">&#9733; ${p.score}${didScore?' +1':''}</div>
    </div>`;
  }).join('');

  roundEyebrow.textContent=eyebrow;
  roundHeadline.textContent=headline;
  roundResults.innerHTML=rows;
  roundContinue.textContent=champion?'Play Again':'Next Round →';
  roundOverlay.classList.add('visible');

  if(champion){pendingNextRound=null;state.over=true;}
  else{
    pendingNextRound={
      players:state.players.map(p=>({...p})),
      roundOffset:(state.roundOffset+1)%3,
      scores:state.players.map(p=>p.score),
      controllers:state.players.map(p=>p.controller)
    };
  }
  syncIfHost();render();
}

roundContinue.addEventListener('click',()=>{
  roundOverlay.classList.remove('visible');
  if(!pendingNextRound){startGame();return;}
  const{players,roundOffset,scores,controllers}=pendingNextRound;
  pendingNextRound=null;
  const rp=players.map((p,i)=>({...p,controller:controllers[i]}));
  startTrumpSelection(rp,roundOffset,scores);
  syncIfHost();render();
});

function playCard(cardKey){
  if(app.busy||app.state.phase!=='playing')return;
  const seat=app.state.turn;
  const player=app.state.players[seat];
  const legal=legalCards(seat);
  const card=player.hand.find(c=>c.key===cardKey);
  if(!card||!legal.some(c=>c.key===cardKey))return;
  player.hand=player.hand.filter(c=>c.key!==cardKey);
  app.state.lastTrickCardKey=card.key;
  app.state.trick.push(card);
  app.state.trickPlayers.push(seat);
  announce(`${player.name} plays ${card.rank}${SUIT_CHAR[card.suit]}`);
  if(app.state.trick.length===3){
    resolveTrick();
  }else{
    app.state.turn=(app.state.turn+1)%3;
    app.state.status=`${app.state.players[app.state.turn].name} to play.`;
    syncIfHost();render();scheduleAI();
  }
}

function scheduleAI(){
  if(app.busy||!app.state||app.state.over)return;
  if(app.state.phase==='trump-select'){
    if(app.state.players[app.state.caller].controller==='ai')setTimeout(()=>aiChooseTrump(),900);
    return;
  }
  if(app.state.players[app.state.turn].controller!=='ai')return;
  app.busy=true;
  setTimeout(()=>{
    if(!app.state||app.state.over||app.state.phase!=='playing'){app.busy=false;return;}
    const seat=app.state.turn;
    if(app.state.players[seat].controller!=='ai'){app.busy=false;return;}
    const options=legalCards(seat);
    let chosen=options[0];
    const q=quota(seat,app.state.roundOffset);
    const won=app.state.tricksWon[seat];
    if(won>=q&&options.length>1){chosen=sortCards(options)[0];}
    else if(app.state.trick.length>0){
      const ls=app.state.trick[0].suit;
      const best=app.state.trick.reduce((b,c)=>beats(c,b,ls)?c:b,app.state.trick[0]);
      const winners=options.filter(c=>beats(c,best,ls));
      chosen=winners.length?sortCards(winners)[0]:sortCards(options)[0];
    }
    app.busy=false;
    playCard(chosen.key);
  },680);
}

function syncIfHost(){if(app.mode==='room-host'&&app.bridge)app.bridge.broadcastState(app.state);}

/* ─── RENDER ─── */
function render(){
  if(!app.state)return;
  const{state}=app;
  syncTurnGuard(state);
  chatUI?.setContext({mode:app.mode,roomCode:roomCodeEl?.value?.trim?.()||'',playerName:currentPlayerName()});

  const guardActive=turnGuardActive(state);
  const localTrumpPicker=state.phase==='trump-select'
    && typeof state.caller==='number'
    && state.caller===currentHumanSeat()
    && state.players[state.caller]?.controller!=='ai'
    && !guardActive;
  if(trumpModal){
    if(localTrumpPicker)showTrumpModal();
    else trumpModal.classList.remove('visible');
  }

  // Turn chip
  const chipText=state.over?'Finished':
    state.phase==='trump-select'?`${state.players[state.caller].name} picks trump`:
    `${state.players[state.turn].name}'s turn`;
  document.getElementById('turn-chip').textContent=chipText;

  // Status bar
  const trumpStr=state.trump?`| Trump: ${state.trump} ${SUIT_CHAR[state.trump]}`:'| Trump: TBD';
  statusEl.textContent=`${state.status} ${trumpStr}`;

  // Quota badges
  document.getElementById('scores').innerHTML=state.players.map((p,i)=>{
    const q=quota(i,state.roundOffset);
    const tw=state.tricksWon[i];
    const diff=tw-q;
    const diffStr=diff>0?`+${diff}`:`${diff}`;
    const cls=state.phase==='playing'?(tw===q?'exact':tw>q?'over':''):'';
    const isCaller=i===state.caller;
    return `<div class="quota-badge ${cls} ${isCaller?'quota-caller':''}"><strong>${p.name}${isCaller?' ★':''}</strong><span>Quota ${q} | ${state.phase==='playing'?`Got ${tw} (${diffStr}) | `:''}&#9733; ${p.score}</span></div>`;
  }).join('');

  // Trick / board area
  const trickEl=document.getElementById('trick');
  if(state.phase==='trump-select'){
    // Show exposed cards if any, otherwise a waiting message
    if(state.exposedCards){
      trickEl.innerHTML=`<div style="text-align:center">
        <div style="font-size:0.78rem;color:var(--t-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.1em">Exposed cards (visible to all)</div>
        <div style="display:flex;gap:12px;justify-content:center">
          ${state.exposedCards.map(card=>`<div class="card ${suitClass(card.suit)}" style="width:clamp(52px,7vw,76px);height:calc(clamp(52px,7vw,76px)*1.42);border-radius:12px;box-shadow:0 0 0 2.5px rgba(255,220,100,0.65),0 14px 28px rgba(0,0,0,0.24)"><span class="c-rank">${card.rank}</span><span class="c-suit">${SUIT_CHAR[card.suit]}</span></div>`).join('')}
        </div>
        <div style="font-size:0.8rem;color:#f8e6be;margin-top:10px">${state.players[state.caller].name} must pick trump from these suits</div>
      </div>`;
    } else {
      trickEl.innerHTML=`<div class="trump-badge">${state.players[state.caller].name} is choosing trump…<br><span style="font-size:0.76rem;opacity:0.65">Trump: TBD</span></div>`;
    }
  } else if(state.trick.length){
    const flash=`<div class="trick-winner-flash" id="trick-flash"></div>`;
    const slots=state.trick.map((card,i)=>{
      const seat=state.trickPlayers[i];
      const latest=card.key===state.lastTrickCardKey?'latest-play':'';
      return `<div class="trick-slot"><div class="trick-slot-label">${state.players[seat].name}</div><div class="card ${suitClass(card.suit)} ${latest}" style="width:clamp(50px,6.8vw,78px);height:calc(clamp(50px,6.8vw,78px)*1.42)"><span class="c-rank">${card.rank}</span><span class="c-suit">${SUIT_CHAR[card.suit]}</span></div></div>`;
    }).join('');
    const banner=state.trickWinner!==null?`<div class="trick-won-banner show">${state.players[state.trickWinner].name} wins!</div>`:'<div class="trick-won-banner"></div>';
    trickEl.innerHTML=flash+slots+banner;
  } else {
    trickEl.innerHTML=`<div class="trump-badge">Trump: <strong>${state.trump} ${SUIT_CHAR[state.trump]}</strong><br><span style="font-size:0.76rem;opacity:0.65">Lead with any card</span></div>`;
  }

  // Hand
  const hs=currentHumanSeat();
  const canPlay=state.phase==='playing'&&state.turn===hs&&!state.over&&!app.busy&&!guardActive;
  const legalSet=state.phase==='playing'?new Set(legalCards(hs).map(c=>c.key)):new Set();
  const handLabel=guardActive
    ?`${state.players[hs].name} — hidden hand`
    :state.phase==='trump-select'&&hs===state.caller
      ?`${state.players[hs].name} — first 5 cards (choosing trump)`
      :`${state.players[hs].name} — ${state.players[hs].hand.length} cards`;
  document.getElementById('hand-title').textContent=handLabel;
  const handEl=document.getElementById('hand');
  handEl.classList.toggle('guarded',guardActive);
  if(guardActive){
    handEl.innerHTML=renderGuardCards(state.players[hs].hand.length);
  }else{
    handEl.innerHTML=state.players[hs].hand.map(card=>{
      const disabled=!canPlay||!legalSet.has(card.key);
      return `<div class="card hand-card ${suitClass(card.suit)} ${disabled?'disabled':'playable'}" role="button" tabindex="${disabled?-1:0}" aria-label="${card.rank} of ${card.suit}" data-card="${card.key}"><span class="c-rank">${card.rank}</span><span class="c-suit">${SUIT_CHAR[card.suit]}</span></div>`;
    }).join('');
    handEl.querySelectorAll('[data-card]').forEach(el=>{
      const h=()=>{
        if(el.classList.contains('disabled'))return;
        if(app.mode==='room-join'){app.bridge.sendIntent({type:'play',cardKey:el.dataset.card});setupStatusEl.textContent='Move sent.';return;}
        playCard(el.dataset.card);
      };
      el.addEventListener('click',h);
      el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();h();}});
    });
  }
  if(guardEl){
    guardEl.classList.toggle('hidden',!guardActive);
    if(guardActive){
      guardTitleEl.textContent=`Pass to ${state.players[hs].name}`;
      guardCopyEl.textContent='When they are ready, press Reveal cards to show this hand.';
    }
  }

  // Profile
  document.getElementById('player-profile').innerHTML=`<div class="player-avatar">${AVATARS[hs]}</div><div><div class="player-name">${state.players[hs].name}</div><div class="player-sub">Quota ${quota(hs,state.roundOffset)} | &#9733; ${state.players[hs].score}</div></div>`;

  renderSeat('seat-top',1);renderSeat('seat-left',2);renderSeat('seat-right',0);
}

function renderSeat(targetId,seatIdx){
  const el=document.getElementById(targetId);
  if(!el||!app.state)return;
  const player=app.state.players[seatIdx];
  if(!player||seatIdx===currentHumanSeat()){el.innerHTML='';return;}
  const isActive=app.state.phase==='playing'&&app.state.turn===seatIdx&&!app.state.over;
  const isThinking=app.busy&&app.state.turn===seatIdx;
  const isCaller=seatIdx===app.state.caller&&app.state.phase==='trump-select';
  const q=quota(seatIdx,app.state.roundOffset);
  const cardBacks=Array.from({length:Math.min(player.hand.length,6)},()=>'<div class="seat-mini-card"></div>').join('');
  el.innerHTML=`<div class="seat-badge ${isActive?'active-seat':''} ${isThinking?'thinking':''} ${isCaller?'thinking':''}"><div class="seat-avatar">${AVATARS[seatIdx]}</div><div class="seat-name-label">${player.name}${isCaller?' ★':''}</div><div class="seat-sub-label">Q${q} | ${app.state.phase==='playing'?`Got ${app.state.tricksWon[seatIdx]} | `:''}&#9733;${player.score}${isThinking?' · thinking…':isCaller?' · picking trump…':''}</div><div class="seat-card-row">${cardBacks}</div></div>`;
}

function showGameOver(t,m){goTitle.textContent=t;goMessage.textContent=m;goOverlay.classList.remove('hidden');}

function startGame(fromLobby=true){
  if(fromLobby){
    lobbyCfg=getLobbyConfig('ftt',3);
    app.mode=resolveMode(lobbyCfg);
    if(roomCodeEl)roomCodeEl.value=lobbyCfg.roomCode;
    if(modeEl)modeEl.value=app.mode;
    syncNameInputs(lobbyCfg.names);
  }else{
    lobbyCfg=null;
    app.mode=modeEl.value;
  }
  app.localSeat=app.mode==='room-join'?configuredLocalSeat(1):configuredLocalSeat(0);
  app.guardSeat=null;
  app.revealedSeat=null;
  app.busy=false;pendingNextRound=null;
  goOverlay.classList.add('hidden');roundOverlay.classList.remove('visible');
  if(trumpModal)trumpModal.classList.remove('visible');
  if(app.bridge)app.bridge.close();
  const rc=roomCodeEl.value.trim()||'FTT-1';
  chatUI?.setContext({mode:app.mode,roomCode:rc,playerName:currentPlayerName()});
  if(app.mode==='room-host'||app.mode==='room-join'){
    app.bridge=new RoomBridge('ftt-room',handleRoomMessage,t=>{setupStatusEl.textContent=t;},{maxPlayers:3,preferredSeat:app.localSeat});
    app.localSeat=app.mode==='room-host'?app.bridge.host(rc,app.localSeat):app.bridge.join(rc,app.localSeat);
  }else{app.bridge=null;app.localSeat=configuredLocalSeat(0);}
  if(chatUI)chatUI.setBridge(app.bridge||null);
  if(app.mode!=='room-join'){
    initState(app.mode);syncIfHost();
    const msgs={solo:'Solo match started.',semi:'2P vs 1 CPU started. Shared hands reveal turn by turn.',hotseat:'Hotseat — pass device each turn.','room-host':`Hosting room ${roomCodeEl.value}.`};
    setupStatusEl.textContent=msgs[app.mode]||'';
  }else{
    app.state=null;
    ['hand','trick','scores','seat-top','seat-left','seat-right','player-profile'].forEach(id=>{const e=document.getElementById(id);if(e)e.innerHTML='';});
    chatUI?.setEmptyState('Connected room chat will appear here as soon as the host shares a snapshot.');
    statusEl.textContent='Waiting for host snapshot…';
  }
  persistCurrentConfig(rc);
  setupDrawer.classList.remove('open');setupDrawer.setAttribute('aria-hidden','true');toggleSetupBtn.setAttribute('aria-expanded','false');
}
function handleRoomMessage(message){
  if(message.type==='seat-assigned'){
    if(typeof message.seat==='number')app.localSeat=message.seat;
    if(message.role==='host'||message.role==='client')app.mode=message.role==='host'?'room-host':'room-join';
    chatUI?.setContext({mode:app.mode,roomCode:roomCodeEl?.value?.trim?.()||'',playerName:currentPlayerName()});
    persistCurrentConfig();
    if(app.state)render();
  }
  if(app.mode==='room-host'&&message.type==='join'){
    if(typeof message.seat==='number'&&app.state?.players?.[message.seat]){
      if(message.name)app.state.players[message.seat].name=message.name;
      app.state.players[message.seat].controller='remote';
      render();
    }
    setupStatusEl.textContent=message.name?`${message.name} joined ${roomCodeEl.value}.`:`Guest joined ${roomCodeEl.value}.`;
    syncIfHost();
  }
  if(app.mode==='room-host'&&message.type==='leave'&&typeof message.seat==='number'){
    setupStatusEl.textContent=`${message.name||'Player'} disconnected. Waiting before bot takeover.`;
  }
  if(app.mode==='room-host'&&message.type==='activate-bot'&&typeof message.seat==='number'&&app.state?.players?.[message.seat]){
    app.state.players[message.seat].controller='ai';
    setupStatusEl.textContent=`${app.state.players[message.seat].name} is now controlled by a bot.`;
    syncIfHost();render();scheduleAI();
  }
  if(app.mode==='room-host'&&message.type==='deactivate-bot'&&typeof message.seat==='number'&&app.state?.players?.[message.seat]){
    app.state.players[message.seat].controller=message.seat===app.localSeat?'local':'remote';
    setupStatusEl.textContent=`${app.state.players[message.seat].name} rejoined the room.`;
    syncIfHost();render();
  }
  if(app.mode==='room-host'&&message.type==='intent'&&typeof message.seat==='number'){
    if(message.intent?.type==='play'&&app.state.phase==='playing'&&app.state.turn===message.seat)playCard(message.intent.cardKey);
    if(message.intent?.type==='request-exposed'&&app.state.phase==='trump-select'&&app.state.caller===message.seat)requestExposed();
    if(message.intent?.type==='choose-trump'&&app.state.phase==='trump-select'&&app.state.caller===message.seat&&SUITS.includes(message.intent.suit))confirmTrump(message.intent.suit);
  }
  if(message.type==='host-promoted'){
    app.mode='room-host';
    if(typeof message.seat==='number')app.localSeat=message.seat;
    app.state=message.snapshot||app.state;
    if(app.state?.players?.length){
      app.state.players.forEach((player,seat)=>{if(player.controller!=='ai')player.controller=seat===app.localSeat?'local':'remote';});
    }
    app.busy=false;
    persistCurrentConfig();
    render();
    syncIfHost();
    scheduleAI();
    setupStatusEl.textContent=message.message||'You are now the host.';
  }
  if(app.mode==='room-join'&&message.type==='snapshot'){app.state=message.state;render();setupStatusEl.textContent=`Connected to ${roomCodeEl.value}.`;}
  if(message.type==='join-error'){
    if(trumpModal)trumpModal.classList.remove('visible');
    setupStatusEl.textContent=message.message||'Unable to join room.';
    statusEl.textContent=message.message||'Unable to join room.';
  }
  if(message.type==='authority-rejected'){
    setupStatusEl.textContent=message.message||'Only the host can sync room state.';
    statusEl.textContent=message.message||'Only the host can sync room state.';
  }
  if(message.type==='room-closed'&&app.mode==='room-join'){
    if(trumpModal)trumpModal.classList.remove('visible');
    app.state=null;
    ['hand','trick','scores','seat-top','seat-left','seat-right','player-profile'].forEach(id=>{const e=document.getElementById(id);if(e)e.innerHTML='';});
    chatUI?.setEmptyState(message.message||'Room closed.');
    setupStatusEl.textContent=message.message||'Room closed.';
    statusEl.textContent=message.message||'Room closed.';
  }
}

document.getElementById('start-btn').addEventListener('click',()=>startGame(false));
document.getElementById('restart-btn').addEventListener('click',()=>startGame(false));
document.getElementById('go-restart').addEventListener('click',()=>startGame(false));
guardBtn?.addEventListener('click',()=>{
  const seat=activeSharedSeat(app.state);
  if(seat===null)return;
  app.revealedSeat=seat;
  render();
});
newRoomCodeBtn?.addEventListener('click',()=>{
  if(!roomCodeEl)return;
  roomCodeEl.value=makeRoomCode();
  persistCurrentConfig(roomCodeEl.value);
});
toggleSetupBtn.addEventListener('click',()=>{
  const o=setupDrawer.classList.contains('open');
  setupDrawer.classList.toggle('open',!o);
  setupDrawer.setAttribute('aria-hidden',String(o));
  toggleSetupBtn.setAttribute('aria-expanded',String(!o));
});
[0,1,2].forEach(i=>{
  document.getElementById(`name-${i}`)?.addEventListener('input',()=>{
    if(app.state){const v=document.getElementById(`name-${i}`).value.trim();app.state.players[i].name=v||DEFAULT_NAMES[i];render();}
  });
});
startGame(true);

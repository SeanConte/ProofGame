import {config} from './config.js';

/* ============================================================================
   CONSTANTS & CONFIGURATION
   ============================================================================ */

const SYMBOLS = ['A','B','C','D','E','F','G'];
const ANIMATION_TIMINGS = {
  LOCK_MS: 200,
  MERGE_SLIDE_MS: 180,
  MERGE_FADE_MS: 180,
  MERGE_TOTAL_MS: 380,
  CONSEQUENT_HIGHLIGHT_MS: 700,
  CLEANUP_MS: 700,
  TOAST_DURATION_MS: 900,
  FLIP_DURATION_MS: 200
};

const THEME_KEY = 'rp_theme';
const SFX_MODE = (window.config && window.config.sfxMode) || 'synth';
const PREFERS_REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SAFE_MODE = new URLSearchParams(location.search).has('safe') || localStorage.getItem('rules_safe') === '1';

const modes = {
  easy:   { N:8, allowConditional:false, maxDepthConj:0 },
  medium: { N:8, allowConditional:false, maxDepthConj:2 },
  hard:   { N:8, allowConditional:true,  maxDepthConj:2 }
};


/* ============================================================================
   RNG & DETERMINISTIC HELPERS
   ============================================================================ */

function makeRng(seed=1){
  let s = seed >>> 0;
  return function rand(){
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rng = makeRng(12345);
const pick = (arr) => arr[Math.floor(rng()*arr.length)];

function pickSymbol(excludeSet = new Set()){
  const choices = SYMBOLS.filter(s => !excludeSet.has(s));
  if (choices.length === 0) {
    console.warn('pickSymbol: no valid symbols remaining, using fallback');
    return SYMBOLS[0];
  }
  return choices[Math.floor(rng() * choices.length)];
}

/* ============================================================================
   EXPRESSION UTILITIES (consolidated)
   ============================================================================ */

function mkAtom(sym){ 
  return { kind: 'atom', sym: String(sym) }; 
}

function mkConj(l, r){ 
  return { kind: 'conj', left: cloneExpr(l), right: cloneExpr(r) }; 
}

function mkImp(l, r){ 
  return { kind: 'imp', left: cloneExpr(l), right: cloneExpr(r) }; 
}

function cloneExpr(e){
  if (!e) return null;
  if (e.kind === 'atom') return { kind: 'atom', sym: e.sym };
  if (e.kind === 'conj') return { kind: 'conj', left: cloneExpr(e.left), right: cloneExpr(e.right) };
  if (e.kind === 'imp') return { kind: 'imp', left: cloneExpr(e.left), right: cloneExpr(e.right) };
  // Support legacy shapes
  if (e.type === 'atom') return { kind: 'atom', sym: e.v };
  if (e.type === 'and') return { kind: 'conj', left: cloneExpr(e.left), right: cloneExpr(e.right) };
  if (e.type === 'imp') return { kind: 'imp', left: cloneExpr(e.left), right: cloneExpr(e.right) };
  return null;
}

function exprText(e, isSubExpr = false){
  if (!e) return '';
  const kind = e.kind || e.type;
  if (!kind) return '';
  if (kind === 'atom') return (e.sym || e.v) || '';
  if (kind === 'conj' || kind === 'and'){
    const L = exprText(e.left, true);
    const R = exprText(e.right, true);
    const result = `${L} ∧ ${R}`;
    return isSubExpr ? `(${result})` : result;
  }
  if (kind === 'imp' || kind === '->'){
    const L = exprText(e.left, true);
    const R = exprText(e.right, true);
    const result = `${L} → ${R}`;
    return isSubExpr ? `(${result})` : result;
  }
  return '';
}

function exprKey(e){
  if (!e) return '';
  const kind = e.kind || e.type;
  if (!kind) return '';
  if (kind === 'atom') return String(e.sym || e.v || '');
  if (kind === 'conj' || kind === 'and'){
    return exprKey(e.left) + '∧' + exprKey(e.right);
  }
  if (kind === 'imp' || kind === '->'){
    return exprKey(e.left) + '→' + exprKey(e.right);
  }
  return '';
}

function exprEquals(a, b){ 
  return exprKey(a) === exprKey(b); 
}

/* ============================================================================
   LINE UTILITIES (consolidated)
   ============================================================================ */

let idCounter = 1;

function newId(){ 
  return `i${idCounter++}`; 
}

function mkLineAnte(expr){ 
  return { id: newId(), kind:'ante', expr: cloneExpr(expr) }; 
}

function mkLineImp(left, right){ 
  return { id: newId(), kind:'imp', left: cloneExpr(left), right: cloneExpr(right) }; 
}

function mkLineConj(left, right){ 
  return { id: newId(), kind:'conj', left: cloneExpr(left), right: cloneExpr(right) }; 
}

function mkDerived(expr){ 
  return { id: newId(), kind:'derived', expr: cloneExpr(expr) }; 
}

function keyOfLine(line){
  if (!line || !line.kind) return 'UNKNOWN';
  try{
    if (line.kind === 'ante' || line.kind === 'derived') return 'A:' + exprKey(line.expr);
    if (line.kind === 'imp') return 'I:' + exprKey(line.left) + '->' + exprKey(line.right);
    if (line.kind === 'conj') return 'C:' + exprKey(line.left) + '&' + exprKey(line.right);
  }catch(e){ 
    return `BAD:${line.kind}:${line.id||Math.random()}`; 
  }
}

function normalizeLine(line){
  if (!line || typeof line !== 'object') return line;
  
  if (line.kind === 'ante'){
    if (!line.expr){
      const sym = line.a || line.text || null;
      if (sym && typeof sym === 'string') line.expr = { kind: 'atom', sym: String(sym) };
    }
    delete line.a; delete line.b; delete line.text;
    return line;
  }
  
  if (line.kind === 'imp'){
    if (!line.left || !line.right){
      if (line.a && line.b){
        line.left = { kind: 'atom', sym: line.a };
        line.right = { kind: 'atom', sym: line.b };
      } else if (line.text && typeof line.text === 'string'){
        const parts = line.text.split(/→|->/).map(s=>s.trim()).filter(Boolean);
        if (parts.length === 2){
          line.left = { kind: 'atom', sym: parts[0] };
          line.right = { kind: 'atom', sym: parts[1] };
        }
      }
    }
    delete line.a; delete line.b; delete line.text;
    return line;
  }
  
  if (line.kind === 'conj'){
    if (!line.left || !line.right){
      if (line.text && typeof line.text === 'string'){
        const parts = line.text.split(/∧|&/).map(s=>s.trim()).filter(Boolean);
        if (parts.length === 2){
          line.left = { kind: 'atom', sym: parts[0] };
          line.right = { kind: 'atom', sym: parts[1] };
        }
      }
    }
    delete line.a; delete line.b; delete line.text;
    return line;
  }
  
  return line;
}

function displayText(line){
  if (!line) return '[invalid]';
  try{
    if (line.kind === 'imp') return `${exprText(line.left, true)} → ${exprText(line.right, true)}`;
    if (line.kind === 'ante' || line.kind === 'derived') return `${exprText(line.expr)}`;
    if (line.kind === 'conj') return `${exprText(line.left, true)} ∧ ${exprText(line.right, true)}`;
    return '[invalid]';
  }catch(e){ 
    return '[invalid]'; 
  }
}

// Helper: logic-only fallback for when animation elements aren't found
function replaceWithConsequentAndRefill(anteIdx, impIdx){
  const anteLine = current.items[anteIdx];
  const impLine  = current.items[impIdx];
  if (!impLine || impLine.kind !== 'imp') return;

  // Build consequent
  const consequent = mkLineAnte(impLine.right);
  
  // Clone array with consequent in place
  let next = [...current.items];
  next[impIdx] = consequent;
  
  // Analyze what we have without the filler
  const beforeFiller = next.filter((_, idx) => idx !== anteIdx);
  const { anteMap, impMap } = analyzeBoardState(beforeFiller);
  const pairCountBefore = distinctPairKeys(beforeFiller).size;
  
  let filler;
  
  // If we'll have fewer than 2 pairs, make filler create a match
  if (pairCountBefore < 2) {
    const impNeedingAnte = [...impMap.keys()].find(k => !anteMap.has(k));
    if (impNeedingAnte) {
      const leftExpr = beforeFiller.find(l => l.kind==='imp' && exprKey(l.left)===impNeedingAnte)?.left;
      filler = mkLineAnte(cloneExpr(leftExpr));
    } else {
      const anteNeedingImp = [...anteMap.keys()].find(k => !impMap.has(k));
      if (anteNeedingImp) {
        const leftExpr = beforeFiller.find(l => (l.kind==='ante'||l.kind==='derived') && exprKey(l.expr)===anteNeedingImp)?.expr;
        const rightExpr = pickExprByDifficulty(gameOpts);
        filler = mkLineImp(cloneExpr(leftExpr), rightExpr);
      } else {
        const leftExpr = mkAtom(pickSymbol());
        const rightExpr = pickExprByDifficulty(gameOpts);
        filler = mkLineAnte(cloneExpr(leftExpr));
        next.push(mkLineImp(cloneExpr(leftExpr), rightExpr));
      }
    }
  } else {
    const forbidden = exprKey(impLine.left);
    filler = genDistractorAvoiding(forbidden);
  }
  
  next[anteIdx] = filler;

  try { assertWellFormedBoard(next); } catch(e){ console.warn('Fallback validation', e); }

  current.items = next;
  state.selected = [];
  render();

  const newConsEl = el.lines.querySelector(`[data-id="${consequent.id}"]`);
  if (newConsEl){
    newConsEl.classList.add('consequent', 'consequent-pulse');
    setTimeout(()=> newConsEl.classList.remove('consequent', 'consequent-pulse'),
      ANIMATION_TIMINGS.CONSEQUENT_HIGHLIGHT_MS);
  }
}



/* ============================================================================
   VALIDATION
   ============================================================================ */

function isExpr(x){
  if (!x) return false;
  if (typeof x === 'string') return x.trim().length > 0;
  if (typeof x === 'object'){
    const kind = x.kind || x.type;
    if (!kind) return false;
    if (kind === 'atom') return (typeof x.sym === 'string' && x.sym.length>0) || (typeof x.v === 'string' && x.v.length>0);
    if (kind === 'conj' || kind === 'and' || kind === 'imp') return isExpr(x.left) && isExpr(x.right);
  }
  return false;
}

function isLine(l){
  if (!l || typeof l !== 'object') return false;
  if (!l.id || typeof l.id !== 'string') return false;
  if (!l.kind || typeof l.kind !== 'string') return false;
  if (l.kind === 'ante' || l.kind === 'derived') return isExpr(l.expr);
  if (l.kind === 'imp' || l.kind === 'conj') return isExpr(l.left) && isExpr(l.right);
  return false;
}

function validateLine(line){
  try{
    return isLine(line);
  }catch(e){ 
    return false; 
  }
}

function safeDecoyLine(){
  const a = mkAtom(pickSymbol());
  return mkLineAnte(a);
}

function assertWellFormedBoard(active){
  for (let i=0; i<active.length; i++){
    const normalized = normalizeLine(active[i]);
    if (normalized !== active[i]) active[i] = normalized;
    const ln = active[i];
    const ok = validateLine(ln);
    if (!ok){
      console.error('Board validation failed for line:', ln);
      if (SAFE_MODE){
        throw new Error('Invalid line in SAFE_MODE: ' + JSON.stringify(ln));
      } else {
        console.warn('Replacing invalid line with safe decoy');
        active[i] = safeDecoyLine();
      }
    }
  }
  return true;
}

/* ============================================================================
   BOARD ANALYSIS
   ============================================================================ */

function distinctPairKeys(active){
  const anteKeys = new Set();
  const impKeys = new Set();
  
  for (const ln of active){
    if (!ln || !ln.kind) continue;
    if (ln.kind === 'ante' || ln.kind === 'derived'){
      anteKeys.add(exprKey(ln.expr));
    } else if (ln.kind === 'imp'){
      impKeys.add(exprKey(ln.left));
    }
  }
  
  const keys = new Set();
  for (const k of impKeys){
    if (anteKeys.has(k)) keys.add(k);
  }
  return keys;
}

function scanPairs(active){
  const keys = distinctPairKeys(active);
  const pairs = [];
  
  for (const key of keys){
    const imp = active.find(l => l.kind==='imp' && exprKey(l.left)===key);
    const ante = active.find(l => (l.kind==='ante'||l.kind==='derived') && exprKey(l.expr)===key);
    if (imp && ante) pairs.push({ anteLine: ante, impLine: imp, key });
  }
  
  return pairs;
}

function analyzeBoardState(active){
  const anteMap = new Map();
  const impMap = new Map();
  const distinctKeys = new Set();
  
  for (const ln of active){
    if (!ln || !ln.kind) continue;
    
    if (ln.kind === 'ante' || ln.kind === 'derived'){
      const k = exprKey(ln.expr);
      if (!anteMap.has(k)) anteMap.set(k, []);
      anteMap.get(k).push(ln);
      if (impMap.has(k)) distinctKeys.add(k);
    } else if (ln.kind === 'imp'){
      const k = exprKey(ln.left);
      if (!impMap.has(k)) impMap.set(k, []);
      impMap.get(k).push(ln);
      if (anteMap.has(k)) distinctKeys.add(k);
    }
  }
  
  return { anteMap, impMap, distinctKeys };
}

/* ============================================================================
   EXPRESSION GENERATION
   ============================================================================ */

function pickExprByDifficulty(opts = {}){
  opts = opts || {};
  
  if (!opts.allowConditional && (opts.maxDepthConj || 0) <= 0){
    return mkAtom(pickSymbol());
  }
  
  const r = rng();
  if (opts.maxDepthConj > 0 && r < 0.3){
    return mkConj(mkAtom(pickSymbol()), mkAtom(pickSymbol()));
  }
  if (opts.allowConditional && r < 0.6){
    return mkImp(mkAtom(pickSymbol()), mkAtom(pickSymbol()));
  }
  return mkAtom(pickSymbol());
}

function genDistractorAvoiding(forbiddenAnte){
  const r = rng();
  
  if (r < 0.4){
    let s = pickSymbol();
    if (forbiddenAnte && exprKey(mkAtom(s)) === forbiddenAnte){
      s = pickSymbol(new Set([s]));
    }
    return mkLineAnte(mkAtom(s));
  } else if (r < 0.75){
    let s1 = pickSymbol();
    let s2 = pickSymbol(new Set([s1]));
    if (forbiddenAnte && exprKey(mkAtom(s1)) === forbiddenAnte){
      s1 = pickSymbol(new Set([s1]));
    }
    return mkLineImp(mkAtom(s1), mkAtom(s2));
  } else {
    let s1 = pickSymbol();
    let s2 = pickSymbol(new Set([s1]));
    if (forbiddenAnte && exprKey(mkAtom(s1)) === forbiddenAnte){
      s1 = pickSymbol(new Set([s1]));
    }
    return mkLineConj(mkAtom(s1), mkAtom(s2));
  }
}

function makeDecoy(active, opts, anteMap, impMap, lineKey){
  const tries = 60;
  const baseDistinct = distinctPairKeys(active).size;
  
  for (let t=0; t<tries; t++){
    const r = rng();
    let cand = null;
    
    if (r < 0.5){
      const e = pickExprByDifficulty(opts);
      if (impMap && impMap.has && impMap.has(exprKey(e))) continue;
      cand = mkLineAnte(e);
    } else if (r < 0.8){
      const l = pickExprByDifficulty(opts);
      const rght = pickExprByDifficulty(opts);
      cand = mkLineConj(l, rght);
    } else {
      const l = pickExprByDifficulty(opts);
      if (anteMap && anteMap.has && anteMap.has(exprKey(l))) continue;
      const rght = pickExprByDifficulty(opts);
      cand = mkLineImp(l, rght);
    }
    
    const k = keyOfLine(cand);
    if (lineKey && lineKey.has(k)) continue;
    
    const testActive = active.concat([cand]);
    const newDistinct = distinctPairKeys(testActive).size;
    if (newDistinct > baseDistinct) continue;
    
    return cand;
  }
  
  console.warn('makeDecoy: failed to create valid decoy after 60 tries');
  return null;
}

/* ============================================================================
   BOARD GENERATION & MAINTENANCE
   ============================================================================ */

function ensureAtLeastKPairs(active, K=2, opts){
  active.forEach((ln, idx) => {
    const nl = normalizeLine(ln);
    if (nl !== ln) active[idx] = nl;
  });
  
  const lineKey = new Set(active.map(keyOfLine));
  
  const recompute = () => analyzeBoardState(active);
  let { distinctKeys, anteMap, impMap } = recompute();
  
  const maxAttempts = 100;
  let attempts = 0;
  
  while (distinctKeys.size < K && attempts < maxAttempts){
    attempts++;
    
    // Add missing antecedent for existing implication
    const impNeedingAnte = [...impMap.keys()].find(k => !anteMap.has(k));
    if (impNeedingAnte){
      const leftExpr = active.find(l => l.kind==='imp' && exprKey(l.left)===impNeedingAnte).left;
      const cand = mkLineAnte(cloneExpr(leftExpr));
      const candKey = keyOfLine(cand);
      if (!lineKey.has(candKey)){
        active.push(cand);
        lineKey.add(candKey);
      }
      ({ distinctKeys, anteMap, impMap } = recompute());
      continue;
    }
    
    // Add missing implication for existing antecedent
    const anteNeedingImp = [...anteMap.keys()].find(k => !impMap.has(k));
    if (anteNeedingImp){
      const leftExpr = active.find(l => (l.kind==='ante'||l.kind==='derived') && exprKey(l.expr)===anteNeedingImp).expr;
      const rightExpr = pickExprByDifficulty(opts);
      const cand = mkLineImp(cloneExpr(leftExpr), rightExpr);
      const candKey = keyOfLine(cand);
      if (!lineKey.has(candKey)){
        active.push(cand);
        lineKey.add(candKey);
      }
      ({ distinctKeys, anteMap, impMap } = recompute());
      continue;
    }
    
    // Inject fresh pair
    const leftExpr = mkAtom(pickSymbol());
    const rightExpr = pickExprByDifficulty(opts);
    const imp = mkLineImp(cloneExpr(leftExpr), rightExpr);
    const ante = mkLineAnte(cloneExpr(leftExpr));
    const impKey = keyOfLine(imp);
    const anteKey = keyOfLine(ante);
    
    if (!lineKey.has(impKey)){
      active.push(imp);
      lineKey.add(impKey);
    }
    if (!lineKey.has(anteKey)){
      active.push(ante);
      lineKey.add(anteKey);
    }
    
    ({ distinctKeys, anteMap, impMap } = recompute());
  }
  
  // Fill with decoys
  const N = (opts && opts.N) || 6;
  const maxDecoyAttempts = 50;
  let decoyAttempts = 0;
  
  while (active.length < N && decoyAttempts < maxDecoyAttempts){
    decoyAttempts++;
    const { anteMap: a2, impMap: i2 } = analyzeBoardState(active);
    const decoy = makeDecoy(active, opts, a2, i2, lineKey);
    if (!decoy) {
      console.warn(`Failed to create decoy, board has ${active.length}/${N} lines`);
      break;
    }
    const dk = keyOfLine(decoy);
    if (!lineKey.has(dk)){
      active.push(decoy);
      lineKey.add(dk);
    }
  }
  
  return active;
}

/* ============================================================================
   GAME LOGIC
   ============================================================================ */

function isValidPair(a, b){
  const isAnteLike = (ln) => ln && (ln.kind === 'ante' || ln.kind === 'derived');
  const isImp = (ln) => ln && ln.kind === 'imp';
  
  if (isImp(a) && isAnteLike(b)) return exprEquals(a.left, b.expr);
  if (isImp(b) && isAnteLike(a)) return exprEquals(b.left, a.expr);
  return false;
}

/* ============================================================================
   AUDIO & HAPTICS
   ============================================================================ */

let __AUDIO_CTX = null;

function audioCtx(){
  if (!__AUDIO_CTX) {
    try {
      __AUDIO_CTX = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) {
      console.warn('AudioContext not available');
    }
  }
  return __AUDIO_CTX;
}

function beep({freq=880, ms=120, type='sine', gain=0.08}={}){
  const ctx = audioCtx();
  if (!ctx) return;
  
  const t0 = ctx.currentTime;
  const t1 = t0 + ms/1000;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.linearRampToValueAtTime(0, t1);
  
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t1);
}

function sfxSynthOK(){
  beep({freq: 920, ms: 120, type:'triangle', gain:0.07});
}

function sfxSynthNO(){
  beep({freq: 240, ms: 110, type:'square', gain:0.06});
  setTimeout(()=>beep({freq: 180, ms: 130, type:'square', gain:0.05}), 110);
}

let SFX = { ok:null, no:null, armed:false, enabled:false };

async function armSfxFilesOnce(){
  if (SFX.armed) return;
  SFX.armed = true;
  try{
    SFX.ok = new Audio('correct.mp3');
    SFX.ok.preload = 'auto';
    SFX.ok.volume = 0.35;
    SFX.no = new Audio('wrong.mp3');
    SFX.no.preload = 'auto';
    SFX.no.volume = 0.35;
    SFX.enabled = true;
  }catch(e){
    SFX.enabled = false;
  }
}

function playOkFile(){
  if (!SFX.enabled || !SFX.ok) return;
  try{
    SFX.ok.currentTime=0;
    SFX.ok.play().catch(()=>{});
  }catch(e){}
}

function playNoFile(){
  if (!SFX.enabled || !SFX.no) return;
  try{
    SFX.no.currentTime=0;
    SFX.no.play().catch(()=>{});
  }catch(e){}
}

if (SFX_MODE === 'files'){
  ['click','pointerdown','keydown','touchstart'].forEach(ev => 
    window.addEventListener(ev, () => armSfxFilesOnce(), { once:true, passive:true })
  );
}

function sfxOK(){
  if (SFX_MODE === 'files') playOkFile();
  else if (SFX_MODE === 'synth') sfxSynthOK();
}

function sfxNO(){
  if (SFX_MODE === 'files') playNoFile();
  else if (SFX_MODE === 'synth') sfxSynthNO();
}

function buzz(kind){
  if (!('vibrate' in navigator) || PREFERS_REDUCED) return;
  if (kind === 'ok') navigator.vibrate(12);
  else if (kind === 'no') navigator.vibrate([8,12]);
}

/* ============================================================================
   STATE MANAGEMENT
   ============================================================================ */

const state = {
  score: 0,
  streak: 0,
  selected: [],
  locked: false,
  secs: 0
};
let timerId = null;

function startTimer(){
  clearInterval(timerId);
  state.secs = 0;
  timerId = setInterval(()=>{
    state.secs += 1;
    updateScore(); // reuse to refresh timer text
  }, 1000);
}

function stopTimer(){ clearInterval(timerId); timerId = null; }

function fmtTime(secs){
  const m = Math.floor(secs/60).toString().padStart(2,'0');
  const s = (secs%60).toString().padStart(2,'0');
  return `${m}:${s}`;
}


let history = [];
let current = { items: [] };
let gameOpts = {...modes.easy};

const scrollState = { followLatest: true };

/* ============================================================================
   DOM REFERENCES
   ============================================================================ */

const el = {
  history: document.createElement('div'),
  lines: document.getElementById('lines'),
  score: document.getElementById('score'),
  toast: document.getElementById('toast'),
  pause: document.getElementById('pause'),
  reset: document.getElementById('reset'),
  scoreVal: document.getElementById('scoreVal'),
  streakVal: document.getElementById('streakVal'),
  timerVal: document.getElementById('timerVal'),
  lines: document.getElementById('lines'),
  iframeBanner: document.getElementById('iframe-banner'),
  openFull: document.getElementById('open-full'),
  dismissBanner: document.getElementById('dismiss-banner'),
  settingsBtn: document.getElementById('settings'),
  settingsPanel: document.getElementById('settings-panel'),
  themeSelect: document.getElementById('theme-select'),
  settingsClose: document.getElementById('settings-close'),
  menu: document.getElementById('menu')
};

// el.history.className='history';
// if (el.lines && el.lines.parentNode) {
//   el.lines.parentNode.insertBefore(el.history, el.lines);
// }

/* ============================================================================
   THEME MANAGEMENT
   ============================================================================ */

function applyTheme(theme){
  const root = document.documentElement;
  if (theme === 'auto'){
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    root.setAttribute('data-theme', prefersLight ? 'light' : 'dark');
  } else if (theme === 'dark'){
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

function saveTheme(theme){
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch(e) {
    console.warn('localStorage not available');
  }
}

function initTheme(){
  let saved = 'dark';
  try {
    saved = localStorage.getItem(THEME_KEY) || 'dark';
  } catch(e) {}
  
  if (el.themeSelect) el.themeSelect.value = saved;
  applyTheme(saved);
  
  const media = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    let cur = 'dark';
    try {
      cur = localStorage.getItem(THEME_KEY) || 'dark';
    } catch(e){}
    if (cur === 'auto') applyTheme('auto');
  };
  
  if (media.addEventListener) {
    media.addEventListener('change', onChange);
  }
  
  if (el.themeSelect) {
    el.themeSelect.addEventListener('change', (e) => {
      applyTheme(e.target.value);
    });
  }
}

/* ============================================================================
   AUTO-SCROLL MANAGEMENT
   ============================================================================ */

function getScrollContainer(){
  const play = document.getElementById('playarea');
  if (play){
    const cs = getComputedStyle(play);
    const scrollable = /(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow);
    if (scrollable) return play;
  }
  return document.scrollingElement || document.documentElement;
}

function bottombarHeight(){
  const bar = document.querySelector('.bottombar');
  return bar ? Math.ceil(bar.getBoundingClientRect().height) : 84;
}

function isNearBottom(threshold = 140){
  const sc = getScrollContainer();
  const remaining = sc.scrollHeight - (sc.scrollTop + sc.clientHeight);
  return remaining <= threshold;
}

function scrollToBottom(){
  const sc = getScrollContainer();
  const offset = bottombarHeight();
  const target = sc.scrollHeight - sc.clientHeight;
  
  if (sc === document.scrollingElement || sc === document.documentElement) {
    window.scrollTo({ top: target, behavior: 'smooth' });
    setTimeout(() => window.scrollBy({ top: -offset, behavior: 'smooth' }), 120);
  } else {
    sc.scrollTo({ top: target, behavior: 'smooth' });
    setTimeout(() => sc.scrollBy({ top: -offset, behavior: 'smooth' }), 120);
  }
}

function ensureAutoScrollWiring(){
  const onUserScroll = () => {
    scrollState.followLatest = isNearBottom();
  };
  
  window.addEventListener('scroll', onUserScroll, { passive:true });
  
  const sc = getScrollContainer();
  if (sc && sc !== document.scrollingElement && sc !== document.documentElement){
    sc.addEventListener('scroll', onUserScroll, { passive:true });
  }
  
  const lines = document.getElementById('lines');
  if (!lines) return;
  
  const mo = new MutationObserver((mutations) => {
    let added = false;
    for (const m of mutations){
      if (m.addedNodes && m.addedNodes.length) {
        added = true;
        break;
      }
    }
    if (added && scrollState.followLatest){
      requestAnimationFrame(() => scrollToBottom());
    }
  });
  
  mo.observe(lines, { childList: true });
  
  window.debugScroll = () => ({
    followLatest: scrollState.followLatest,
    nearBottom: isNearBottom(),
    sc: getScrollContainer(),
    h: getScrollContainer().scrollHeight,
    t: getScrollContainer().scrollTop,
    c: getScrollContainer().clientHeight
  });
}

/* ============================================================================
   UI FEEDBACK
   ============================================================================ */

function uiFlash(el, kind){
  if (el){
    const cls = kind==='ok' ? 'ui-valid' : 'ui-error';
    el.classList.remove(cls);
    void el.offsetHeight;
    el.classList.add(cls);
  }
  if (kind === 'ok'){ sfxOK(); buzz('ok'); }
  else { sfxNO(); buzz('no'); }
}

const toastUI = (() => {
  const t = document.getElementById('toast');
  let tid;
  return {
    show(msg, good=false, dur=ANIMATION_TIMINGS.TOAST_DURATION_MS){
      if (!t) return;
      t.textContent='';
      const ic = document.createElement('span');
      ic.innerHTML = good? '✔️':'';
      t.appendChild(ic);
      t.append(' ' + msg);
      t.classList.remove('hide','good','bad');
      t.classList.add('show', good? 'good':'bad');
      t.hidden=false;
      clearTimeout(tid);
      tid = setTimeout(()=>{
        t.classList.remove('show');
        t.classList.add('hide');
        setTimeout(()=>{ t.hidden=true; }, 140);
      }, dur);
    }
  };
})();

window.showToast = function(msg, good=false, dur=ANIMATION_TIMINGS.TOAST_DURATION_MS){
  toastUI.show(msg, good, dur);
};

/* ============================================================================
   FLIP ANIMATIONS
   ============================================================================ */

function measurePositions(container){
  const map = new Map();
  container.querySelectorAll('[data-id]').forEach(elm=>{
    const id = elm.dataset.id;
    const r = elm.getBoundingClientRect();
    map.set(id, r);
  });
  return map;
}

function playFlip(container, beforeMap, afterMap){
  afterMap.forEach((newRect, id)=>{
    const el = container.querySelector(`[data-id="${id}"]`);
    const oldRect = beforeMap.get(id);
    if (!el || !oldRect) return;
    
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (dx===0 && dy===0) return;
    
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    
    requestAnimationFrame(()=>{
      el.style.transition = `transform ${ANIMATION_TIMINGS.FLIP_DURATION_MS}ms ease`;
      el.style.transform = '';
      
      const cleanup = ()=>{
        el.style.transition='';
        el.removeEventListener('transitionend', cleanup);
      };
      el.addEventListener('transitionend', cleanup, { once: true });
    });
  });
}

/* ============================================================================
   RENDERING
   ============================================================================ */

function updateScore(){
  if (el.scoreVal)  el.scoreVal.textContent  = String(state.score);
  if (el.streakVal) el.streakVal.textContent = String(state.streak);
  if (el.timerVal)  el.timerVal.textContent  = fmtTime(state.secs);
}


function render(){
  if (!el.lines) return;

  el.lines.innerHTML = '';
  assertWellFormedBoard(current.items);

  current.items.forEach((it, idx)=>{
    const btn = document.createElement('button');
    btn.setAttribute('role','option');
    btn.setAttribute('aria-pressed','false');
    btn.className = 'line';
    btn.style.cursor = 'pointer';
    btn.dataset.index = idx;
    btn.dataset.id = it.id;

    try{
      if (it.kind === 'imp') {
        // Split into left (antecedent) and right (consequent) spans
        btn.innerHTML = `
          <span class="expr">
            <span class="ante-part">${exprText(it.left, true)}</span>
            <span class="arrow"> → </span>
            <span class="cons-part">${exprText(it.right, true)}</span>
          </span>`;
      } else if (it.kind === 'ante' || it.kind === 'derived') {
        btn.innerHTML = `<span class="line-text">${exprText(it.expr)}</span>`;
      } else if (it.kind === 'conj') {
        btn.innerHTML = `<span class="line-text">${exprText(it.left, true)} ∧ ${exprText(it.right, true)}</span>`;
      } else {
        btn.textContent = '[invalid]';
      }
    }catch(e){
      console.error('Render error at index', idx, e);
      btn.textContent = '[invalid]';
    }

    btn.addEventListener('click', onSelect);
    btn.addEventListener('keydown', (e)=>{
      if(e.key==='Enter' || e.key===' '){
        e.preventDefault();
        btn.click();
      }
    });

    el.lines.appendChild(btn);
  });

  updateScore();
}



/* ============================================================================
   EVENT HANDLERS
   ============================================================================ */

function lock(ms=ANIMATION_TIMINGS.LOCK_MS){
  state.locked=true;
  setTimeout(()=>state.locked=false, ms);
}

function onSelect(e){
  if(state.locked) return;
  
  // Arm SFX
  if (SFX_MODE === 'files') armSfxFilesOnce();
  else if (SFX_MODE === 'synth') audioCtx();
  
  const btn = e.currentTarget;
  const idx = Number(btn.dataset.index);
  const item = current.items[idx];
  
  // Toggle selection
  if (btn.getAttribute('aria-pressed')==='true'){
    btn.setAttribute('aria-pressed','false');
    state.selected = state.selected.filter(i=>i!==idx);
    return;
  }
  
  // Select
  btn.setAttribute('aria-pressed','true');
  state.selected.push(idx);
  if (navigator.vibrate) navigator.vibrate(10);
  
  if(state.selected.length===2){
    lock();
    const [i,j] = state.selected.map(Number);
    const a = current.items[i];
    const b = current.items[j];
    const ok = isValidPair(a,b);
    
    if(ok){
      state.score++;
      state.streak++;
      uiFlash(btn, 'ok');
      uiFlash(el.score, 'ok');
      toastUI.show('Correct! +1', true);
      handleCorrectPair(i,j,a,b);
    } else {
      state.streak = 0;
      uiFlash(btn, 'no');
      toastUI.show('Not a valid pair', false, 800);
      
      setTimeout(()=>{
        document.querySelectorAll('#lines button').forEach(b=>b.setAttribute('aria-pressed','false'));
        state.selected=[];
      }, 180);
    }
    updateScore();
  }
}

function handleCorrectPair(i, j){
  // Determine which index is antecedent-like vs implication
  const anteIdx = (current.items[i].kind === 'ante' || current.items[i].kind === 'derived') ? i : j;
  const impIdx  = (anteIdx === i) ? j : i;

  const anteLine = current.items[anteIdx];
  const impLine  = current.items[impIdx];
  const anteId = anteLine?.id;
  const impId  = impLine?.id;

  const anteEl = el.lines.querySelector(`[data-id="${anteId}"]`);
  const impEl  = el.lines.querySelector(`[data-id="${impId}"]`);
  if (!anteEl || !impEl || !impLine || impLine.kind !== 'imp'){
    return replaceWithConsequentAndRefill(anteIdx, impIdx);
  }

  // Highlight text we want to glow/scale
  const anteTextEl  = anteEl.querySelector('.line-text') || anteEl;
  const impAnteText = impEl.querySelector('.ante-part')   || impEl;

  anteEl.classList.add('glow');
  impEl.classList.add('glow', 'merge-over');
  anteTextEl.classList.add('glow-text','scale-up');
  impAnteText.classList.add('glow-text','scale-up');

  // FLIP-style ghost drifting from antecedent to conditional
  const gridRect = el.lines.getBoundingClientRect();
  const r1 = anteEl.getBoundingClientRect();
  const r2 = impEl.getBoundingClientRect();
  const dx = (r2.left - r1.left);
  const dy = (r2.top  - r1.top);

  const ghost = anteEl.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.style.left   = `${r1.left - gridRect.left}px`;
  ghost.style.top    = `${r1.top  - gridRect.top}px`;
  ghost.style.width  = `${r1.width}px`;
  ghost.style.height = `${r1.height}px`;

  // Hide the real antecedent during drift
  anteEl.style.visibility = 'hidden';
  el.lines.appendChild(ghost);

  requestAnimationFrame(()=>{
    ghost.style.transform = `translate(${dx}px, ${dy}px)`;
    ghost.style.opacity = '0.92';
  });

  setTimeout(()=>{
    // Clean up glow visuals
    anteEl.classList.remove('glow');
    impEl.classList.remove('glow', 'merge-over');
    anteTextEl.classList.remove('glow-text','scale-up');
    impAnteText.classList.remove('glow-text','scale-up');

    // Build consequent
    const consequent = mkLineAnte(impLine.right);
    
    // Clone array with consequent in place
    let next = [...current.items];
    next[impIdx] = consequent;
    
    // Temporarily remove the antecedent slot to analyze what we have
    const beforeFiller = next.filter((_, idx) => idx !== anteIdx);
    const { anteMap, impMap } = analyzeBoardState(beforeFiller);
    
    // Count pairs without the filler
    const pairCountBefore = distinctPairKeys(beforeFiller).size;
    
    let filler;
    
    // If we'll have fewer than 2 pairs, make filler create a match
    if (pairCountBefore < 2) {
      // Try to find an implication that needs an antecedent
      const impNeedingAnte = [...impMap.keys()].find(k => !anteMap.has(k));
      if (impNeedingAnte) {
        // Filler becomes the matching antecedent
        const leftExpr = beforeFiller.find(l => l.kind==='imp' && exprKey(l.left)===impNeedingAnte)?.left;
        filler = mkLineAnte(cloneExpr(leftExpr));
      } else {
        // Try to find an antecedent that needs an implication
        const anteNeedingImp = [...anteMap.keys()].find(k => !impMap.has(k));
        if (anteNeedingImp) {
          // Filler becomes the matching implication
          const leftExpr = beforeFiller.find(l => (l.kind==='ante'||l.kind==='derived') && exprKey(l.expr)===anteNeedingImp)?.expr;
          const rightExpr = pickExprByDifficulty(gameOpts);
          filler = mkLineImp(cloneExpr(leftExpr), rightExpr);
        } else {
          // Create a brand new matching pair - filler is the antecedent
          const leftExpr = mkAtom(pickSymbol());
          const rightExpr = pickExprByDifficulty(gameOpts);
          filler = mkLineAnte(cloneExpr(leftExpr));
          // Add the matching implication
          next.push(mkLineImp(cloneExpr(leftExpr), rightExpr));
        }
      }
    } else {
      // We have enough pairs, so filler can be a distractor
      const forbidden = exprKey(impLine.left);
      filler = genDistractorAvoiding(forbidden);
    }
    
    // Place the filler
    next[anteIdx] = filler;

    // Validate everything
    try { assertWellFormedBoard(next); } catch(e){ console.warn('Post-merge validation', e); }

    current.items = next;
    state.selected = [];
    render();

    // Pulse the newly inserted consequent
    const newConsEl = el.lines.querySelector(`[data-id="${consequent.id}"]`);
    if (newConsEl){
      newConsEl.classList.add('consequent', 'consequent-pulse');
      setTimeout(()=> newConsEl.classList.remove('consequent', 'consequent-pulse'),
        ANIMATION_TIMINGS.CONSEQUENT_HIGHLIGHT_MS);
    }

    ghost.remove();
    anteEl.style.visibility = '';
  }, ANIMATION_TIMINGS.MERGE_SLIDE_MS);
}



/* ============================================================================
   GAME CONTROL
   ============================================================================ */

function startGame(mode){
  if (!mode || !modes[mode]){
    console.warn('startGame called with invalid mode:', mode);
    return;
  }
  
  gameOpts = {...modes[mode]};
  history = [];
  state.score = 0;
  state.streak = 0;
  state.selected = [];
  current.items = [];
  
  render();
  startTimer();
  
  try{ assertWellFormedBoard(current.items); }
  catch(e){ console.warn('startGame pre-assert failed', e); }
  
  current.items = ensureAtLeastKPairs(current.items, 2, gameOpts);
  
  try{ assertWellFormedBoard(current.items); }
  catch(e){ console.warn('startGame post-assert failed', e); }
  
  if (el.menu) el.menu.hidden = true;
  
  render();
  scrollState.followLatest = true;
  
  console.log('[pairs/distinct]', distinctPairKeys(current.items).size, 'of', current.items.length);
  
  if (scrollState.followLatest) {
    requestAnimationFrame(() => scrollToBottom());
  }
}

function safeStart(){
  if (el.menu) el.menu.hidden = true;
  
  const L = [];
  L.push(mkLineImp(mkAtom('A'), mkAtom('B')));
  L.push(mkLineAnte(mkAtom('A')));
  L.push(mkLineImp(mkAtom('C'), mkAtom('D')));
  L.push(mkLineAnte(mkAtom('C')));
  L.push(mkLineAnte(mkAtom('E')));
  L.push(mkLineConj(mkAtom('F'), mkAtom('G')));
  
  current.items = L;
  
  try{ assertWellFormedBoard(current.items); }
  catch(e){ console.error('[SAFE] initial board validation failed', e); }
  
  render();
  console.log('[SAFE] started, pairs/distinct =', distinctPairKeys(current.items).size);
}

/* ============================================================================
   SETTINGS HANDLERS
   ============================================================================ */

function openSettings(){
  if (el.settingsPanel) el.settingsPanel.hidden = false;
  const current = localStorage.getItem(THEME_KEY) || 'dark';
  if (el.themeSelect) el.themeSelect.value = current;
  if (el.settingsPanel) el.settingsPanel._previewOriginal = current;
}

function closeSettings(){
  if (el.settingsPanel) el.settingsPanel.hidden = true;
  scrollState.followLatest = true;
}

/* ============================================================================
   INITIALIZATION
   ============================================================================ */

function initMenu(){
  const menu = el.menu;
  if (!menu) return console.warn('[menu] not found');
  
  menu.addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-diff]');
    if(!btn) return;
    e.preventDefault();
    
    const diff = btn.dataset.diff;
    console.log('[start] diff =', diff);
    
    startGame(diff);
    
    const menuElNow = document.getElementById('menu');
    if (menuElNow) menuElNow.hidden = true;
    
    const play = document.getElementById('playarea');
    if (play) play.hidden = false;
    
    console.log('[overlay state]', {
      menuHidden: !!document.getElementById('menu')?.hidden,
      settingsHidden: !!document.getElementById('settings-panel')?.hidden
    });
  });
  
  const form = document.querySelector('#menu form');
  if (form) {
    form.addEventListener('submit', (e)=> e.preventDefault());
  }
}

function initSettings(){
  if (!el.settingsBtn || !el.settingsPanel) return;
  
  el.settingsBtn.addEventListener('click', openSettings);
  
  const confirmBtn = document.getElementById('settings-confirm');
  const cancelBtn = document.getElementById('settings-cancel');
  const changeDiffBtn = document.getElementById('settings-change-diff');
  
  if (confirmBtn) {
    confirmBtn.addEventListener('click', ()=>{
      const v = el.themeSelect.value;
      saveTheme(v);
      el.settingsPanel.hidden = true;
      delete el.settingsPanel._previewOriginal;
    });
  }
  
  if (cancelBtn) {
    cancelBtn.addEventListener('click', ()=>{
      const prev = el.settingsPanel._previewOriginal || localStorage.getItem(THEME_KEY) || 'dark';
      applyTheme(prev);
      if (el.themeSelect) el.themeSelect.value = prev;
      el.settingsPanel.hidden = true;
      delete el.settingsPanel._previewOriginal;
    });
  }
  
  if (changeDiffBtn) {
    changeDiffBtn.addEventListener('click', ()=>{
      if (el.menu) el.menu.hidden = false;
      el.settingsPanel.hidden = true;
      scrollState.followLatest = true;
    });
  }
  
  el.settingsPanel.addEventListener('click', e => {
    if(e.target === el.settingsPanel) {
      const prev = el.settingsPanel._previewOriginal || localStorage.getItem(THEME_KEY) || 'dark';
      applyTheme(prev);
      if (el.themeSelect) el.themeSelect.value = prev;
      el.settingsPanel.hidden = true;
      delete el.settingsPanel._previewOriginal;
    }
  });
  
  if (el.themeSelect) {
    el.themeSelect.addEventListener('change', e => {
      applyTheme(e.target.value);
    });
  }
}

function initControls(){
  if (el.reset) {
    el.reset.addEventListener('click', ()=>{
      state.score=0;
      state.streak=0;
      state.selected=[];
      stopTimer(); startTimer();
      scrollState.followLatest = true;
      render();
      showToast('Reset', false);
    });
  }
  
  if (el.pause) {
    el.pause.addEventListener('click', ()=>{
      showToast('Paused – tap Reset to restart', false);
    });
  }
  
  const embedded = window.top !== window.self;
  if(embedded && el.iframeBanner){
    el.iframeBanner.hidden=false;
    if (el.openFull) el.openFull.href = window.location.href;
    if (el.dismissBanner) {
      el.dismissBanner.addEventListener('click', ()=>el.iframeBanner.hidden=true);
    }
  }
}

function initRender(){
  try{
    render();
  }catch(e){
    console.error('Initial render failed', e);
  }
}

function init(){
  initTheme();
  initMenu();
  initSettings();
  initControls();
  ensureAutoScrollWiring();
  
  if (SAFE_MODE){
    console.log('[SAFE] mode detected – starting safe board');
    safeStart();
  } else {
    initRender();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, {once:true});
} else {
  init();
}

// Register the service worker (only if PWA enabled in config)
if (config.pwaEnabled && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('./sw.js')
    .then(() => console.log('[PWA] Service Worker registered'))
    .catch(err => console.error('[PWA] Registration failed', err));
}


/* ============================================================================
   DEBUG HELPERS
   ============================================================================ */

window.forceStart = (diff='easy') => {
  if (el.menu) el.menu.hidden = true;
  console.log('[forceStart]', diff);
  startGame(diff);
};

window.seedBoardSanity = () => {
  const A = mkAtom('A'), B = mkAtom('B'), C = mkAtom('C'), D = mkAtom('D');
  const E = mkAtom('E'), F = mkAtom('F'), G = mkAtom('G');
  
  const lines = [
    { id:'s1', kind:'imp', left:cloneExpr(A), right:cloneExpr(B) },
    { id:'s2', kind:'ante', expr:cloneExpr(A) },
    { id:'s3', kind:'imp', left:cloneExpr(D), right:cloneExpr(E) },
    { id:'s4', kind:'ante', expr:cloneExpr(D) },
    { id:'s5', kind:'ante', expr:cloneExpr(C) },
    { id:'s6', kind:'conj', left:cloneExpr(F), right:cloneExpr(G) },
    { id:'s7', kind:'ante', expr:cloneExpr(E) },
    { id:'s8', kind:'imp', left:cloneExpr(C), right:cloneExpr(G) },
    { id:'s9', kind:'conj', left:cloneExpr(D), right:cloneExpr(C) }
  ];
  
  for (let i=0; i<lines.length; i++) normalizeLine(lines[i]);
  for (let i=0; i<lines.length; i++){
    if (!validateLine(lines[i])) {
      throw new Error('validator rejected sanity line: '+JSON.stringify(lines[i]));
    }
  }
  
  current.items = lines;
  history = [];
  state.score = 0;
  state.streak = 0;
  state.selected = [];
  render();
  console.log('[sanity] pairs/distinct =', distinctPairKeys(current.items).size, 'of', current.items.length);
};

window.__rp_diag = () => {
  const panel = document.getElementById('settings-panel');
  const menu = document.getElementById('menu');
  const lines = document.getElementById('lines');
  return {
    panelHidden: !!panel?.hasAttribute('hidden'),
    menuHidden:  !!menu?.hasAttribute('hidden'),
    linesEmpty:  !lines || !lines.children || lines.children.length === 0
  };
};

console.log('[overlay state]', {
  menuHidden: !!document.getElementById('menu')?.hidden,
  settingsHidden: !!document.getElementById('settings-panel')?.hidden
});
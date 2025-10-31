// Minimal engine test harness (Node-friendly) - extracted pure functions from app.js
// Deterministic RNG
function makeRng(seed=12345){ let s = seed >>> 0; return function rand(){ s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }
const rng = makeRng(12345);
const pick = (arr) => arr[Math.floor(rng()*arr.length)];

const SYMBOLS = ['A','B','C','D','E','F','G'];
function pickSymbol(excludeSet = new Set()){
  const choices = SYMBOLS.filter(s => !excludeSet.has(s));
  if (choices.length === 0) return SYMBOLS[0];
  return choices[Math.floor(rng() * choices.length)];
}

// Expr & Line factories
function mkAtom(sym){ return { kind: 'atom', sym: String(sym) }; }
function mkConj(l,r){ return { kind: 'conj', left: cloneExpr(l), right: cloneExpr(r) }; }
function mkImp(l,r){ return { kind: 'imp', left: cloneExpr(l), right: cloneExpr(r) }; }
function mkLineAnte(expr){ return { id: nextId(), kind: 'ante', expr: cloneExpr(expr) }; }
function mkLineImp(left, right){ return { id: nextId(), kind: 'imp', left: cloneExpr(left), right: cloneExpr(right) }; }
function mkLineConj(l,r){ return { id: nextId(), kind: 'conj', left: cloneExpr(l), right: cloneExpr(r) }; }

let _id = 1; function nextId(){ return 't' + (_id++); }

function exprText(e){ if (!e) return ''; const kind = e.kind || e.type; if (!kind) return ''; if (kind === 'atom') return (e.sym || e.v) || ''; if (kind === 'conj' || kind === 'and'){ const L = exprText(e.left); const R = exprText(e.right); return `(${L} ∧ ${R})`; } if (kind === 'imp' || kind === '->'){ const L = exprText(e.left); const R = exprText(e.right); return `(${L} → ${R})`; } return ''; }
function exprKey(e){ return exprText(e); }
function exprEquals(a,b){ return exprKey(a) === exprKey(b); }
function cloneExpr(e){ if (!e) return null; if (e.kind === 'atom') return { kind: 'atom', sym: e.sym }; if (e.kind === 'conj') return { kind: 'conj', left: cloneExpr(e.left), right: cloneExpr(e.right) }; if (e.kind === 'imp') return { kind: 'imp', left: cloneExpr(e.left), right: cloneExpr(e.right) }; if (e.type === 'atom') return { kind: 'atom', sym: e.v }; if (e.type === 'and') return { kind: 'conj', left: cloneExpr(e.left), right: cloneExpr(e.right) }; if (e.type === 'imp') return { kind: 'imp', left: cloneExpr(e.left), right: cloneExpr(e.right) }; return null; }

function keyOfLine(line){ if (!line || !line.kind) return 'UNKNOWN'; try{ if (line.kind === 'ante' || line.kind === 'derived') return `A:${exprKey(line.expr)}`; if (line.kind === 'imp') return `I:${exprKey(line.left)}->${exprKey(line.right)}`; if (line.kind === 'conj') return `C:${exprKey(line.left)}&${exprKey(line.right)}`; }catch(e){ return `BAD:${line.kind}:${line.id||Math.random()}`; } }

function normalizeLine(line){ if (!line || typeof line !== 'object') return line; if (line.kind === 'ante'){ if (!line.expr){ const sym = line.a || line.text || null; if (sym && typeof sym === 'string') line.expr = { kind: 'atom', sym: String(sym) }; } delete line.a; delete line.b; delete line.text; return line; } if (line.kind === 'imp'){ if (!line.left || !line.right){ if (line.a && line.b){ line.left = { kind: 'atom', sym: line.a }; line.right = { kind: 'atom', sym: line.b }; } else if (line.text && typeof line.text === 'string'){ const parts = line.text.split(/→|->/).map(s=>s.trim()).filter(Boolean); if (parts.length === 2){ line.left = { kind: 'atom', sym: parts[0] }; line.right = { kind: 'atom', sym: parts[1] }; } } } delete line.a; delete line.b; delete line.text; return line; } if (line.kind === 'conj'){ if (!line.left || !line.right){ if (line.text && typeof line.text === 'string'){ const parts = line.text.split(/∧|&/).map(s=>s.trim()).filter(Boolean); if (parts.length === 2){ line.left = { kind: 'atom', sym: parts[0] }; line.right = { kind: 'atom', sym: parts[1] }; } } } delete line.a; delete line.b; delete line.text; return line; } return line; }

function scanPairs(active){ const anteMap = new Map(); const impMap = new Map(); active.forEach(line => { const normalized = normalizeLine(line); if (normalized !== line){ const idx = active.indexOf(line); if (idx >= 0) active[idx] = normalized; line = normalized; } if (line.kind === 'ante' || line.kind === 'derived'){ if (!line.expr) return; const k = exprKey(line.expr); if (!anteMap.has(k)) anteMap.set(k, []); anteMap.get(k).push(line); } else if (line.kind === 'imp'){ if (!line.left) return; const k = exprKey(line.left); if (!impMap.has(k)) impMap.set(k, []); impMap.get(k).push(line); } }); const pairs = []; impMap.forEach((imps, key) => { const antes = anteMap.get(key) || []; imps.forEach(imp => { antes.forEach(ante => pairs.push({ anteLine: ante, impLine: imp })); }); }); return { pairs, anteMap, impMap }; }

function pickExprByDifficulty(opts = {}){
  // opts: allowConditional, maxDepthConj
  opts = opts || {};
  if (!opts.allowConditional && (opts.maxDepthConj || 0) <= 0){ // easy -> atom
    return mkAtom(pickSymbol());
  }
  // medium/hard: sometimes conj, sometimes atom
  const r = rng();
  if (opts.maxDepthConj > 0 && r < 0.3){ return mkConj(mkAtom(pickSymbol()), mkAtom(pickSymbol())); }
  if (opts.allowConditional && r < 0.6){ return mkImp(mkAtom(pickSymbol()), mkAtom(pickSymbol())); }
  return mkAtom(pickSymbol());
}

function makeDecoy(active, opts, anteMap, impMap, lineKeySet){ // try to create a line that doesn't introduce new pairs
  // prefer atoms as decoys
  const usedAtoms = new Set();
  active.forEach(l => { if (l.kind === 'ante' || l.kind === 'derived') usedAtoms.add(exprKey(l.expr)); if (l.kind === 'imp') { usedAtoms.add(exprKey(l.left)); usedAtoms.add(exprKey(l.right)); } if (l.kind === 'conj') { usedAtoms.add(exprKey(l.left)); usedAtoms.add(exprKey(l.right)); } });
  // pick an atom not used as antecedent (to avoid creating pairs)
  let sym = pickSymbol(usedAtoms);
  const atom = mkAtom(sym);
  const cand = mkLineAnte(atom);
  if (lineKeySet && lineKeySet.has(keyOfLine(cand))) return null;
  return cand;
}

function ensureAtLeastKPairs(active, K, opts){ for (let i=0;i<active.length;i++){ const nl = normalizeLine(active[i]); if (nl !== active[i]) active[i] = nl; } const N = (opts && opts.N) || 6; const maxLoop = 300; let loop = 0; const lineKey = new Set(active.map(keyOfLine)); while (true){ loop++; if (loop > maxLoop) break; const { pairs, anteMap, impMap } = scanPairs(active); if (pairs.length >= K) break; const impsNoAnte = []; active.forEach(l => { if (l.kind === 'imp' && !anteMap.has(exprKey(l.left))) impsNoAnte.push(l); }); if (impsNoAnte.length > 0){ const imp = impsNoAnte[0]; const newAnte = mkLineAnte(cloneExpr(imp.left)); const k = keyOfLine(newAnte); if (!lineKey.has(k)){ active.push(newAnte); lineKey.add(k); continue; } } const antesNoImp = []; active.forEach(l => { if ((l.kind === 'ante' || l.kind === 'derived') && !impMap.has(exprKey(l.expr))) antesNoImp.push(l); }); if (antesNoImp.length > 0){ const ante = antesNoImp[0]; const right = pickExprByDifficulty(opts); const newImp = mkLineImp(cloneExpr(ante.expr), cloneExpr(right)); const k = keyOfLine(newImp); if (!lineKey.has(k)){ active.push(newImp); lineKey.add(k); continue; } } const left = pickExprByDifficulty(opts); const right = pickExprByDifficulty(opts); const candidateImp = mkLineImp(left, right); const candidateAnte = mkLineAnte(left); const kImp = keyOfLine(candidateImp); const kAnte = keyOfLine(candidateAnte); if (!lineKey.has(kImp) && !lineKey.has(kAnte)){ active.push(candidateImp); active.push(candidateAnte); lineKey.add(kImp); lineKey.add(kAnte); continue; } } const maxAttempts = 200; let attempts = 0; while (active.length < N && attempts < maxAttempts){ attempts++; const { anteMap, impMap } = scanPairs(active); const dec = makeDecoy(active, opts, anteMap, impMap, lineKey); if (!dec) break; active.push(dec); lineKey.add(keyOfLine(dec)); } while (active.length > N) active.pop(); return active; }

module.exports = { mkAtom, mkLineAnte, mkLineImp, mkLineConj, scanPairs, ensureAtLeastKPairs, pickExprByDifficulty, keyOfLine, exprKey, mkConj, mkImp };

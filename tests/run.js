#!/usr/bin/env node
// Unit tests for the pure logic inside index.html.
//   node tests/run.js
// Exits non-zero if anything fails, so it can gate a commit or CI.
const { SRC, slice, load } = require('./extract');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { pass++; results.push(['PASS', name, '']); }
  else { fail++; results.push(['FAIL', name, detail || '']); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
function near(name, got, want, tol) { ok(name, Math.abs(got - want) <= tol, `got ${got} want ~${want}`); }
function group(g) { results.push(['GROUP', g, '']); }

const line = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
const osc  = (mid, amp, n) => Array.from({ length: n }, (_, i) => mid + amp * Math.sin(i / 6));

// ── XIRR ────────────────────────────────────────────────────────────────────
group('xirr — money-weighted returns');
{
  const { xirr } = load(slice('function xirr(cfs){', 'function cMF(f){', 'xirr'), ['xirr']);
  const d = s => new Date(s);
  near('lump sum +10% over 1y', xirr([{date:d('2024-01-01'),amount:-1000},{date:d('2025-01-01'),amount:1100}]), 10, 0.1);
  near('lump sum -20% over 2y', xirr([{date:d('2023-01-01'),amount:-100000},{date:d('2025-01-01'),amount:80000}]), -10.56, 0.2);
  const sip = []; for (let m = 0; m < 12; m++) sip.push({ date: new Date(2024, m, 1), amount: -5000 });
  sip.push({ date: new Date(2025, 0, 1), amount: 66000 });
  const r = xirr(sip);
  ok('12x5000 -> 66000 is money-weighted (> simple 10%)', r > 15 && r < 25, `got ${r}`);
  eq('all-outflow returns null', xirr([{date:d('2024-01-01'),amount:-1},{date:d('2025-01-01'),amount:-1}]), null);
  eq('single cashflow returns null', xirr([{date:d('2024-01-01'),amount:-1}]), null);
}

// ── RSI / EMA single source of truth ───────────────────────────────────────
group('indicators — one implementation, reused');
{
  const { calcEMA, calcRSI } = load(
    slice('function calcEMA(closes, period) {', 'function calcMACD', 'calcEMA/calcRSI'),
    ['calcEMA', 'calcRSI']);
  const v = []; let p = 100;
  for (let i = 0; i < 300; i++) { p *= 1 + ((Math.sin(i/3) + Math.sin(i/7) * 0.6) / 100); v.push(+p.toFixed(4)); }
  const rsi = calcRSI(v, 14);
  eq('RSI warms up at index = period', rsi.findIndex(x => x != null), 14);
  ok('RSI stays within 0..100', rsi.every(x => x == null || (x >= 0 && x <= 100)), 'out of range');
  const ema = calcEMA(v, 20);
  eq('EMA has one value per bar', ema.length, v.length);
  ok('EMA tracks price', Math.abs(ema[ema.length-1] - v[v.length-1]) < v[v.length-1] * 0.2, 'EMA drifted');
  // A flat series must pin RSI at 100 by definition (no losses at all).
  const flat = new Array(60).fill(50);
  eq('flat series RSI is defined', calcRSI(flat, 14)[20] != null, true);
}

// ── Momentum engine (JS mirror of the Pyodide engine) ──────────────────────
group('momentum engine — whipsaw resistance');
{
  const { calcEMA, calcRSI } = load(
    slice('function calcEMA(closes, period) {', 'function calcMACD', 'calcEMA/calcRSI'),
    ['calcEMA', 'calcRSI']);
  const body = slice('const _jsCalc = (a) => {', '\n        const _render', '_jsCalc');
  const { _jsCalc } = load(body.replace(/^const _jsCalc/, 'var _jsCalc'), ['_jsCalc'], { calcEMA, calcRSI });
  // The dip must be deep enough to actually break the hold band (close >
  // EMA20 * 0.985). EMA20 lags a strong uptrend, so a shallow 3% dip still
  // sits above the band and would exercise nothing - an earlier version of
  // this test passed for exactly that wrong reason. A 13% single-bar drop is
  // the shallowest that reaches the grace path here.
  let c = new Array(60).fill(100);
  for (let i = 0; i < 40; i++) c.push(c[c.length-1] * 1.012);
  const peak = c[c.length-1];
  c.push(peak * 0.87);                                // one bar below the band
  c.push(peak * 1.002);                               // recovers immediately
  for (let i = 0; i < 8; i++) c.push(c[c.length-1] * 1.004);
  for (let i = 0; i < 30; i++) c.push(c[c.length-1] * 0.985);
  const res = _jsCalc(c);
  const entries = res.state.filter(s => s === 'B').length;
  let flips = 0; for (let i = 1; i < res.state.length; i++) if ((res.state[i]==null) !== (res.state[i-1]==null)) flips++;
  eq('one entry per genuine trend', entries, 1);
  eq('single dip does not end the run (grace)', res.state[100], 'H');
  eq('and does not cause a re-entry', entries, 1);
  ok('no whipsaw churn', flips <= 2, `flips=${flips}`);
  eq('run is closed after a real breakdown', res.state[res.state.length-1], null);
}

// ── DVM scoring ────────────────────────────────────────────────────────────
group('DVM scores');
{
  const { computeDVM } = load(slice('function computeDVM(ar){', 'function renderDVMBadges()', 'computeDVM'), ['computeDVM']);
  const mk = (gen, sig) => {
    const data = [], closes = []; let p = 100;
    for (let i = 0; i < 400; i++) { p = gen(p, i); const c = +p.toFixed(2);
      data.push({ date: new Date(2023,0,1+i), open:c, high:c*1.01, low:c*0.99, close:c, volume:1000 }); closes.push(c); }
    const sma = (a,per) => a.map((_,i) => { if (i<per-1) return null; let s=0; for (let k=i-per+1;k<=i;k++) s+=a[k]; return s/per; });
    return { data, closes, currentPrice: closes[closes.length-1], sma50: sma(closes,50), sma200: sma(closes,200), signals: sig };
  };
  const up = computeDVM(mk(p => p*1.004, { rsiV:68, stV:1 }));
  const dn = computeDVM(mk(p => p*0.997, { rsiV:33, stV:-1 }));
  ok('uptrend scores high durability + momentum', up.d > 70 && up.m > 70, JSON.stringify(up));
  ok('uptrend scores low valuation (extended)', up.v < 30, JSON.stringify(up));
  ok('downtrend scores low durability + momentum', dn.d < 40 && dn.m < 40, JSON.stringify(dn));
  ok('downtrend scores high valuation (cheap)', dn.v > 70, JSON.stringify(dn));
  const base = mk(p => p*1.003, { rsiV:65, stV:1 });
  eq('no fundamentals -> technical proxy', computeDVM(base).vSource, 'technical');
  base.fundamentals = { pe:9, peg:0.7, pb:1.2 };
  const cheap = computeDVM(base);
  eq('cheap fundamentals -> fundamental source', cheap.vSource, 'fundamental');
  ok('cheap fundamentals score high', cheap.v > 80, `v=${cheap.v}`);
  base.fundamentals = { pe:55, peg:3.0, pb:9 };
  ok('expensive fundamentals score low', computeDVM(base).v < 20, 'expected low V');
  base.fundamentals = { roe:18 };
  eq('no valuation fields -> falls back to proxy', computeDVM(base).vSource, 'technical');
  ok('all scores clamp to 0..100', [up,dn].every(s => [s.d,s.v,s.m].every(x => x>=0 && x<=100)), 'out of range');
}

// ── Trend vs range classifier ──────────────────────────────────────────────
group('trend vs trading range');
{
  // Mirrors the classifier in the pattern fallback.
  const classify = (closes, hi, lo) => {
    const price = closes[closes.length-1], first = closes[0];
    const drift = first ? (price-first)/first*100 : 0;
    const travel = hi > lo ? Math.abs(first-price)/(hi-lo) : 0;
    const trending = Math.abs(drift) > 15 && travel > 0.55;
    return trending ? (drift < 0 ? 'Downtrend' : 'Uptrend') : 'Trading Range';
  };
  ok('classifier source still present in app', SRC.includes('_travel > 0.55'), 'travel-ratio gate missing');
  eq('reported 51% crash', classify(line(1200,588,150), 1211, 538), 'Downtrend');
  eq('its recent 90-bar leg', classify(line(800,588,90), 800, 538), 'Downtrend');
  eq('true sideways', classify(osc(670,120,90), 800, 540), 'Trading Range');
  eq('mild drift', classify(line(600,660,90), 800, 540), 'Trading Range');
  eq('strong uptrend', classify(line(500,900,90), 910, 495), 'Uptrend');
  eq('volatile but flat', classify(osc(700,250,90), 950, 450), 'Trading Range');
  eq('V-shaped recovery', classify([...line(900,600,45), ...line(600,890,45)], 910, 595), 'Trading Range');
  eq('shallow decline', classify(line(700,650,90), 760, 600), 'Trading Range');
}

// ── NAV on a date ──────────────────────────────────────────────────────────
group('historical NAV lookup');
{
  const src = slice('window.mfNavOnDate = function(ser, dateStr){', '\nwindow.mfFormFind', 'mfNavOnDate');
  const { mfNavOnDate } = load('var window={};' + src + '\nvar mfNavOnDate=window.mfNavOnDate;', ['mfNavOnDate']);
  const ser = [
    { t: new Date(2024,0,5).getTime(), nav: 10 },
    { t: new Date(2024,0,8).getTime(), nav: 11 },
    { t: new Date(2024,0,10).getTime(), nav: 12 },
  ];
  eq('exact trading day', mfNavOnDate(ser, '2024-01-08'), 11);
  eq('weekend falls back to prior Friday', mfNavOnDate(ser, '2024-01-07'), 10);
  eq('holiday gap uses prior day', mfNavOnDate(ser, '2024-01-09'), 11);
  eq('after series end uses latest', mfNavOnDate(ser, '2024-01-20'), 12);
  eq('before fund history is null', mfNavOnDate(ser, '2023-12-01'), null);
  eq('empty series is null', mfNavOnDate([], '2024-01-08'), null);
}

// ── Portfolio persistence under quota pressure ─────────────────────────────
group('portfolio persistence — never lose data silently');
{
  const src = slice("const _PORTFOLIO_KEY='imp_data';", '/* ══ DIAGNOSTICS ══', 'saveLocal');
  let LIMIT = 1000;
  function mkLS() {                      // keys are enumerable own props, as in browsers
    const ls = {};
    const size = () => Object.keys(ls).reduce((s,k) => s + k.length + String(ls[k]).length, 0);
    Object.defineProperties(ls, {
      getItem: { value: k => Object.prototype.hasOwnProperty.call(ls,k) ? ls[k] : null },
      removeItem: { value: k => { delete ls[k]; } },
      setItem: { value: (k,v) => { const prev = ls[k]; delete ls[k];
        if (size() + k.length + String(v).length > LIMIT) { if (prev !== undefined) ls[k] = prev; throw new Error('QuotaExceededError'); }
        ls[k] = v; } },
    });
    return ls;
  }
  const mkEnv = (store, S) => ({
    localStorage: store,
    document: { getElementById: () => null, createElement: () => ({ style:{}, set innerHTML(v){}, appendChild(){} }), body:{ appendChild(){} } },
    S, toast: () => {}, _logErr: () => {}, window: {},
  });
  const S = { indEQ: [{ t: 'X'.repeat(300) }] };

  let store = mkLS();
  let { saveLocal } = load(src.replace(/^const /gm, 'var '), ['saveLocal'], mkEnv(store, S));
  eq('saves when there is room', saveLocal(), true);
  eq('written value round-trips', store.getItem('imp_data'), JSON.stringify(S));

  store = mkLS();
  for (let i = 0; i < 4; i++) store.setItem('ohlcv_v6_S'+i, JSON.stringify({ ts: 1000+i, rows: 'z'.repeat(150) }));
  ({ saveLocal } = load(src.replace(/^const /gm, 'var '), ['saveLocal'], mkEnv(store, S)));
  eq('evicts caches under real pressure', saveLocal(), true);
  eq('portfolio persisted after eviction', store.getItem('imp_data'), JSON.stringify(S));
  eq('oldest cache evicted first', 'ohlcv_v6_S0' in store, false);

  store = mkLS(); store.setItem('foreignApp', 'q'.repeat(950));
  ({ saveLocal } = load(src.replace(/^const /gm, 'var '), ['saveLocal'], mkEnv(store, S)));
  eq('fails loudly when space cannot be freed', saveLocal(), false);
  eq('non-evictable data is never touched', store.getItem('foreignApp').length, 950);
}

// ── Glossary decoration (needs jsdom; skipped when unavailable) ─────────────
group('glossary popovers');
{
  let JSDOM = null;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {}
  if (!JSDOM) {
    results.push(['SKIP', 'glossary DOM tests (install jsdom to enable)', '']);
  } else {
    const src = slice('const GLOSSARY = {', 'function glossaryHide(){', 'glossary');
    const dom = new JSDOM('<div id="r"></div>');
    const { glossaryScan, GLOSSARY } = load(src.replace(/^const /gm, 'var '), ['glossaryScan','GLOSSARY'],
      { document: dom.window.document, NodeFilter: dom.window.NodeFilter, window: dom.window });
    const r = dom.window.document.getElementById('r');
    r.innerHTML = `<div><b>Momentum (RSI 62)</b> and RSI again. ADX 31, ATR 48.</div>
      <div title="RSI in title" data-x="MACD in attr">attrs</div>
      <div>Cup &amp; Handle, Risk : Reward, Max Drawdown, XIRR, P/E, PEG.</div>
      <input value="RSI untouched"><select><option>MACD option</option></select>`;
    const before = r.textContent;
    glossaryScan(r);
    const terms = [...r.querySelectorAll('.g-term')];
    ok('wraps known terms', terms.length >= 8, `only ${terms.length}`);
    eq('text content is unchanged', r.textContent, before);
    eq('attributes are not corrupted', r.querySelector('[data-x]').getAttribute('data-x'), 'MACD in attr');
    eq('title attribute intact', r.querySelector('[title]').getAttribute('title'), 'RSI in title');
    eq('inputs untouched', r.querySelector('input').value, 'RSI untouched');
    eq('options untouched', r.querySelector('option').children.length, 0);
    eq('one popover per term', terms.length, new Set(terms.map(t => t.dataset.g)).size);
    ok('every key resolves to an entry', terms.every(t => !!GLOSSARY[t.dataset.g]), 'unknown key');
    const n1 = terms.length;
    glossaryScan(r); glossaryScan(r);
    eq('re-scanning is idempotent', r.querySelectorAll('.g-term').length, n1);
  }
}

// ── Watchlist presets ──────────────────────────────────────────────────────
group('watchlist presets');
{
  const src = slice('const WATCHLIST_PRESETS = {', 'function screenAddSymbol() {', 'presets');
  let LS = {}, TOASTS = [];
  const env = {
    localStorage: { getItem: k => (k in LS ? LS[k] : null), setItem: (k,v) => { LS[k] = v; }, removeItem: k => { delete LS[k]; } },
    toast: (m) => TOASTS.push(m), confirm: () => true, renderWatchlistChips: () => {},
  };
  const preamble = `
    const SCREEN_WL_KEY='asa_watchlist';
    function screenGetWatchlist(){try{const v=JSON.parse(localStorage.getItem(SCREEN_WL_KEY));return Array.isArray(v)?v:[];}catch(e){return [];}}
    function screenSaveWatchlist(l){try{localStorage.setItem(SCREEN_WL_KEY,JSON.stringify([...new Set(l)].slice(0,60)));}catch(e){}}
  `;
  const api = load(preamble + src.replace(/^const /gm, 'var ').replace(/^function /gm, 'var _x_=0; function '),
    ['WATCHLIST_PRESETS','screenLoadPreset','screenClearWatchlist','screenGetWatchlist','screenSaveWatchlist'], env);
  const { WATCHLIST_PRESETS: P, screenLoadPreset, screenClearWatchlist, screenGetWatchlist, screenSaveWatchlist } = api;
  const basket = P.icici_momentum_aug26;

  eq('preset defines 20 symbols', basket.symbols.length, 20);
  eq('no duplicate tickers', new Set(basket.symbols.map(x => x[0])).size, 20);
  ok('tickers are uppercase and non-empty', basket.symbols.every(([s]) => s && s === s.toUpperCase()), 'bad ticker');

  LS = {}; TOASTS = []; screenLoadPreset('icici_momentum_aug26');
  eq('loads the whole basket', screenGetWatchlist().length, 20);
  eq('stored as SYM|EXCH', screenGetWatchlist()[0], 'ACE|NSE');
  ok('M&M survives storage', screenGetWatchlist().includes('M&M|NSE'), 'M&M missing');

  TOASTS = []; screenLoadPreset('icici_momentum_aug26');
  eq('re-loading does not duplicate', screenGetWatchlist().length, 20);
  ok('says everything was already present', /already on your watchlist/.test(TOASTS[0] || ''), TOASTS[0]);

  LS = {}; screenSaveWatchlist(['TCS|NSE','INFY|NSE']); screenLoadPreset('icici_momentum_aug26');
  ok('merges instead of replacing', screenGetWatchlist().includes('TCS|NSE'), 'existing symbol lost');
  eq('merged total', screenGetWatchlist().length, 22);

  LS = {}; screenSaveWatchlist(Array.from({length:50}, (_,i) => 'X'+i+'|NSE')); TOASTS = [];
  screenLoadPreset('icici_momentum_aug26');
  eq('caps the watchlist at 60', screenGetWatchlist().length, 60);
  ok('warns rather than dropping silently', /skipped \(60 max\)/.test(TOASTS[0] || ''), TOASTS[0]);

  LS = {}; screenLoadPreset('icici_momentum_aug26'); screenClearWatchlist();
  eq('clear empties the watchlist', screenGetWatchlist().length, 0);
  LS = {}; screenLoadPreset('does-not-exist');
  eq('unknown preset is a no-op', screenGetWatchlist().length, 0);

  // Tickers containing "&" must be escaped or the path is truncated.
  const url = k => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(k)}?period1=1&period2=2&interval=1d`;
  ok('M&M.NS is escaped in the fetch URL', url('M&M.NS').includes('M%26M.NS'), url('M&M.NS'));
  ok('ordinary tickers are untouched', url('HAL.NS').includes('/chart/HAL.NS?'), url('HAL.NS'));
  ok('fetch URL actually uses encodeURIComponent', SRC.includes('chart/${encodeURIComponent(key)}'), 'symbol not encoded');
}

// ── Build integrity ────────────────────────────────────────────────────────
group('build — index.html matches src/');
{
  const { execFileSync } = require('child_process');
  let synced = true, msg = '';
  try { execFileSync(process.execPath, [require('path').join(__dirname, '..', 'build.js'), '--check'], { stdio: 'pipe' }); }
  catch (e) { synced = false; msg = String(e.stdout || e.message).trim().split('\n')[0]; }
  ok('index.html is in sync with src/ (run `node build.js`)', synced, msg);
}

// ── Report ─────────────────────────────────────────────────────────────────
const W = 52;
for (const [kind, name, detail] of results) {
  if (kind === 'GROUP') { console.log(`\n\x1b[1m${name}\x1b[0m`); continue; }
  const tag = kind === 'PASS' ? '\x1b[32mPASS\x1b[0m' : kind === 'SKIP' ? '\x1b[33mSKIP\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${name.padEnd(W)}${detail ? '  ' + detail : ''}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
// Async assertions register here; the report waits for them. Never `return`
// from module scope in this file - it silently ends the run with no output.
const pending = [];

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

// ── Fetch failure reporting ────────────────────────────────────────────────
group('fetch diagnostics — say which source failed and why');
{
  const src = slice('  const _hostOf = u =>', '  async function _tryOne(strat) {', 'fetch helpers');
  const { _hostOf, _whyOf } = load(src.replace(/^\s*const /gm, 'var '), ['_hostOf', '_whyOf']);
  eq('host from allorigins URL', _hostOf('https://api.allorigins.win/raw?url=x'), 'api.allorigins.win');
  eq('host from corsproxy URL', _hostOf('https://corsproxy.io/?url=x'), 'corsproxy.io');
  eq('host from codetabs URL', _hostOf('https://api.codetabs.com/v1/proxy?quest=y'), 'api.codetabs.com');
  eq('malformed URL still returns a string', typeof _hostOf('not a url'), 'string');
  eq('CORS / offline is classified', _whyOf(new TypeError('Failed to fetch')), 'blocked / unreachable');
  // The message must report the budget actually used. It said "7s" long after
  // the proxy budget moved to 15s, making a slow relay look twice as healthy.
  eq('proxy timeout reports its real budget',
     _whyOf(Object.assign(new Error('aborted'), { name:'AbortError' }), 15000), 'timed out (15s)');
  eq('direct-call timeout reports its real budget',
     _whyOf(Object.assign(new Error('aborted'), { name:'AbortError' }), 8000), 'timed out (8s)');
  eq('missing budget falls back sensibly',
     _whyOf(Object.assign(new Error('aborted'), { name:'AbortError' })), 'timed out (8s)');
  ok('no hard-coded 7s message remains', !SRC.includes("timed out (7s)"), 'stale message');
  eq('HTTP status is preserved', _whyOf(new Error('HTTP 429')), 'HTTP 429');
  eq('provider rate-limit is preserved', _whyOf(new Error('AV rate-limit')), 'AV rate-limit');
  eq('empty error is not reported as "Error"', _whyOf(new Error('')), 'unknown');
  eq('null error handled', _whyOf(null), 'unknown');
  eq('undefined error handled', _whyOf(undefined), 'unknown');
  ok('long messages are truncated', _whyOf(new Error('x'.repeat(200))).length <= 70, 'not truncated');
  ok('per-source attempts are recorded', SRC.includes('_lastFetchAttempts'), 'attempt tracking missing');
  // Network-block branch, bad-symbol branch, AND the stale-cache banner. The
  // stale one matters most: users with a cache are the majority, and they used
  // to get no diagnostic at all.
  ok('breakdown shown on all three failure paths', (SRC.match(/\$\{_breakdownHTML\}/g) || []).length === 3,
     'found ' + (SRC.match(/\$\{_breakdownHTML\}/g) || []).length);
  ok('breakdown is computed before the cache fallback',
     SRC.indexOf('const _breakdownHTML') < SRC.indexOf('_cacheGetStale(cacheKey)'), 'computed too late');
  ok('breakdown defined exactly once', (SRC.match(/const _breakdownHTML =/g) || []).length === 1, 'duplicated');
  // Every early return inside fetchSymbolData must re-enable the Fetch button;
  // the stale-cache return did not, leaving it stuck on "Fetching..." forever.
  {
    const RESET = "btn.disabled = false; btn.textContent = '\uD83D\uDCE1 Fetch';";
    const a = SRC.indexOf('async function fetchSymbolData');
    // The function ends at its final button reset; bound the scan there so
    // returns in unrelated functions are not counted.
    const last = SRC.lastIndexOf(RESET, SRC.indexOf('async function runNetworkDiagnostic'));
    ok('fetchSymbolData body located', a >= 0 && last > a, `a=${a} last=${last}`);
    const lines = SRC.slice(a, last).split(/\r?\n/);
    const leaks = lines.reduce((acc, l, i) => {
      if (!/^\s*return;\s*$/.test(l)) return acc;
      const ctx = lines.slice(Math.max(0, i - 6), i).join('\n');
      return ctx.includes('btn.disabled = false') ? acc : acc + 1;
    }, 0);
    eq('no early return leaves the Fetch button stuck', leaks, 0);
  }
  // The attempts array MUST be declared outside the try. It previously sat
  // inside and was published to window on the line after the await - which
  // never runs when Promise.any rejects, i.e. exactly when every source failed
  // and the breakdown is the only thing the user has. It rendered empty every
  // time. Structural guard plus a behavioural proof of the control flow.
  {
    const a = SRC.indexOf('const _attempts = []');
    const tryIdx = SRC.indexOf('try {', SRC.indexOf('3. Race all strategies'));
    ok('attempts array is declared before the try', a >= 0 && a < tryIdx, `decl=${a} try=${tryIdx}`);
    ok('catch reads the in-scope array', SRC.includes('const _att = _attempts.filter'), 'catch uses the global instead');
  }
  {
    // Behavioural: publishing after the await loses everything on total failure.
    const fails = n => Array.from({ length: n }, (_, i) => () => Promise.reject(new Error('HTTP ' + (429 + i))));
    const afterAwait = async strats => {           // the old, broken shape
      let published = null;
      try {
        const at = [];
        await Promise.any(strats.map(s => s().then(r => { at.push({ ok:true }); return r; },
                                                   e => { at.push({ ok:false }); throw e; })));
        published = at;
      } catch (e) { return (published || []).filter(x => !x.ok); }
      return [];
    };
    const hoisted = async strats => {               // the shipped shape
      const at = [];
      try {
        await Promise.any(strats.map(s => s().then(r => { at.push({ ok:true }); return r; },
                                                   e => { at.push({ ok:false }); throw e; })));
      } catch (e) { return at.filter(x => !x.ok); }
      return [];
    };
    pending.push((async () => {
      eq('old shape loses every failure', (await afterAwait(fails(4))).length, 0);
      eq('hoisted shape captures all failures', (await hoisted(fails(4))).length, 4);
      eq('hoisted shape reports none on success',
         (await hoisted([() => Promise.reject(new Error('x')), () => Promise.resolve('ok')])).length, 0);
    })());
  }
  ok('main fetch escapes the symbol', SRC.includes('chart/${encodeURIComponent(yahooSym)}'), 'symbol not escaped');
}

// ── Live-fetch resilience (from a real user's diagnostics) ────────────────
group('fetch resilience — causes seen in production logs');
{
  // Alpha Vantage lists Indian equities under .BSE only. Sending ".NSE"
  // returned an empty series for every NSE stock, silently killing the one
  // path that needs no proxy - even for users who had paid attention and
  // added a key.
  ok('Alpha Vantage uses the BSE listing for India',
     SRC.includes("const avSuffix  = isUS ? '' : '.BSE';"), 'still requesting .NSE');
  ok('no .NSE suffix is sent to Alpha Vantage', !SRC.includes("'.BSE' : '.NSE'"), '.NSE suffix still present');
  ok('cross-listed fallback is flagged to the user', SRC.includes('avIsCrossListed'), 'no flag');
  ok('empty AV series explains the exchange', SRC.includes('no NSE feed'), 'generic message only');

  // Proxies were timing out at 7s on real traffic.
  const budget = url => /^https:\/\/(api\.allorigins|corsproxy|api\.codetabs|thingproxy|cors\.eu\.org)/.test(url) ? 15000 : 8000;
  eq('allorigins gets the longer budget', budget('https://api.allorigins.win/raw?url=x'), 15000);
  eq('codetabs gets the longer budget', budget('https://api.codetabs.com/v1/proxy?quest=x'), 15000);
  eq('corsproxy gets the longer budget', budget('https://corsproxy.io/?url=x'), 15000);
  eq('thingproxy gets the longer budget', budget('https://thingproxy.freeboard.io/fetch/x'), 15000);
  eq('cors.eu.org gets the longer budget', budget('https://cors.eu.org/x'), 15000);
  // The app's regex must match this mirror, or the budgets silently diverge.
  ok('app budgets thingproxy and cors.eu.org as slow relays',
     /thingproxy\|cors\\\.eu\\\.org/.test(SRC), 'new relays not in the budget regex');
  eq('direct Alpha Vantage stays short', budget('https://www.alphavantage.co/query?f=x'), 8000);
  eq('direct TwelveData stays short', budget('https://api.twelvedata.com/time_series?x'), 8000);
  ok('the app actually applies a per-host budget', SRC.includes('strat._budgetMs ='), 'no budget logic');
  ok('7s blanket timeout is gone', !SRC.includes('ctrl.abort(), 7000'), 'still 7s for proxies');

  // Alpha Vantage made TIME_SERIES_DAILY_ADJUSTED premium: a free key gets
  // "This is a premium endpoint" and no data. TIME_SERIES_DAILY is the free
  // equivalent and is what a BYOK user actually has access to.
  ok('requests the free daily series', SRC.includes('function=TIME_SERIES_DAILY&'), 'not using the free endpoint');
  ok('does not request the premium endpoint',
     !/function=TIME_SERIES_DAILY_ADJUSTED&/.test(SRC), 'still calling the premium endpoint');
  // The app already asks for the free endpoint, so a premium refusal means the
  // key genuinely cannot do this - name the alternative instead of hinting at a
  // reload that will not help.
  ok('premium refusal names the alternative',
     SRC.includes('free key cannot fetch daily history') && SRC.includes('TwelveData key instead'),
     'still suggesting a reload');
  ok('TwelveData is recommended even when another key is saved',
     SRC.includes('_tdKeyed') && SRC.includes('The reliable fix'), 'guidance still gated on hasKey');

  // The two relays added on spec in #27 were removed: cors.lol was
  // unreachable and r.jina.ai returns Markdown, not JSON.
  ok('no dead relays remain in the strategy list',
     !/url:`https:\/\/api\.cors\.lol/.test(SRC) && !/url:`https:\/\/r\.jina\.ai/.test(SRC), 'dead relay still active');

  // Two fresh, independent relay hosts widen the pool. thingproxy and
  // cors.eu.org take the RAW upstream URL - encoding it would break them.
  ok('thingproxy relay is wired with the raw Yahoo URL',
     SRC.includes('https://thingproxy.freeboard.io/fetch/${yfQ2}'), 'thingproxy missing or encoded');
  ok('cors.eu.org relay is wired with the raw Yahoo URL',
     SRC.includes('https://cors.eu.org/${yfQ2}'), 'cors.eu.org missing or encoded');
  ok('the fresh relays cover Stooq too',
     SRC.includes('https://thingproxy.freeboard.io/fetch/${stooqUrl}') && SRC.includes('https://cors.eu.org/${stooqUrl}'),
     'Stooq not mirrored');
  ok('the fresh relays are not double-encoded',
     !SRC.includes('thingproxy.freeboard.io/fetch/${enc(') && !SRC.includes('cors.eu.org/${enc('), 'relay URL is encoded');

  // Truncating at 300 chars cut the breakdown off mid-sentence.
  ok('diagnostics keep the full breakdown', SRC.includes('slice(0,900)'), 'still truncating at 300');

  // The parser must read both AV response shapes.
  {
    const a = SRC.indexOf("      rows = Object.entries(ts)");
    const endMark = "        }).filter(r => +r['Close Price'] > 0).slice(-1300);";
    const b = SRC.indexOf(endMark, a) + endMark.length;
    const parse = new Function('ts', 'let rows;\n' + SRC.slice(a, b).replace(/\r/g, '') + '\nreturn rows;');
    const free = { '2026-08-27': {'1. open':'100','2. high':'110','3. low':'95','4. close':'105','5. volume':'12345'} };
    const adj  = { '2026-08-27': {'1. open':'100','2. high':'110','3. low':'95','4. close':'105','5. adjusted close':'105','6. volume':'12345'} };
    eq('free endpoint close parses', parse(free)[0]['Close Price'], '105.00');
    eq('free endpoint volume parses (5. volume)', parse(free)[0]['Total Traded Quantity'], '12345');
    eq('adjusted endpoint still parses', parse(adj)[0]['Close Price'], '105.00');
    eq('adjusted volume still parses (6. volume)', parse(adj)[0]['Total Traded Quantity'], '12345');
    eq('missing volume degrades to 0',
       parse({'2026-08-27':{'1. open':'1','2. high':'1','3. low':'1','4. close':'1'}})[0]['Total Traded Quantity'], '0');
  }
}

// ── TwelveData setup step ──────────────────────────────────────────────────
group('twelvedata setup step');
{
  let JSDOM = null;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {}
  if (!JSDOM) {
    results.push(['SKIP', 'TwelveData setup DOM tests (install jsdom to enable)', '']);
  } else {
    const src = slice('const _TD_DISMISS_KEY', '// OHLCV CACHE', 'tdsetup');
    const dom = new JSDOM('<div id="tdSetupHost"></div><input id="tdApiKey">');
    const doc = dom.window.document;
    let LS = {};
    const storage = {
      getItem: k => (k in LS ? LS[k] : null),
      setItem: (k, v) => { LS[k] = String(v); },
      removeItem: k => { delete LS[k]; },
    };
    let FETCH = () => { throw new Error('no fetch stub'); };
    const api = load(
      `function _loadKey(id){return (document.getElementById(id)?.value || localStorage.getItem(id) || '').trim();}\n`
      + src.replace(/^const /gm, 'var '),
      ['_renderTdSetup','dismissTdSetup','openTdSetup','closeTdSetup','_tdVerifyKey','_tdSetupState','_TD_SIGNUP_URL'],
      { document: doc, localStorage: storage, window: dom.window,
        AbortController: dom.window.AbortController, setTimeout, clearTimeout,
        fetch: (...a) => FETCH(...a), Date, encodeURIComponent, Promise });
    const { _renderTdSetup, dismissTdSetup, openTdSetup, closeTdSetup, _tdVerifyKey, _tdSetupState, _TD_SIGNUP_URL } = api;
    const host = doc.getElementById('tdSetupHost');

    // ── state machine ──
    eq('no key, not dismissed -> prompt', _tdSetupState(), 'prompt');
    _renderTdSetup();
    ok('prompt card offers the guided setup', /openTdSetup\(\)/.test(host.innerHTML), host.innerHTML.slice(0, 80));
    ok('prompt card explains why (proxies fail)', /prox/i.test(host.textContent), host.textContent.slice(0, 90));

    dismissTdSetup();
    eq('skipping is remembered', _tdSetupState(), 'dismissed');
    eq('dismissed card renders nothing', host.innerHTML, '');

    LS['tdApiKey'] = 'abc123';
    eq('a saved key outranks the dismissal', _tdSetupState(), 'keyed');
    _renderTdSetup();
    ok('keyed card confirms the direct connection', /no public proxy/i.test(host.textContent), host.textContent);

    // ── the modal ──
    delete LS['tdApiKey'];
    openTdSetup();
    const modal = doc.getElementById('tdSetupModal');
    ok('modal opens', !!modal, 'no modal');
    ok('modal links the real signup page', modal.innerHTML.includes(_TD_SIGNUP_URL), 'signup link missing');
    ok('paste field saves to tdApiKey', /_saveKey\('tdApiKey'/.test(modal.innerHTML), 'field not wired');
    openTdSetup();
    eq('re-opening does not stack modals', doc.querySelectorAll('#tdSetupModal').length, 1);
    closeTdSetup();
    ok('closing removes the modal', !doc.getElementById('tdSetupModal'), 'modal still present');

    // ── key verification is honest about what came back ──
    const reply = map => (url) => Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve(url.includes('exchange=NSE') ? map.nse : map.us) });
    const runVerify = async (map, key) => {
      LS = key === undefined ? {} : { tdApiKey: key };
      FETCH = reply(map);
      openTdSetup();
      doc.getElementById('tdSetupInput').value = key || '';
      await _tdVerifyKey();
      const txt = doc.getElementById('tdVerifyOut').textContent;
      closeTdSetup();
      return txt;
    };
    const ERR = { status: 'error', code: 403, message: 'plan does not include NSE' };
    pending.push((async () => {
      let txt = await runVerify({ us: { close: '229.1' }, nse: { close: '1402.5' } }, 'k1');
      ok('both markets working is reported as such', /both US and NSE/i.test(txt), txt);

      txt = await runVerify({ us: { close: '229.1' }, nse: ERR }, 'k1');
      ok('a valid key with no NSE is not called a success', !/works for both/i.test(txt), txt);
      ok('NSE refusal is named plainly', /NSE was refused/i.test(txt), txt);
      ok('and it says India still falls back to proxies', /fall back to the public proxies/i.test(txt), txt);

      txt = await runVerify({ us: ERR, nse: ERR }, 'k1');
      ok('a dead key is reported as failing', /did not work/i.test(txt), txt);
      ok('the error text from TwelveData is shown', /plan does not include NSE/.test(txt), txt);

      txt = await runVerify({ us: { close: '1' }, nse: { close: '1' } }, undefined);
      ok('an empty key asks for a key instead of probing', /Paste a key first/i.test(txt), txt);

      // A network failure must not be misread as a working key.
      LS = { tdApiKey: 'k1' };
      FETCH = () => Promise.reject(new Error('Failed to fetch'));
      openTdSetup();
      await _tdVerifyKey();
      const off = doc.getElementById('tdVerifyOut').textContent;
      closeTdSetup();
      ok('an unreachable host is not a pass', /did not work/i.test(off), off);
      ok('and names the host it could not reach', /api\.twelvedata\.com/.test(off), off);
    })());
  }
}

// The failure paths must route to the guided setup, not the bare key panel.
group('fetch failure routes to the setup step');
{
  ok('the "no data" hint opens the walkthrough',
     SRC.includes('Walk me through it (2 min)') && SRC.includes('openTdSetup&&openTdSetup()'),
     'still pointing at the raw key panel');
  ok('the network-block hint opens the walkthrough too',
     (SRC.match(/openTdSetup&&openTdSetup\(\)/g) || []).length >= 2, 'only one entry point');
  ok('the setup card is mounted in the fetch panel', SRC.includes('id="tdSetupHost"'), 'no mount point');
  ok('saving a key re-renders the setup card', /_updateByokStatus\(\);\n  try \{ _renderTdSetup\(\)/.test(SRC),
     'card can go stale after a key is saved');
}

// ── Self-hosted Cloudflare Worker proxy ────────────────────────────────────
group('self-hosted proxy (Cloudflare Worker)');
{
  // The Worker's host allowlist is the security boundary - it must reject
  // anything that isn't one of the two data hosts, over https only.
  const fs = require('fs'); const path = require('path');
  const wsrc = fs.readFileSync(path.join(__dirname, '..', 'proxy', 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = wsrc.indexOf('const ALLOWED_HOSTS');
  const b = wsrc.indexOf('const CORS_HEADERS');
  ok('worker.js exposes the allowlist + isAllowedTarget', a >= 0 && b > a, 'markers missing');
  const isAllowed = load(wsrc.slice(a, b).replace(/^export /gm, ''), ['isAllowedTarget'], { URL }).isAllowedTarget;
  ok('allows Yahoo query1', isAllowed('https://query1.finance.yahoo.com/v8/finance/chart/AAPL'), 'q1 blocked');
  ok('allows Yahoo query2', isAllowed('https://query2.finance.yahoo.com/v8/finance/chart/RELIANCE.NS'), 'q2 blocked');
  ok('allows Stooq', isAllowed('https://stooq.com/q/d/l/?s=reliance.in'), 'stooq blocked');
  ok('rejects an arbitrary host (not an open proxy)', !isAllowed('https://evil.example.com/steal'), 'open proxy!');
  ok('rejects http (no plaintext, no SSRF to internal http)', !isAllowed('http://query1.finance.yahoo.com/x'), 'http allowed');
  ok('rejects a subdomain spoof', !isAllowed('https://query1.finance.yahoo.com.evil.com/x'), 'spoof allowed');
  ok('rejects garbage', !isAllowed('not a url') && !isAllowed('') && !isAllowed('file:///etc/passwd'), 'garbage allowed');

  // App wiring: the Worker is opt-in, tried first, and appends ?url=.
  ok('app defines the built-in Worker constant', SRC.includes('const SELF_PROXY_BUILTIN'), 'constant missing');
  ok('the owner Worker URL is hardcoded so all users get it',
     /const SELF_PROXY_BUILTIN = 'https:\/\/miyeestockbuddy\.audit-vipin\.workers\.dev';/.test(SRC),
     'SELF_PROXY_BUILTIN is not set to the deployed Worker');
  ok('the hardcoded Worker URL has no trailing slash',
     !/const SELF_PROXY_BUILTIN = '[^']*\/';/.test(SRC), 'trailing slash would double up with /?url=');
  ok('a per-browser override reads localStorage', SRC.includes("localStorage.getItem('self_proxy_url')"), 'no override');
  ok('trailing slash is stripped before appending ?url=', SRC.includes("replace(/\\/+$/, '')"), 'slash not stripped');
  ok('the proxy is raced FIRST, ahead of the public relays',
     SRC.indexOf("Yahoo Finance (your proxy)") < SRC.indexOf("https://api.allorigins.win/get"),
     'proxy is not first');
  ok('the proxy strategy encodes the upstream URL', SRC.includes('`${_sp}/?url=${enc(yfQ2)}`'), 'not encoded / wrong shape');
  ok('the proxy covers Stooq too', SRC.includes('`${_sp}/?url=${enc(stooqUrl)}`'), 'Stooq not proxied');

  // _selfProxyUrl resolution: builtin default, localStorage override wins,
  // trailing slash stripped.
  const spSrc = slice('function _selfProxyUrl()', '\nasync function fetchSymbolData()', 'selfproxy');
  const mk = (builtin, ls) => {
    const store = { self_proxy_url: ls };
    return load(`var SELF_PROXY_BUILTIN=${JSON.stringify(builtin)};\n` + spSrc,
      ['_selfProxyUrl'],
      { localStorage: { getItem: k => (k in store ? store[k] : null) } })._selfProxyUrl();
  };
  eq('empty builtin, no override -> empty', mk('', undefined), '');
  eq('builtin used when no override', mk('https://a.workers.dev', undefined), 'https://a.workers.dev');
  eq('localStorage override beats builtin', mk('https://a.workers.dev', 'https://b.workers.dev'), 'https://b.workers.dev');
  eq('trailing slash stripped', mk('https://a.workers.dev/', undefined), 'https://a.workers.dev');
}

// ── Portfolio price refresh (Worker-first, parallel) ───────────────────────
group('portfolio price refresh');
{
  const src = slice('async function _fetchLivePrice(ticker, type)', '\n\n/* ══════════ MODAL', 'flp');
  const load2 = (fetchImpl, sp) => load(
    `var _selfProxyUrl = () => ${JSON.stringify(sp)};\n` + src,
    ['_fetchLivePrice'],
    { fetch: fetchImpl, AbortController: function(){ this.abort=()=>{}; this.signal={}; },
      setTimeout: () => 0, clearTimeout: () => {}, Promise, Number, parseFloat })._fetchLivePrice;
  const quote = px => ({ ok:true, json: async () => ({ chart:{ result:[{ meta:{ regularMarketPrice: px } }] } }) });
  const dead  = async () => { throw new Error('Failed to fetch'); };

  // Synchronous structural checks.
  ok('refresh uses a 1-day range, not full history',
     SRC.includes('interval=1d&range=1d'), 'still pulling long history for a price');
  const ra = slice('async function refreshAllPrices()', 'async function refreshSinglePrice', 'refresh');
  ok('refresh runs holdings in parallel batches', /Promise\.all\(batch\.map/.test(ra), 'still sequential');
  ok('the old one-at-a-time loop is gone', !/for \(const task of tasks\)/.test(ra), 'sequential loop remains');
  ok('a concurrency cap is applied', /_CONC\s*=\s*\d+/.test(ra), 'no batch size');

  // Async behaviour (registered on the pending queue; the report awaits it).
  pending.push((async () => {
    // 1) Worker present and healthy -> used, and no relay is touched.
    const hits = [];
    const f1 = async (u) => { hits.push(u); return quote(1234.5); };
    eq('returns the Worker price', await load2(f1, 'https://w.workers.dev')('RELIANCE.NS','India EQ'), 1234.5);
    eq('only the Worker was called (no wasted relay hits)', hits.length, 1);
    ok('the one call went to the Worker', /w\.workers\.dev\/\?url=/.test(hits[0] || ''), hits[0]);
    // 2) Worker fails -> falls back to a relay and still returns a price.
    const f2 = async (u) => u.includes('workers.dev') ? dead() : quote(88.25);
    eq('falls back to a relay when the Worker is down', await load2(f2, 'https://w.workers.dev')('AAPL','US EQ'), 88.25);
    // 3) No Worker configured -> straight to relays.
    eq('works with no Worker set', await load2(async () => quote(50), '')('BTC-INR','Crypto'), 50);
    // 4) Everything dead -> null (caller skips the row, no crash).
    eq('all sources dead yields null', await load2(dead, 'https://w.workers.dev')('X.NS','India EQ'), null);
  })());
}

// ── Auto-fetch fundamentals (Worker crumb route + mapping) ─────────────────
group('auto fundamentals');
{
  // The Worker gained a fundamentals route that does Yahoo's cookie+crumb
  // handshake, and a validation regex guarding the symbols param.
  const fs = require('fs'); const path = require('path');
  const w = fs.readFileSync(path.join(__dirname, '..', 'proxy', 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
  ok('worker has a fundamentals route', /params\.get\('fundamentals'\)/.test(w), 'route missing');
  ok('worker does the crumb handshake', /getcrumb/.test(w) && /_yahooAuth/.test(w), 'no crumb handshake');
  ok('fundamentals route validates symbols', /\[A-Za-z0-9\.\\-\^,\]\{1,400\}/.test(w), 'no symbol guard');
  ok('the crumb route only talks to Yahoo',
     /query1\.finance\.yahoo\.com\/v7\/finance\/quote/.test(w) && /fc\.yahoo\.com/.test(w), 'unexpected host');

  // _mapQuoteToFund: percent + crore conversions, US market cap via USD-INR.
  const src = slice('function _mapQuoteToFund(q, isUS, usdInr)', '\n// Pull Yahoo fundamentals', 'mapfund');
  const { _mapQuoteToFund } = load(src, ['_mapQuoteToFund'], { isFinite, Math });

  const ind = _mapQuoteToFund({ trailingPE: 24.531, priceToBook: 3.2, trailingAnnualDividendYield: 0.0123, marketCap: 1.85e13 }, false, 88);
  eq('India P/E rounded', ind.pe, 24.53);
  eq('India P/B rounded', ind.pb, 3.2);
  eq('dividend yield -> percent', ind.dy, 1.23);
  eq('India market cap -> Rs crore', ind.mcap, Math.round(1.85e13/1e7));  // 1,850,000 Cr

  const us = _mapQuoteToFund({ trailingPE: 30, priceToBook: 12, marketCap: 3.0e12 }, true, 88);
  eq('US market cap converted via USD-INR to crore', us.mcap, Math.round(3.0e12*88/1e7));
  eq('no dividend field -> dy omitted', us.dy, undefined);

  // Guards: junk values never populate a field.
  const junk = _mapQuoteToFund({ trailingPE: 0, priceToBook: -1, marketCap: 0 }, false, 88);
  eq('zero P/E ignored', junk.pe, undefined);
  eq('negative P/B ignored', junk.pb, undefined);
  eq('zero market cap ignored', junk.mcap, undefined);

  // _fetchFundamentalsBulk parses the v7 quoteResponse into a symbol map, and
  // no-ops with no Worker configured.
  const bsrc = slice('async function _fetchFundamentalsBulk(yahooSyms)', '\n\n/* ══════════ MODAL', 'bulkfund');
  const mkBulk = (sp, fetchImpl) => load(
    `var _selfProxyUrl = () => ${JSON.stringify(sp)};\n` + bsrc,
    ['_fetchFundamentalsBulk'],
    { fetch: fetchImpl, AbortController: function(){ this.abort=()=>{}; this.signal={}; },
      setTimeout: () => 0, clearTimeout: () => {}, encodeURIComponent, Promise })._fetchFundamentalsBulk;

  ok('the app calls the /?fundamentals= route',
     SRC.includes('/?fundamentals=${encodeURIComponent(chunk.join'), 'wrong endpoint shape');
  ok('refresh fills fundamentals only when a value is present',
     SRC.includes('if (f.pe   != null)') && SRC.includes('h.mcap = f.mcap'), 'unconditional overwrite');

  pending.push((async () => {
    const resp = { ok:true, json: async () => ({ quoteResponse: { result: [
      { symbol:'RELIANCE.NS', trailingPE: 22 }, { symbol:'AAPL', trailingPE: 30 } ] } }) };
    const map = await mkBulk('https://w.workers.dev', async () => resp)(['RELIANCE.NS','AAPL']);
    ok('bulk maps symbols to quotes', map['RELIANCE.NS'] && map['AAPL'], JSON.stringify(map));
    eq('quote payload preserved', map['AAPL'].trailingPE, 30);
    const none = await mkBulk('', async () => resp)(['X.NS']);
    eq('no Worker -> empty map', Object.keys(none).length, 0);
  })());
}

// ── Durable portfolio mirror (IndexedDB) ───────────────────────────────────
group('durable portfolio mirror');
{
  // _pbkParse is the pure core: does a mirror record carry restorable holdings?
  const src = slice('function _pbkParse(rec){', 'async function _pbkRecover', 'pbk');
  const { _pbkParse } = load(src, ['_pbkParse'], { JSON });

  const rec = { payload: JSON.stringify({ indEQ:[1,2,3], usEQ:[1], crypto:[], fd:[], mf:[1], txns:[9] }) };
  const p = _pbkParse(rec);
  ok('parses a real mirror record', !!p, 'null');
  eq('counts holdings across classes (txns excluded)', p && p.n, 5);

  eq('null record -> null', _pbkParse(null), null);
  eq('no payload -> null', _pbkParse({ ts: 1 }), null);
  eq('corrupt JSON -> null', _pbkParse({ payload: '{not json' }), null);
  eq('empty portfolio -> null (nothing to restore)',
     _pbkParse({ payload: JSON.stringify({ indEQ:[], usEQ:[], crypto:[], fd:[], mf:[] }) }), null);

  // Structure: the mirror is written on save, recovered on boot, and guarded.
  ok('IndexedDB declares a portfolio store', /createObjectStore\('portfolio'/.test(SRC), 'no portfolio store');
  ok('DB version bumped so the store is created', /indexedDB\.open\('StockCacheDB', 3\)/.test(SRC), 'version not bumped');
  ok('saveLocal mirrors the payload to IDB', /_pbkSave\(payload\)/.test(SRC), 'no mirror on save');
  ok('the mirror is written even if localStorage fails',
     SRC.indexOf('_pbkSave(payload)') < SRC.indexOf('for(let attempt=0'), 'mirror runs after the quota loop');
  ok('boot attempts recovery', /loadLocal\(\);\s*\n\s*try \{ _pbkRecover\(\)/.test(SRC), 'no boot recovery');
  ok('recovery never clobbers existing local data',
     /_pbkRecover[\s\S]*?if\(_holdingsCount\(\)>0\) return false;/.test(SRC), 'no guard against clobber');
}

// ── Portfolio income & true return ─────────────────────────────────────────
group('portfolio income & XIRR');
{
  const src = slice('function _pmCashflows(lots, asOf)', 'function _pmLots()', 'pm');
  const xsrc = slice('function xirr(cfs){', '\nfunction cMF(', 'xirr');
  const { _pmCashflows, _pmXirr, _pmIncome } =
    load(xsrc + '\n' + src, ['_pmCashflows','_pmXirr','_pmIncome'], { Math, Date, isFinite, Array, Number });

  const asOf = new Date('2026-01-01T00:00:00Z');
  const L = (invested,current,buyDate,dividend) => ({ invested, current, buyDate, dividend });

  // ── cashflow construction ──
  {
    const cf = _pmCashflows([L(100000,150000,'2024-01-01',0)], asOf);
    eq('one lot -> two cashflows', cf.length, 2);
    eq('purchase is an outflow', cf[0].amount, -100000);
    eq('terminal is current value', cf[1].amount, 150000);
    ok('terminal is dated asOf', cf[1].date.getTime() === asOf.getTime(), 'wrong terminal date');
  }
  {
    const cf = _pmCashflows([L(100000,150000,'2024-01-01',5000)], asOf);
    eq('dividends are added to the terminal inflow', cf[1].amount, 155000);
  }
  // Undated / future-dated / junk lots cannot be timed and must be dropped,
  // never silently priced as if bought today.
  eq('undated lot is excluded', _pmCashflows([L(1000,2000,null,0)], asOf).length, 0);
  eq('future-dated lot is excluded', _pmCashflows([L(1000,2000,'2030-01-01',0)], asOf).length, 0);
  eq('unparseable date is excluded', _pmCashflows([L(1000,2000,'not-a-date',0)], asOf).length, 0);
  eq('zero-cost lot is excluded', _pmCashflows([L(0,2000,'2024-01-01',0)], asOf).length, 0);
  {
    const cf = _pmCashflows([L(1000,2000,'2024-01-01',0), L(500,700,null,0)], asOf);
    eq('a bad lot does not poison the good ones', cf.length, 2);
    eq('terminal counts only the dated lot', cf[1].amount, 2000);
  }

  // ── XIRR values ──
  {
    // Exactly doubling over 2 years -> ~41.42% annualised.
    const r = _pmXirr([L(100000,200000,'2024-01-01',0)], asOf);
    ok('doubling over 2y is ~41.4%/yr', r > 41 && r < 42, String(r));
  }
  {
    const flat = _pmXirr([L(100000,100000,'2024-01-01',0)], asOf);
    ok('no gain -> ~0%', Math.abs(flat) < 0.01, String(flat));
  }
  {
    const loss = _pmXirr([L(100000,50000,'2024-01-01',0)], asOf);
    ok('a loss is negative', loss < 0, String(loss));
  }
  {
    // XIRR must be time-aware: same money, same profit, shorter hold = higher.
    const slow = _pmXirr([L(100000,150000,'2021-01-01',0)], asOf);
    const fast = _pmXirr([L(100000,150000,'2025-01-01',0)], asOf);
    ok('a recent gain annualises higher than an old one', fast > slow, `${fast} !> ${slow}`);
  }
  {
    // Dividends must raise the return, not be ignored.
    const noDiv = _pmXirr([L(100000,150000,'2024-01-01',0)], asOf);
    const wDiv  = _pmXirr([L(100000,150000,'2024-01-01',20000)], asOf);
    ok('dividends increase XIRR', wDiv > noDiv, `${wDiv} !> ${noDiv}`);
  }
  eq('no usable lots -> null', _pmXirr([L(1000,2000,null,0)], asOf), null);
  eq('empty book -> null', _pmXirr([], asOf), null);

  // ── income & yield on cost ──
  {
    const inc = _pmIncome([L(100000,0,'2024-01-01',3000), L(200000,0,'2024-01-01',0), L(50000,0,'2024-01-01',1000)]);
    eq('income sums dividends', inc.total, 4000);
    eq('counts only paying holdings', inc.paying, 2);
    eq('yield on cost uses total invested', +inc.yieldOnCost.toFixed(4), +(4000/350000*100).toFixed(4));
  }
  eq('no dividends -> null yield', _pmIncome([L(1000,0,'2024-01-01',0)]).yieldOnCost, null);
  eq('no holdings -> null yield', _pmIncome([]).yieldOnCost, null);
  ok('junk dividends are ignored',
     _pmIncome([L(1000,0,'2024-01-01',NaN), L(1000,0,'2024-01-01',-5)]).total === 0, 'junk counted');

  // ── wiring ──
  ok('income card renders on the analysis tab', /renderXRay\(\);renderIncome\(\)/.test(SRC), 'not wired to the tab');
  ok('dividend is persisted on save', /div:gn\('m-div'\)\|\|null/.test(SRC), 'div not saved');
  ok('dividend is importable from CSV', /div:getN\('dividend','div','dividendreceived'\)/.test(SRC), 'not importable');
  ok('US dividends are converted to INR', /dividend:\(\+h\.div\|\|0\)\*\(S\.usdInr\|\|1\)/.test(SRC), 'US div not converted');
}

// ── Launch chooser ─────────────────────────────────────────────────────────
group('launch chooser');
{
  ok('launcher section exists', SRC.includes('id="section-launcher"'), 'no launcher');
  ok('offers both apps', /switchApp\('analyser'\)[\s\S]{0,900}switchApp\('portfolio'\)/.test(SRC), 'both options missing');
  ok('boot shows the chooser by default', /showLauncher\(\);\s*\n\s*\} catch/.test(SRC), 'not shown on boot');
  ok('boot honours an explicit skip', /skip === 'portfolio' \|\| skip === 'analyser'/.test(SRC), 'no skip path');
  ok('choosing an app hides the launcher',
     /function switchApp\(app\) \{[\s\S]{0,200}L\.style\.display = 'none'/.test(SRC), 'launcher not hidden');
  ok('the skip preference is only written on an actual choice',
     /if \(cb\.checked\) localStorage\.setItem\('launchSkip', app\); else localStorage\.removeItem\('launchSkip'\)/.test(SRC),
     'skip preference not toggled both ways');
}

// ── Disclaimer overlay fits the viewport ───────────────────────────────────
group('disclaimer overlay layout');
{
  // align-items:center on a scrollable flex container clips the TOP of an
  // over-tall child, and overflow-y cannot scroll back up to reach it. The fix
  // is flex-start plus margin:auto on the card.
  const ov = /#disclaimer-overlay\{[^}]*\}/.exec(SRC);
  ok('overlay rule found', !!ov, 'rule missing');
  ok('overlay does not centre with align-items', !/#disclaimer-overlay\{[^}]*align-items:center/.test(SRC),
     'align-items:center still clips the top');
  ok('overlay aligns to flex-start', /#disclaimer-overlay\{[^}]*align-items:flex-start/.test(SRC), 'not flex-start');
  ok('overlay can still scroll', /#disclaimer-overlay\{[^}]*overflow-y:auto/.test(SRC), 'not scrollable');
  ok('card centres itself with auto margins', /\.disc-card\{[^}]*margin:auto/.test(SRC), 'no margin:auto');
  ok('short viewports get a compact card', /@media \(max-height:800px\)/.test(SRC), 'no short-viewport rule');
  ok('very short viewports drop the decorative blocks', /@media \(max-height:620px\)/.test(SRC), 'no very-short rule');
}

// ── Capital gains: FIFO lot matching ───────────────────────────────────────
group('capital gains FIFO');
{
  const src = slice('const TAX_RULES = {', '\n// Crypto / VDA', 'fifo');
  const vsrc = slice('function computeVdaTax(rows, rules){', '\n}', 'vda') + '\n}';
  const { fifoMatchSells, computeEquityTax, computeVdaTax, TAX_RULES } =
    load(src + '\n' + vsrc, ['fifoMatchSells','computeEquityTax','computeVdaTax','TAX_RULES'],
         { Date, Math, isFinite, Array, Object, Number });

  const B = (name,date,qty,price) => ({ id:'b'+date, type:'BUY', cls:'India EQ', name, date, qty, price });
  const S_ = (name,date,qty,price) => ({ id:'s'+date, type:'SELL', cls:'India EQ', name, date, qty, price });

  // ── Nothing is ever invented ──
  {
    const r = fifoMatchSells([S_('ORPHAN','2025-06-01',10,500)]);
    eq('a sale with no buy produces no gain row', r.matched.length, 0);
    eq('it is reported as unmatched instead', r.unmatched.length, 1);
    eq('unmatched carries the full quantity', r.unmatched[0].qty, 10);
    ok('and says why', /no BUY transaction/.test(r.unmatched[0].reason), r.unmatched[0].reason);
  }
  {
    // Partial cover: 10 bought, 15 sold -> 10 matched, 5 flagged.
    const r = fifoMatchSells([B('X','2024-01-01',10,100), S_('X','2025-06-01',15,200)]);
    eq('matched only what the lots cover', r.matched[0].qty, 10);
    eq('the uncovered remainder is flagged', r.unmatched.length, 1);
    eq('remainder quantity is exact', r.unmatched[0].qty, 5);
  }

  // ── Real FIFO: oldest lot first, each slice keeps its own basis and period ──
  {
    const r = fifoMatchSells([
      B('X','2020-01-01',10,100),   // old, cheap  -> LTCG
      B('X','2025-05-01',10,300),   // recent      -> STCG
      S_('X','2025-06-01',15,400),
    ]);
    eq('a sale splits across lots', r.matched.length, 2);
    eq('oldest lot is consumed first', r.matched[0].buyPrice, 100);
    eq('first slice takes the whole old lot', r.matched[0].qty, 10);
    eq('second slice comes from the newer lot', r.matched[1].buyPrice, 300);
    eq('second slice takes the remainder', r.matched[1].qty, 5);
    ok('old slice is long term', r.matched[0].isLTCG === true, 'not LTCG');
    ok('new slice is short term', r.matched[1].isLTCG === false, 'not STCG');
    eq('per-slice gain uses that slice basis', r.matched[0].gain, (400-100)*10);
    eq('and the newer basis for the rest', r.matched[1].gain, (400-300)*5);
    eq('nothing left unmatched', r.unmatched.length, 0);
  }
  {
    // The old code used the OLDEST buy date for everything, which forced LTCG.
    // A purely recent position must come out entirely short term.
    const r = fifoMatchSells([B('Y','2025-05-01',5,100), S_('Y','2025-06-01',5,150)]);
    ok('a 1-month hold is STCG, not LTCG', r.matched[0].isLTCG === false, 'misclassified as LTCG');
    eq('holding period is real, not assumed 730d', r.matched[0].holdingDays, 31);
  }
  {
    // 365 days is the boundary: >365 is long term, exactly 365 is not.
    const at365 = fifoMatchSells([B('Z','2024-01-01',1,10), S_('Z','2024-12-31',1,20)]).matched[0];
    const at366 = fifoMatchSells([B('Z','2024-01-01',1,10), S_('Z','2025-01-02',1,20)]).matched[0];
    ok('exactly 365 days is short term', at365.isLTCG === false, String(at365.holdingDays));
    ok('beyond 365 days is long term', at366.isLTCG === true, String(at366.holdingDays));
  }
  {
    // A lot bought AFTER the sale cannot fund it.
    const r = fifoMatchSells([B('F','2025-12-01',10,100), S_('F','2025-06-01',10,200)]);
    eq('a later purchase cannot fund an earlier sale', r.matched.length, 0);
    eq('so the sale is unmatched', r.unmatched.length, 1);
  }
  {
    // Lots are per-asset; another stock's buys must not be consumed.
    const r = fifoMatchSells([B('AAA','2020-01-01',10,100), S_('BBB','2025-06-01',10,200)]);
    eq('lots do not leak between assets', r.matched.length, 0);
    eq('the sale is unmatched', r.unmatched.length, 1);
  }
  {
    // A lot is not reusable across two sales.
    const r = fifoMatchSells([B('X','2020-01-01',10,100), S_('X','2025-06-01',6,200), S_('X','2025-07-01',6,200)]);
    eq('first sale takes 6', r.matched[0].qty, 6);
    eq('second sale gets only the remaining 4', r.matched[1].qty, 4);
    eq('and 2 are unmatched', r.unmatched[0].qty, 2);
  }
  eq('junk quantity is rejected, not guessed',
     fifoMatchSells([B('X','2020-01-01',10,100), S_('X','2025-06-01',0,200)]).unmatched.length, 1);

  // ── Rates: Budget 2024 ──
  eq('LTCG rate is 12.5%, not the old 10%', TAX_RULES.ltcgRate, 0.125);
  eq('STCG rate is 20%', TAX_RULES.stcgRate, 0.20);
  eq('LTCG exemption is 1.25 lakh', TAX_RULES.ltcgExempt, 125000);
  {
    const rows = [{ gain: 325000, isLTCG:true }, { gain: 50000, isLTCG:false }];
    const tx = computeEquityTax(rows);
    eq('LTCG taxable is net of the exemption', tx.ltcgTaxable, 200000);
    eq('LTCG tax at 12.5%', tx.ltcgTax, 25000);
    eq('STCG tax at 20%', tx.stcgTax, 10000);
  }
  {
    const tx = computeEquityTax([{ gain: 100000, isLTCG:true }]);
    eq('gains under the exemption are untaxed', tx.ltcgTax, 0);
  }
  {
    const tx = computeEquityTax([{ gain: -50000, isLTCG:false }]);
    eq('a short-term loss creates no tax', tx.stcgTax, 0);
  }
  // Crypto: losses cannot be set off against gains.
  {
    const v = computeVdaTax([{ gain: 100000 }, { gain: -80000 }]);
    eq('VDA counts gains only, ignoring losses', v.gain, 100000);
    eq('VDA tax at 30%', v.tax, 30000);
  }

  // ── Wiring: the fabricating code must be gone ──
  ok('no invented 70% cost basis remains', !/sell\.price\s*\*\s*0\.7/.test(SRC), 'fabricated basis still present');
  ok('no assumed 730-day holding period remains', !/holdingDays\s*=\s*730/.test(SRC), 'assumed period still present');
  ok('taxation uses the FIFO matcher', /fifoMatchSells\(S\.txns/.test(SRC), 'not wired');
  ok('unmatched sales are surfaced to the user', /could not be matched to a purchase/.test(SRC), 'no warning');
  ok('the LTCG rate label is driven by the rule, not hard-coded 10%',
     !/LTCG Tax @10%/.test(SRC) && /_ltcgRatePct/.test(SRC), 'rate label still hard-coded');
}

// ── Benchmark: portfolio vs Nifty ──────────────────────────────────────────
group('benchmark vs index');
{
  const src  = slice('function _bmCloseOnOrBefore(series, dateStr){', 'async function _bmFetchIndex', 'bm');
  const xsrc = slice('function xirr(cfs){', '\nfunction cMF(', 'xirr');
  const { _bmCloseOnOrBefore, _bmReplay } =
    load(xsrc + '\n' + src, ['_bmCloseOnOrBefore','_bmReplay'], { Date, Math, isFinite, Array, Number });

  // A sparse series with a weekend gap: 2024-01-05 (Fri) then 2024-01-08 (Mon).
  const series = [
    { d:'2024-01-01', c:100 }, { d:'2024-01-05', c:110 },
    { d:'2024-01-08', c:120 }, { d:'2026-01-01', c:200 },
  ];

  // ── nearest close on or before ──
  eq('exact date hits its own close', _bmCloseOnOrBefore(series,'2024-01-05'), 110);
  eq('a weekend falls back to the previous close', _bmCloseOnOrBefore(series,'2024-01-06'), 110);
  eq('a date after the series uses the last close', _bmCloseOnOrBefore(series,'2027-01-01'), 200);
  eq('a date before the series is unpriceable', _bmCloseOnOrBefore(series,'2020-01-01'), null);
  eq('an unparseable date is unpriceable', _bmCloseOnOrBefore(series,'nonsense'), null);
  eq('an empty series is unpriceable', _bmCloseOnOrBefore([],'2024-01-05'), null);

  const asOf = new Date('2026-01-01T00:00:00Z');
  const L = (invested,current,buyDate,dividend) => ({ invested, current, buyDate, dividend });

  // ── replay ──
  {
    // Bought at index 100, index now 200 -> the index would have doubled the money.
    const r = _bmReplay([L(100000,300000,'2024-01-01',0)], series, asOf);
    eq('index terminal value doubles the stake', r.benchValue, 200000);
    eq('portfolio terminal is the real current value', r.portValue, 300000);
    ok('beating the index shows a positive difference', r.valueDiff === 100000, String(r.valueDiff));
    ok('your XIRR exceeds the index XIRR here', r.portXirr > r.benchXirr, `${r.portXirr} !> ${r.benchXirr}`);
  }
  {
    // Underperforming must read as behind, not be hidden.
    const r = _bmReplay([L(100000,150000,'2024-01-01',0)], series, asOf);
    ok('lagging the index is a negative difference', r.valueDiff < 0, String(r.valueDiff));
    ok('and a negative XIRR gap', r.xirrDiff < 0, String(r.xirrDiff));
  }
  {
    // Dividends count on your side - they are part of your return.
    const noDiv = _bmReplay([L(100000,150000,'2024-01-01',0)], series, asOf);
    const wDiv  = _bmReplay([L(100000,150000,'2024-01-01',25000)], series, asOf);
    ok('dividends improve your side of the comparison', wDiv.valueDiff > noDiv.valueDiff,
       `${wDiv.valueDiff} !> ${noDiv.valueDiff}`);
  }
  {
    // Matching performance should land near zero, both sides equal.
    const r = _bmReplay([L(100000,200000,'2024-01-01',0)], series, asOf);
    eq('matching the index nets to zero', r.valueDiff, 0);
    ok('and the XIRR gap is ~0', Math.abs(r.xirrDiff) < 1e-6, String(r.xirrDiff));
  }
  // ── exclusions keep it like-for-like ──
  {
    const r = _bmReplay([L(100000,200000,'2024-01-01',0), L(50000,60000,null,0)], series, asOf);
    eq('an undated lot is excluded', r.used, 1);
    eq('and counted as skipped', r.skipped, 1);
    eq('it is left out of YOUR value too, not just the index', r.portValue, 200000);
  }
  {
    // A purchase predating the index series cannot be priced on either side.
    const r = _bmReplay([L(100000,200000,'2020-01-01',0)], series, asOf);
    eq('a lot older than the series is excluded', r, null);
  }
  eq('no lots at all -> null', _bmReplay([], series, asOf), null);
  eq('no series -> null', _bmReplay([L(1,2,'2024-01-01',0)], [], asOf), null);

  // ── wiring ──
  ok('benchmark card is on the analysis tab', /renderIncome\(\);renderBenchmark\(\)/.test(SRC), 'not wired');
  ok('benchmark uses Nifty 50', /BENCH_SYMBOL = '\^NSEI'/.test(SRC), 'wrong index');
  ok('index history is fetched through the owner Worker', /_bmFetchIndex[\s\S]{0,600}_selfProxyUrl/.test(SRC), 'not via Worker');
  ok('null closes (market holidays) are dropped', /if\(c == null \|\| !isFinite\(c\)\) continue;/.test(SRC), 'holidays not handled');
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
(async () => {
  await Promise.all(pending);
  const W = 52;
  for (const [kind, name, detail] of results) {
    if (kind === 'GROUP') { console.log(`\n\x1b[1m${name}\x1b[0m`); continue; }
    const tag = kind === 'PASS' ? '\x1b[32mPASS\x1b[0m' : kind === 'SKIP' ? '\x1b[33mSKIP\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`  ${tag}  ${name.padEnd(W)}${detail ? '  ' + detail : ''}`);
  }
  if (!pass && !fail) { console.error('\nNo assertions ran - the suite is broken.'); process.exit(1); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

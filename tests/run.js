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
  const { computeDVM } = load(slice('function computeDVM(ar, ratios){', 'function renderDVMBadges()', 'computeDVM'), ['computeDVM']);
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

  // ── the valuation badge must use every input the page already has ──
  // Cupid Ltd scored 0/100. Its feed carried no pegRatio, so the badge averaged
  // P/E 277.2 and P/B 83.39 - both far past the expensive end of their scales,
  // both clamped to zero - while the ratio panel a few centimetres below showed
  // a PEG of 1.61, worth 52 on the same scale. Two valuation views on one page,
  // disagreeing because they read different sources.
  {
    const base = mk(p => p * 1.0005, { rsiV: 50, stV: 1 });
    const cupidFeed = { pe: 277.2, pb: 83.39 };          // no pegRatio, as reported
    {
      const s = computeDVM(Object.assign({}, base, { fundamentals: cupidFeed }));
      eq('with the feed alone the score is the floor', s.v, 0);
      eq('and only two inputs were available', s.vUsed.join('+'), 'P/E+P/B');
      eq('which the badge reports rather than implying a full reading', s.vFloored, true);
    }
    {
      // The PEG the ratio panel computed, handed to the same score.
      const s = computeDVM(Object.assign({}, base, { fundamentals: cupidFeed }), { peg: 1.61 });
      ok('the computed PEG is picked up', s.vUsed.indexOf('PEG') >= 0, s.vUsed.join('+'));
      eq('and the score is no longer pinned at the floor', s.v, 17);
      eq('so it is not reported as floored', s.vFloored, false);
    }
    {
      // A feed value always wins over the computed one: it is the more current.
      const s = computeDVM(Object.assign({}, base, { fundamentals: { pe: 20, peg: 1.0 } }), { pe: 99, peg: 9 });
      eq('the feed P/E is preferred', s.vInputs.pe, 20);
      eq('and the feed PEG', s.vInputs.peg, 1.0);
    }
    {
      // Ratios reached through analysisResult, which is how the app supplies
      // them once the statements land.
      const s = computeDVM(Object.assign({}, base, { fundamentals: cupidFeed, ratios: { peg: 1.61 } }));
      ok('ratios on the result are used too', s.vUsed.indexOf('PEG') >= 0, s.vUsed.join('+'));
    }
    {
      // Nothing anywhere: the technical proxy, honestly labelled.
      const s = computeDVM(Object.assign({}, base, { fundamentals: null }));
      eq('with no valuation inputs it falls back to the proxy', s.vSource, 'technical');
      eq('and claims no fundamental inputs', s.vUsed.length, 0);
    }
    {
      // A zero or negative ratio is not a valuation input.
      const s = computeDVM(Object.assign({}, base, { fundamentals: { pe: 0, pb: -3 } }));
      eq('a non-positive ratio is ignored, not scored', s.vSource, 'technical');
    }
    {
      // Genuinely cheap: the scale still works at the other end.
      const s = computeDVM(Object.assign({}, base, { fundamentals: { pe: 8, peg: 0.8, pb: 1 } }));
      eq('a cheap stock scores at the top', s.v, 100);
      eq('and is not reported as floored', s.vFloored, false);
    }
  }
  // The floor and a measured zero are different claims, and the badge says so.
  ok('a floored score explains that it is the end of the scale',
     /this is the floor of the range rather than a measured zero/.test(SRC), 'floor unexplained');
  ok('and that it means expensive, not worthless',
     /means "expensive on all of these", not "worth nothing"/.test(SRC), 'reads as worthless');
  ok('a partial reading says inputs were missing',
     /The remaining inputs were not reported by the data source/.test(SRC), 'partial reading unmarked');
  ok('the badge names the inputs it actually used',
     /\(s\.vUsed\|\|\[\]\)\.join\('\+'\)/.test(SRC), 'inputs not named');
  ok('the badge is redrawn once the ratios arrive',
     /if\(typeof renderDVMBadges === 'function'\) renderDVMBadges\(\);/.test(SRC), 'stale badge kept');
  ok('and the ratios are stored where the badge can read them',
     /ar\.ratios = computeRatios\(t, ar\.fundamentals, price\);/.test(SRC), 'ratios not shared');
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
    return trending ? (drift < 0 ? 'Downtrend' : 'Uptrend') : 'Sideways Range';
  };
  ok('classifier source still present in app', SRC.includes('_travel > 0.55'), 'travel-ratio gate missing');
  eq('reported 51% crash', classify(line(1200,588,150), 1211, 538), 'Downtrend');
  eq('its recent 90-bar leg', classify(line(800,588,90), 800, 538), 'Downtrend');
  eq('true sideways', classify(osc(670,120,90), 800, 540), 'Sideways Range');
  eq('mild drift', classify(line(600,660,90), 800, 540), 'Sideways Range');
  eq('strong uptrend', classify(line(500,900,90), 910, 495), 'Uptrend');
  eq('volatile but flat', classify(osc(700,250,90), 950, 450), 'Sideways Range');
  eq('V-shaped recovery', classify([...line(900,600,45), ...line(600,890,45)], 910, 595), 'Sideways Range');
  eq('shallow decline', classify(line(700,650,90), 760, 600), 'Sideways Range');
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

// ── Portfolio growth history ───────────────────────────────────────────────
group('growth history');
{
  const src = slice('function _ghUpsert(list, day, value, invested){', 'function ghRecordToday()', 'gh');
  const { _ghUpsert, _ghStats } = load(src, ['_ghUpsert','_ghStats'], { Array, Math, isFinite, Number });

  // ── one point per day, latest reading wins ──
  {
    let l = [];
    l = _ghUpsert(l, '2026-01-01', 100000, 80000);
    eq('records a day', l.length, 1);
    l = _ghUpsert(l, '2026-01-01', 105000, 80000);
    eq('same day replaces, never duplicates', l.length, 1);
    eq('the later reading wins (end-of-day)', l[0].v, 105000);
    l = _ghUpsert(l, '2026-01-02', 110000, 80000);
    eq('a new day appends', l.length, 2);
  }
  {
    // Out-of-order writes must still yield a chronological series.
    let l = [];
    l = _ghUpsert(l, '2026-01-03', 300, 1);
    l = _ghUpsert(l, '2026-01-01', 100, 1);
    l = _ghUpsert(l, '2026-01-02', 200, 1);
    eq('series stays sorted by date', l.map(p=>p.d).join(','), '2026-01-01,2026-01-02,2026-01-03');
  }
  // A zero or junk valuation must never enter the series - it would fake a
  // catastrophic drawdown on the chart.
  {
    let l = [{ d:'2026-01-01', v:100000 }];
    eq('a zero value is refused', _ghUpsert(l,'2026-01-02',0,1).length, 1);
    eq('a negative value is refused', _ghUpsert(l,'2026-01-02',-5,1).length, 1);
    eq('NaN is refused', _ghUpsert(l,'2026-01-02',NaN,1).length, 1);
    eq('a missing day is refused', _ghUpsert(l,null,5000,1).length, 1);
  }

  // ── stats ──
  {
    const l = [
      { d:'2026-01-01', v:100 }, { d:'2026-01-02', v:150 },
      { d:'2026-01-03', v:90  }, { d:'2026-01-04', v:120 },
    ];
    const s = _ghStats(l);
    eq('counts recorded days', s.days, 4);
    eq('peak is the highest value', s.peak, 150);
    eq('peak date is right', s.peakDate, '2026-01-02');
    eq('worst drawdown is peak-to-trough', +s.maxDD.toFixed(2), 40);   // 150 -> 90
    eq('current drawdown is from peak to latest', +s.currentDD.toFixed(2), 20); // 150 -> 120
    eq('change is first to last', +s.change.toFixed(2), 20);           // 100 -> 120
  }
  {
    // A monotonically rising book has no drawdown and sits at its peak.
    const s = _ghStats([{d:'2026-01-01',v:100},{d:'2026-01-02',v:200}]);
    eq('no drawdown when only rising', s.maxDD, 0);
    eq('sitting at the peak', s.currentDD, 0);
  }
  eq('no points -> null stats', _ghStats([]), null);
  eq('all-junk points -> null stats', _ghStats([{d:'x',v:0},{d:'y',v:-1}]), null);

  // ── wiring ──
  ok('growth card is on the analysis tab', /renderBenchmark\(\);renderGrowth\(\)/.test(SRC), 'not wired');
  ok('a point is recorded on every save', /function save\(\)\{saveLocal\(\);try\{ghRecordToday\(\)/.test(SRC), 'not recorded on save');
  ok('and once on boot', /loadLocal\(\);[\s\S]{0,200}try \{ ghRecordToday\(\); \} catch\(e\)\{\}/.test(SRC), 'not recorded on boot');
  ok('history is capped so it cannot grow without bound', /_GH_MAX = 1825/.test(SRC), 'no cap');
  ok('the UI admits it cannot backfill', /can't reconstruct value from before tracking began/.test(SRC), 'overclaims history');
}

// ── Price targets & alerts ─────────────────────────────────────────────────
group('targets & alerts');
{
  const src = slice('function _alEvaluate(h){', 'function renderAlerts()', 'alerts');
  const { _alEvaluate, _alScan } = load(src, ['_alEvaluate','_alScan'], { Array, Math, isFinite, Number });

  const H = (name,ltp,target,stop) => ({ name, ticker:name, ltp, target, stop });

  // ── no level set, or no usable price -> no claim at all ──
  eq('no target and no stop -> null', _alEvaluate(H('A',100)), null);
  eq('no price -> null', _alEvaluate(H('A',0,120,80)), null);
  eq('NaN price -> null', _alEvaluate(H('A',NaN,120,80)), null);
  eq('null holding -> null', _alEvaluate(null), null);
  eq('junk levels are ignored', _alEvaluate(H('A',100,0,-5)), null);

  // ── target ──
  {
    const a = _alEvaluate(H('A',130,120,80));
    eq('price above target is a hit', a.hit, 'target');
    eq('overshoot is reported', +a.distPct.toFixed(4), +((130-120)/120*100).toFixed(4));
  }
  eq('price exactly at target counts as hit', _alEvaluate(H('A',120,120,80)).hit, 'target');
  {
    const a = _alEvaluate(H('A',100,120,80));
    eq('below target is not a hit', a.hit, null);
    eq('distance to target is reported', +a.distPct.toFixed(4), +((120-100)/100*100).toFixed(4));
  }
  // ── stop ──
  {
    const a = _alEvaluate(H('A',70,120,80));
    eq('price below stop is a breach', a.hit, 'stop');
    ok('breach depth is positive', a.distPct > 0, String(a.distPct));
  }
  eq('price exactly at stop counts as breach', _alEvaluate(H('A',80,120,80)).hit, 'stop');
  eq('target takes precedence when both would trigger',
     _alEvaluate({name:'A',ltp:130,target:120,stop:140}).hit, 'target');
  // ── a single level works on its own ──
  eq('target only, hit', _alEvaluate({name:'A',ltp:130,target:120}).hit, 'target');
  eq('stop only, breached', _alEvaluate({name:'A',ltp:70,stop:80}).hit, 'stop');
  eq('target only, not hit', _alEvaluate({name:'A',ltp:100,target:120}).hit, null);

  // ── scan ──
  {
    const r = _alScan(
      [H('Hit1',130,120,80), H('Near',118,120,80), H('Far',50,120,10)],
      [H('Breach',70,200,80)]
    );
    eq('only crossed levels are hits', r.hits.length, 2);
    ok('hits include both the target and the stop',
       r.hits.some(x=>x.hit==='target') && r.hits.some(x=>x.hit==='stop'), JSON.stringify(r.hits.map(x=>x.hit)));
    eq('uncrossed holdings are watching, not alerts', r.watching.length, 2);
    eq('the nearest uncrossed comes first', r.watching[0].name, 'Near');
    ok('asset class is tagged', r.hits.every(x=>x.cls==='India EQ'||x.cls==='US EQ'), 'missing cls');
  }
  {
    const r = _alScan([H('NoLevels',100)], []);
    eq('a holding with no levels raises nothing', r.hits.length + r.watching.length, 0);
  }
  eq('empty book is safe', _alScan([], []).hits.length, 0);
  eq('undefined lists are safe', _alScan(undefined, undefined).hits.length, 0);

  // ── wiring ──
  ok('alerts render on the dashboard', /renderDashboard\(\)\{[\s\S]{0,140}renderAlerts\(\)/.test(SRC), 'not wired');
  ok('dashboard has a host element', SRC.includes('id="alerts-host"'), 'no host');
  ok('target and stop are persisted', /target:gn\('m-target'\)\|\|null,stop:gn\('m-stop'\)\|\|null/.test(SRC), 'not saved');
  ok('the panel says these are user-set levels, not advice',
     /not advice, and not automatic orders/.test(SRC), 'overclaims');
}

// ── Plain-English labels (no unexplained jargon) ───────────────────────────
group('plain-English labels');
{
  // The verdict chip read "HOLD · CHOP", which means nothing to most users.
  ok('the CHOP verdict chip is gone', !/HOLD · CHOP/.test(SRC), 'still shows HOLD · CHOP');
  ok('it now names the condition plainly', /HOLD \(Sideways\)/.test(SRC), 'no Sideways verdict label');

  // "Chop" / "Ranging" as user-facing labels are replaced by "Sideways".
  ok('no "Ranging (chop)" row label', !/Ranging \(chop\)/.test(SRC), 'chop label remains');
  ok('no "Ranging / Chop" summary label', !/Ranging \/ Chop/.test(SRC), 'chop label remains');
  ok('no "choppy/ranging market" phrasing', !/choppy\/ranging market/.test(SRC), 'choppy phrasing remains');
  ok('the ADX chip says Sideways', /'〰 Sideways'/.test(SRC), 'ADX chip not reworded');

  // The classifier's own label, kept in step with the mirror above.
  ok('the range pattern is labelled Sideways Range', /'Sideways Range'/.test(SRC), 'pattern not reworded');
  ok('the old Trading Range label is gone', !/'Trading Range'/.test(SRC), 'old label remains');

  // Explanations should lead with the plain word, not the indicator name.
  ok('the verdict explanation says "moving sideways"', /moving <b>sideways<\/b>/.test(SRC), 'explanation not reworded');
  ok('ADX is kept as supporting evidence, not the headline', /ADX \$\{signals\.adxV\}, below 20/.test(SRC), 'ADX evidence dropped');

  // And the term itself is explained on tap, like every other piece of jargon.
  ok('Sideways is in the glossary', /sideways:\{n:'Sideways \(No Trend\)'/.test(SRC), 'no glossary entry');
  ok('Sideways is a tappable pattern', /\['Sideways\(\?: Range\)\?','sideways'\]/.test(SRC), 'not tappable');

  // Simple mode shows the same label, without breaking its verdict comparisons.
  ok('Simple mode shows the sideways qualifier too', /vLabel=s\.isChop\?'HOLD \(Sideways\)'/.test(SRC), 'simple mode still bare HOLD');
  ok('Simple mode renders the label, not the raw token', /class="sv-call"[^>]*>\$\{vLabel\}/.test(SRC), 'label not rendered');
  ok('Simple mode keeps the bare token for its logic', /v==='HOLD'\?' if it triggers'/.test(SRC), 'logic token broken');
}

// ── Crypto symbol resolution ───────────────────────────────────────────────
group('crypto symbols');
{
  const src = slice('const COIN_TICKERS = {', '\n// Full market symbol', 'coin');
  const src2 = slice('function cryptoMarketSymbol(h, cur, db){', '\n}', 'coinsym') + '\n}';
  const { cryptoTicker, cryptoMarketSymbol } =
    load(src + '\n' + src2, ['cryptoTicker','cryptoMarketSymbol'], { String, Array });

  const DB = [
    ['Bitcoin','BTC-USD','BTC-USD','L1'], ['Ethereum','ETH-USD','ETH-USD','L1'],
    ['XRP (Ripple)','XRP-USD','XRP-USD','Payments'], ['Solana','SOL-USD','SOL-USD','L1'],
  ];

  // The exact bug: upper-casing the id produced symbols that do not exist.
  eq('bitcoin -> BTC, not BITCOIN', cryptoTicker({coinId:'bitcoin'}, DB), 'BTC');
  eq('ethereum -> ETH', cryptoTicker({coinId:'ethereum'}, DB), 'ETH');
  eq('solana -> SOL', cryptoTicker({coinId:'solana'}, DB), 'SOL');
  // Ripple is the case truncation could never fix: id "ripple", ticker "XRP".
  eq('ripple -> XRP (not a prefix of the id)', cryptoTicker({coinId:'ripple'}, DB), 'XRP');

  eq('full market symbol is built for the currency', cryptoMarketSymbol({coinId:'bitcoin'}, 'INR', DB), 'BTC-INR');
  eq('USD pair works too', cryptoMarketSymbol({coinId:'ripple'}, 'USD', DB), 'XRP-USD');

  // Name lookup via the app's own coin list, including the parenthetical alias.
  eq('resolves by display name', cryptoTicker({coin:'Solana'}, DB), 'SOL');
  eq('resolves by the alias in brackets', cryptoTicker({coin:'Ripple'}, DB), 'XRP');
  eq('resolves the bracketed full name', cryptoTicker({coin:'XRP (Ripple)'}, DB), 'XRP');

  // An explicit ticker from the user wins.
  eq('an explicit ticker is trusted', cryptoTicker({coinId:'bitcoin', ticker:'BTC'}, DB), 'BTC');
  eq('and is stripped of any pair suffix', cryptoTicker({ticker:'ETH-USD'}, DB), 'ETH');

  // A bare ticker typed into the id field still resolves.
  eq('a ticker-shaped id resolves', cryptoTicker({coinId:'BTC'}, DB), 'BTC');

  // Unknown coins must return null, NOT a fabricated symbol - fetching a
  // made-up ticker is what made the old failure silent.
  eq('an unknown long id is unresolvable', cryptoTicker({coinId:'somenewcoin'}, DB), null);
  eq('and yields no market symbol', cryptoMarketSymbol({coinId:'somenewcoin'}, 'INR', DB), null);
  eq('empty holding is unresolvable', cryptoTicker({}, DB), null);
  eq('null holding is safe', cryptoTicker(null, DB), null);
  eq('missing db is safe', cryptoTicker({coin:'Solana'}, null), null);

  // ── wiring ──
  ok('refresh no longer upper-cases the coin id',
     !/coinId\.toUpperCase\(\)\+'-INR'/.test(SRC), 'old broken symbol build remains');
  ok('refresh uses the resolver', /cryptoMarketSymbol\(h, 'INR'/.test(SRC), 'resolver not wired');
  ok('unresolvable coins are reported, not silently skipped',
     /had no recognised ticker/.test(SRC), 'no report of unresolved coins');
  ok('a USD pair is tried when the INR pair has no price',
     /replace\(\/-INR\$\/, '-USD'\)/.test(SRC), 'no USD fallback');
  ok('single-row refresh uses the resolver too',
     /No recognised ticker for/.test(SRC), 'single refresh still naive');
}

// ── Attribution & tax-loss harvesting ──────────────────────────────────────
group('attribution & harvesting');
{
  const src = slice('function _atContribution(lots){', '\n// ── Glue + rendering', 'attr');
  const { _atContribution, _atHarvest } = load(src, ['_atContribution','_atHarvest'], { Array, Math, isFinite, Number });
  const L = (name,invested,current,dividend) => ({ name, cls:'India EQ', invested, current, dividend });

  // ── contribution ──
  {
    const a = _atContribution([L('Win',100000,160000,0), L('Flat',100000,100000,0), L('Lose',100000,80000,0)]);
    eq('total P&L nets winners against losers', a.totalPL, 40000);   // +60k -20k
    eq('return is against total invested', +a.totalRetPct.toFixed(4), +(40000/300000*100).toFixed(4));
    eq('winners counted', a.winners.length, 1);
    eq('losers counted', a.losers.length, 1);
    eq('sorted by rupee contribution', a.rows[0].name, 'Win');
    eq('the loser sorts last', a.rows[a.rows.length-1].name, 'Lose');
    eq('shares sum to 100%', +a.rows.reduce((s,r)=>s+(r.sharePct||0),0).toFixed(6), 100);
  }
  {
    // Dividends are part of what a holding contributed.
    const noDiv = _atContribution([L('A',100000,100000,0)]);
    const wDiv  = _atContribution([L('A',100000,100000,5000)]);
    eq('a flat holding with no dividend contributed nothing', noDiv.totalPL, 0);
    eq('dividends count as contribution', wDiv.totalPL, 5000);
  }
  {
    // When winners and losers cancel, "share of total" is meaningless - we must
    // not print +infinity% or a wild number.
    const a = _atContribution([L('Up',100000,150000,0), L('Down',100000,50000,0)]);
    eq('offsetting book nets to zero', a.totalPL, 0);
    ok('shares are suppressed, not fabricated', a.shareMeaningful === false, 'claimed a share anyway');
    ok('and every row reports null', a.rows.every(r => r.sharePct === null), 'a share slipped through');
  }
  eq('unpriceable lots are excluded', _atContribution([L('X',0,100,0), L('Y',100000,120000,0)]).rows.length, 1);
  eq('an empty book yields null', _atContribution([]), null);

  // ── harvesting ──
  {
    // 3 lakh LTCG booked; exemption absorbs 1.25L, leaving 1.75L to offset.
    const h = _atHarvest([L('Down1',100000,60000,0), L('Down2',100000,90000,0), L('Up',100000,140000,0)], 300000, 0);
    eq('only holdings under water are candidates', h.candidates.length, 2);
    eq('largest loss first', h.candidates[0].name, 'Down1');
    eq('total unrealised loss', h.totalLoss, 50000);          // 40k + 10k
    eq('exemption fully used', h.exemptionUsed, 125000);
    eq('nothing left of the exemption', h.exemptionLeft, 0);
    eq('offsettable gain is net of the exemption', h.offsettable, 175000);
    eq('all the loss is useful here', h.usefulLoss, 50000);
  }
  {
    // Gains below the exemption: nothing to offset, so booking a loss achieves
    // nothing this year and must not be recommended.
    const h = _atHarvest([L('Down',100000,50000,0)], 100000, 0);
    eq('exemption not exhausted', h.exemptionLeft, 25000);
    eq('no offsettable gain', h.offsettable, 0);
    eq('so no loss is worth booking', h.usefulLoss, 0);
  }
  {
    // Loss larger than the gains: useful amount is capped at the gains.
    const h = _atHarvest([L('Down',1000000,100000,0)], 200000, 0);
    eq('useful loss is capped at offsettable gains', h.usefulLoss, 75000); // 200k-125k
    ok('but the full loss is still reported', h.totalLoss === 900000, String(h.totalLoss));
  }
  {
    // Short-term gains have no exemption - they are offsettable in full.
    const h = _atHarvest([L('Down',100000,40000,0)], 0, 90000);
    eq('STCG is offsettable without exemption', h.offsettable, 90000);
    eq('exemption untouched by STCG', h.exemptionLeft, 125000);
  }
  eq('a book with no losses has no candidates', _atHarvest([L('Up',100,200,0)], 500000, 0).candidates.length, 0);
  eq('empty book is safe', _atHarvest([], 0, 0).totalLoss, 0);

  // ── wiring ──
  ok('both cards render on the analysis tab', /renderAttribution\(\);renderHarvest\(\)/.test(SRC), 'not wired');
  ok('harvesting reuses the FIFO matcher for realised gains',
     /_atRealisedThisFY[\s\S]{0,400}fifoMatchSells/.test(SRC), 'duplicate realised-gain logic');
  ok('the panel says the losses are unrealised', /nothing is booked until you actually sell/.test(SRC), 'overclaims');
  ok('and warns booking has real costs', /spread, brokerage/.test(SRC), 'no cost caveat');
}

// ── Risk metrics ───────────────────────────────────────────────────────────
group('risk metrics');
{
  const src = slice('const RISK_TRADING_DAYS = 252;', '\n// ── Glue: fetch each holding', 'risk');
  const { _rkAlignedReturns, _rkStdev, _rkBeta, _rkMetrics } =
    load(src, ['_rkAlignedReturns','_rkStdev','_rkBeta','_rkMetrics'], { Math, Object, Set, Array, isFinite, Number });

  const day = i => '2026-' + String(1 + Math.floor(i/28)).padStart(2,'0') + '-' + String(1 + (i%28)).padStart(2,'0');
  const ser = (vals, off=0) => vals.map((c,i) => ({ d: day(i+off), c }));

  // ── stdev ──
  eq('stdev of a constant series is 0', _rkStdev([1,1,1,1]), 0);
  eq('too few points -> null', _rkStdev([1]), null);
  ok('stdev is the sample (n-1) form', Math.abs(_rkStdev([2,4,4,4,5,5,7,9]) - 2.1380899) < 1e-6, String(_rkStdev([2,4,4,4,5,5,7,9])));

  // ── alignment ──
  {
    // Two holdings, equal weight, both rising 10% a day -> portfolio +10%/day.
    const r = _rkAlignedReturns({ A: ser([100,110,121]), B: ser([50,55,60.5]) }, { A:1, B:1 });
    eq('one return per interval', r.length, 2);
    ok('equal-weight return is the common move', Math.abs(r[0].r - 0.10) < 1e-9, String(r[0].r));
  }
  {
    // Weighting must actually bite: 90/10 between +10%/day and flat.
    const r = _rkAlignedReturns({ A: ser([100,110,121]), B: ser([100,100,100]) }, { A:9, B:1 });
    ok('returns are value-weighted', Math.abs(r[0].r - 0.09) < 1e-9, String(r[0].r));
  }
  {
    // A holding missing a date must not shift the other's returns. Only dates
    // common to every series are used.
    const A = [{d:'2026-01-01',c:100},{d:'2026-01-02',c:110},{d:'2026-01-03',c:121}];
    const B = [{d:'2026-01-01',c:100},                        {d:'2026-01-03',c:100}];
    const r = _rkAlignedReturns({ A, B }, { A:1, B:1 });
    eq('only common dates are used', r.length, 1);
    eq('and it is the shared date', r[0].d, '2026-01-03');
  }
  eq('a single-close series yields null', _rkAlignedReturns({ A: ser([100]) }, { A:1 }), null);
  // A thin holding must not nullify the whole book - alignment just reports the
  // common days; whether that is enough is _rkMetrics's judgement.
  ok('two closes still yield one return', _rkAlignedReturns({ A: ser([100,110]) }, { A:1 }).length === 1, 'thin series poisons the book');
  eq('no weights yields null', _rkAlignedReturns({ A: ser([100,110,120]) }, { A:0 }), null);
  eq('empty map yields null', _rkAlignedReturns({}, {}), null);

  // ── beta ──
  {
    // Portfolio moves exactly twice the benchmark -> beta 2, correlation 1.
    const b = [], p = [];
    for(let i=0;i<60;i++){ const x = ((i*37)%11 - 5)/500; b.push({d:day(i), r:x}); p.push({d:day(i), r:2*x}); }
    const r = _rkBeta(p, b);
    ok('beta of a 2x tracker is 2', Math.abs(r.beta - 2) < 1e-9, String(r.beta));
    ok('and correlation is 1', Math.abs(r.corr - 1) < 1e-9, String(r.corr));
  }
  {
    // Fewer than 20 overlapping days is not a measurement.
    const b = [], p = [];
    for(let i=0;i<10;i++){ b.push({d:day(i), r:0.01}); p.push({d:day(i), r:0.02}); }
    eq('too little overlap -> null beta', _rkBeta(p, b), null);
  }
  {
    // A flat benchmark has no variance to regress against.
    const b = [], p = [];
    for(let i=0;i<40;i++){ b.push({d:day(i), r:0}); p.push({d:day(i), r:(i%3-1)/100}); }
    eq('a flat benchmark yields null beta', _rkBeta(p, b), null);
  }

  // ── metrics ──
  {
    const p = [];
    for(let i=0;i<60;i++) p.push({ d:day(i), r:((i*37)%11 - 5)/500 });
    const m = _rkMetrics(p, null, 6.5);
    ok('volatility is annualised and positive', m.vol > 0, String(m.vol));
    eq('risk-free rate is carried through', m.riskFree, 6.5);
    eq('beta is null without a benchmark', m.beta, null);
    ok('sharpe is computed from vol and return', m.sharpe != null, 'no sharpe');
  }
  {
    // A steadily rising, never-wobbling series has ~zero volatility, so Sharpe
    // must not be reported as a huge number off a divide-by-almost-zero.
    const p = [];
    for(let i=0;i<40;i++) p.push({ d:day(i), r:0.001 });
    const m = _rkMetrics(p, null, 6.5);
    eq('zero-variance series reports zero volatility', m.vol, 0);
    eq('and withholds Sharpe rather than dividing by zero', m.sharpe, null);
  }
  eq('under 20 days is refused', _rkMetrics([{d:'a',r:0.01},{d:'b',r:0.02}], null, 6.5), null);

  // ── wiring ──
  ok('risk card renders on the analysis tab', /analysis:\(\)=>\{[^}]*renderRisk\(\)/.test(SRC), 'not wired');
  // Diversification reuses the price history renderRisk fetches, so it must run
  // AFTER it resolves rather than racing an empty cache.
  ok('diversification waits for the risk fetch',
     /renderRisk\(\)\.then\(\(\)=>\{try\{renderDiversification\(\);\}catch\(e\)\{\}\}\)/.test(SRC),
     'diversification may race the price fetch');
  ok('history is fetched through the owner Worker', /renderRisk[\s\S]{0,700}_selfProxyUrl/.test(SRC), 'not via Worker');
  ok('it says so when no Worker is configured', /Risk metrics need per-holding price history/.test(SRC), 'no explanation');
  ok('coverage is reported, not hidden', /<b>\$\{covered\} of \$\{total\}<\/b>/.test(SRC), 'coverage not surfaced');
  ok('holdings without history are named', /No usable history for:/.test(SRC), 'exclusions not named');
  ok('it does not present the past as a forecast', /not a forecast/.test(SRC), 'overclaims');
}

// ── Estimated tax if sold today ────────────────────────────────────────────
group('tax if sold today');
{
  const src = slice('function _ifSoldRows(lots, asOf, ltDays){', '\nfunction renderIfSold()', 'ifsold');
  const { _ifSoldRows, _ifSoldTax } = load(src, ['_ifSoldRows','_ifSoldTax'], { Array, Math, Date, isFinite, Object, Number });
  const asOf = new Date('2026-04-01T00:00:00Z');
  const L = (name,cls,invested,current,buyDate) => ({ name, cls, invested, current, buyDate });

  // ── classification by real holding period ──
  {
    const { rows } = _ifSoldRows([
      L('Old','India EQ',100000,200000,'2020-01-01'),
      L('New','India EQ',100000,120000,'2026-02-01'),
    ], asOf, 365);
    eq('both are datable', rows.length, 2);
    ok('a 6-year hold is long term', rows[0].isLTCG === true, 'not LTCG');
    ok('a 2-month hold is short term', rows[1].isLTCG === false, 'not STCG');
  }
  {
    // Undated holdings cannot be classified and must be excluded, not guessed.
    const { rows, undated } = _ifSoldRows([L('NoDate','India EQ',100000,200000,null)], asOf, 365);
    eq('undated is not classified', rows.length, 0);
    eq('and is reported separately', undated.length, 1);
  }
  eq('a future purchase date is excluded', _ifSoldRows([L('F','India EQ',1,2,'2030-01-01')], asOf, 365).rows.length, 0);
  eq('zero-cost lots are ignored', _ifSoldRows([L('Z','India EQ',0,100,'2020-01-01')], asOf, 365).rows.length, 0);

  // ── tax arithmetic ──
  {
    // 3L long-term gain: 1.25L exempt, 1.75L @12.5% = 21,875.
    const r = _ifSoldTax([L('A','India EQ',100000,400000,'2020-01-01')], asOf);
    eq('LTCG total', r.ltcgTotal, 300000);
    eq('taxable after exemption', r.ltcgTaxable, 175000);
    eq('LTCG tax at 12.5%', r.ltcgTax, 21875);
    eq('no STCG', r.stcgTax, 0);
    eq('cess is 4% on top', +r.totalWithCess.toFixed(2), +(21875*1.04).toFixed(2));
  }
  {
    // Short-term gain 1L @20% = 20,000, with no exemption.
    const r = _ifSoldTax([L('B','India EQ',100000,200000,'2026-02-01')], asOf);
    eq('STCG tax at 20%', r.stcgTax, 20000);
    eq('exemption does not apply to STCG', r.ltcgTax, 0);
  }
  {
    // A long-term gain under the exemption is untaxed.
    const r = _ifSoldTax([L('C','India EQ',100000,180000,'2020-01-01')], asOf);
    eq('gain below the exemption is untaxed', r.ltcgTax, 0);
  }
  {
    // Losses reduce the taxable total rather than being taxed.
    const r = _ifSoldTax([
      L('Win','India EQ',100000,500000,'2020-01-01'),
      L('Lose','India EQ',100000,50000,'2020-01-01'),
    ], asOf);
    eq('long-term gains and losses net off', r.ltcgTotal, 350000);
    eq('tax applies to the net after exemption', r.ltcgTax, (350000-125000)*0.125);
  }
  {
    // Crypto is taxed on gains only - a VDA loss cannot reduce a VDA gain.
    const r = _ifSoldTax([
      L('BTC','Crypto',100000,300000,'2020-01-01'),
      L('ALT','Crypto',100000,20000,'2020-01-01'),
    ], asOf);
    eq('VDA gains only', r.vdaGain, 200000);
    eq('VDA tax at 30%', r.vdaTax, 60000);
    eq('crypto is kept out of the equity buckets', r.ltcgTotal, 0);
  }
  {
    const r = _ifSoldTax([L('N','India EQ',100000,90000,'2020-01-01')], asOf);
    eq('an overall loss owes no tax', r.total, 0);
  }

  // ── wiring & honesty ──
  ok('the panel renders with the taxation tab', /renderTaxation\(\);renderIfSold\(\)/.test(SRC), 'not wired');
  ok('it is presented as a what-if, not a bill', /A <b>what-if<\/b> estimate/.test(SRC), 'overclaims');
  ok('the averaged-cost limitation is disclosed',
     /actual tax on sale is computed FIFO lot by lot and will differ/.test(SRC), 'limitation hidden');
  ok('undated holdings are surfaced as excluded', /cannot be classified long or short term/.test(SRC), 'exclusions hidden');
}

// ── USD/INR auto-refresh ───────────────────────────────────────────────────
group('fx auto-refresh');
{
  const src = slice('function _fxIsStale(rec, today){', '\n// Record a manual entry', 'fx');
  const { _fxIsStale, _fxPlausible } = load(src, ['_fxIsStale','_fxPlausible'], { isFinite, Number });

  eq('same day is not stale', _fxIsStale({d:'2026-09-02',v:88}, '2026-09-02'), false);
  eq('yesterday is stale', _fxIsStale({d:'2026-09-01',v:88}, '2026-09-02'), true);
  eq('no record is stale', _fxIsStale(null, '2026-09-02'), true);
  eq('a record with no date is stale', _fxIsStale({v:88}, '2026-09-02'), true);

  // A wrong symbol or a bad parse could return a share price or a percentage.
  // Adopting it silently would corrupt every US valuation and the tax figures.
  ok('a realistic rate is accepted', _fxPlausible(88.4), 'rejected a good rate');
  ok('an absurdly high value is refused', !_fxPlausible(24000), 'accepted a share price');
  ok('an absurdly low value is refused', !_fxPlausible(1.2), 'accepted a ratio');
  ok('zero is refused', !_fxPlausible(0), 'accepted zero');
  ok('NaN is refused', !_fxPlausible(NaN), 'accepted NaN');

  ok('the rate refreshes on boot', /try \{ fxRefresh\(\); \} catch\(e\)\{\}/.test(SRC), 'not refreshed on boot');
  ok('it fetches the USD/INR pair', /_FX_SYM\s*=\s*'USDINR=X'/.test(SRC), 'wrong symbol');
  ok('it only refetches once a day', /_fxIsStale\(rec, today\)/.test(SRC), 'no daily guard');
  ok('manual entry is still possible', /function fxSetManual/.test(SRC), 'manual override removed');
  ok('the badge says it is automatic', /Auto-updated daily\. Click to set it manually\./.test(SRC), 'tooltip not updated');
}

// ── Diversification ────────────────────────────────────────────────────────
group('diversification');
{
  const src = slice('function _dvCorr(xs, ys){', '\n// ── Render', 'dv');
  const { _dvCorr, _dvEffective, _dvMatrix, _dvVerdict } =
    load(src, ['_dvCorr','_dvEffective','_dvMatrix','_dvVerdict'], { Math, Object, Set, Array, isFinite, Number });

  // ── correlation ──
  {
    const xs = [], ys = [], zs = [];
    for(let i=0;i<40;i++){ const v = ((i*13)%7 - 3)/100; xs.push(v); ys.push(v); zs.push(-v); }
    ok('identical series correlate at 1', Math.abs(_dvCorr(xs,ys) - 1) < 1e-9, String(_dvCorr(xs,ys)));
    ok('mirrored series correlate at -1', Math.abs(_dvCorr(xs,zs) + 1) < 1e-9, String(_dvCorr(xs,zs)));
  }
  eq('too few points -> null', _dvCorr([1,2,3],[1,2,3]), null);
  {
    const flat = new Array(40).fill(0), moving = flat.map((_,i) => (i%3-1)/100);
    eq('a flat series has no correlation', _dvCorr(flat, moving), null);
  }

  // ── effective holdings: concentration by size ──
  {
    const e = _dvEffective([25,25,25,25]);
    eq('four equal holdings behave like four', +e.effective.toFixed(6), 4);
    eq('largest weight reported', +e.topWeightPct.toFixed(2), 25);
  }
  {
    // The point of the measure: 20 names, one dominant, behaves like far fewer.
    const w = [60].concat(new Array(19).fill(40/19));
    const e = _dvEffective(w);
    eq('counts the holdings you actually have', e.n, 20);
    ok('but effective count is far lower', e.effective < 4, String(e.effective));
    ok('and names the dominant weight', Math.abs(e.topWeightPct - 60) < 1e-9, String(e.topWeightPct));
  }
  eq('no holdings -> null', _dvEffective([]), null);
  eq('zero values -> null', _dvEffective([0,0]), null);

  // ── matrix ──
  {
    // Two holdings moving identically: average correlation 1 -> not diversified.
    const a = [], b = [];
    for(let i=0;i<40;i++){ const c = 100 * Math.pow(1.01, (i*7)%5); a.push({d:'d'+String(i).padStart(3,'0'), c}); b.push({d:'d'+String(i).padStart(3,'0'), c:c*2}); }
    const m = _dvMatrix({ A:a, B:b });
    ok('identical movers average ~1', Math.abs(m.avg - 1) < 1e-6, String(m.avg));
    eq('one pair for two holdings', m.pairs.length, 1);
    eq('verdict names the risk', _dvVerdict(m.avg).word, 'Barely diversified');
  }
  eq('a single holding cannot be correlated', _dvMatrix({ A:[{d:'a',c:1}] }), null);
  eq('too-short history -> null', _dvMatrix({ A:[{d:'a',c:1}], B:[{d:'a',c:2}] }), null);

  // ── verdict bands ──
  eq('high correlation reads as barely diversified', _dvVerdict(0.9).word, 'Barely diversified');
  eq('mid correlation reads as lightly', _dvVerdict(0.6).word, 'Lightly diversified');
  eq('low correlation reads as well diversified', _dvVerdict(0.1).word, 'Well diversified');
  eq('no average -> no verdict', _dvVerdict(null), null);

  ok('the card admits correlation ignores position size', /weight-blind/.test(SRC), 'limitation hidden');
  ok('and warns correlation rises in a crash', /rises in a crash/.test(SRC), 'no crash caveat');
}

// ── Rebalancing & concentration ────────────────────────────────────────────
group('rebalancing');
{
  const src = slice('const _RB_CLASSES = [', '\n// ── Render', 'rb');
  const { _rbDrift, _rbConcentration } = load(src.replace(/^function rbLoadTargets[\s\S]*?\n\}\n/m,''),
    ['_rbDrift','_rbConcentration'], { Math, Object, Array, isFinite, Number });

  // ── drift ──
  {
    const d = _rbDrift({ indEQ:600000, usEQ:200000, crypto:200000 }, { indEQ:50, usEQ:30, crypto:20 });
    const ind = d.rows.find(r => r.key==='indEQ');
    eq('actual share computed', +ind.actualPct.toFixed(2), 60);
    eq('drift is actual minus target', +ind.driftPct.toFixed(2), 10);
    eq('and sized in rupees to trim', +ind.driftValue.toFixed(0), 100000);
    const us = d.rows.find(r => r.key==='usEQ');
    ok('an underweight class shows a negative drift', us.driftPct < 0, String(us.driftPct));
    ok('targets summing to 100 are accepted', d.targetsSumOk === true, 'flagged a valid target set');
  }
  {
    // Targets that do not sum to 100 cannot all be met - say so rather than
    // emitting trades that silently contradict each other.
    const d = _rbDrift({ indEQ:100 }, { indEQ:40, usEQ:40 });
    ok('mismatched targets are flagged', d.targetsSumOk === false, 'did not flag');
    eq('and the shortfall is reported', d.targetedPct, 80);
  }
  {
    // An unset target must NOT be read as "should be zero" - that would demand
    // liquidating a class the user simply had not configured.
    const d = _rbDrift({ indEQ:500000, crypto:500000 }, { indEQ:50 });
    const cry = d.rows.find(r => r.key==='crypto');
    eq('untargeted class has no target', cry.targetPct, null);
    eq('and therefore no drift', cry.driftPct, null);
    ok('it is marked untargeted', cry.hasTarget === false, 'treated as targeted');
  }
  eq('an empty book yields null', _rbDrift({}, { indEQ:50 }), null);
  eq('a zero-value book yields null', _rbDrift({ indEQ:0 }, { indEQ:50 }), null);

  // ── concentration ──
  {
    const c = _rbConcentration([{name:'Big',value:400},{name:'A',value:200},{name:'B',value:200},{name:'C',value:200}], 25);
    eq('sorted by weight', c.rows[0].name, 'Big');
    eq('largest weight is correct', +c.rows[0].pct.toFixed(2), 40);
    eq('only true breaches are flagged', c.breaches.length, 1);
    eq('and it is the big one', c.breaches[0].name, 'Big');
  }
  {
    const c = _rbConcentration([{name:'A',value:100},{name:'B',value:100}], 60);
    eq('nothing breaches a generous limit', c.breaches.length, 0);
  }
  eq('an empty list yields null', _rbConcentration([], 15), null);
  eq('all-zero values yield null', _rbConcentration([{name:'A',value:0}], 15), null);

  // ── wiring ──
  ok('rebalance card renders on the analysis tab', /renderRebalance\(\)/.test(SRC), 'not wired');
  ok('blank targets are explained, not assumed zero',
     /they are not treated as "should be zero"/.test(SRC), 'no explanation');
  ok('it warns that rebalancing is taxable', /rebalancing realises gains, which is taxable/.test(SRC), 'no tax warning');
  ok('targets are the user\'s, not advice', /Targets and the limit are yours/.test(SRC), 'presented as advice');
}

// ── Tax reporting period ───────────────────────────────────────────────────
group('tax period selection');
{
  const src = slice('function currentFY(now){', '\n// What the UI currently has selected', 'period');
  const { currentFY, fyOptions, taxPeriod } =
    load(src, ['currentFY','fyOptions','taxPeriod'], { Date, String, Number, isFinite });

  // India's FY runs 1 Apr - 31 Mar, so Jan-Mar belongs to the PREVIOUS start year.
  eq('September 2026 is FY 2026-27', currentFY(new Date('2026-09-02')), '2026-27');
  eq('1 April flips to the new FY', currentFY(new Date('2026-04-01')), '2026-27');
  eq('31 March is still the old FY', currentFY(new Date('2026-03-31')), '2025-26');
  eq('January belongs to the previous start year', currentFY(new Date('2026-01-15')), '2025-26');
  eq('a century-crossing year formats correctly', currentFY(new Date('2099-06-01')), '2099-00');

  // The list must lead with the CURRENT year - the old hard-coded markup
  // defaulted to a stale FY and offered no way to reach the current one.
  {
    const o = fyOptions(new Date('2026-09-02'), 3);
    eq('current FY is first', o[0].value, '2026-27');
    ok('FY 2026-27 is offered', o.some(x => x.value === '2026-27'), 'missing 2026-27');
    eq('previous years follow', o.map(x=>x.value).join(','), '2026-27,2025-26,2024-25,2023-24');
    ok('label carries the assessment year', /AY 2027-28 \(FY 2026-27\)/.test(o[0].label), o[0].label);
  }

  // ── FY bounds ──
  {
    const p = taxPeriod('2026-27');
    eq('starts 1 April', p.start.toISOString().slice(0,10), '2026-04-01');
    eq('ends 31 March', p.end.toISOString().slice(0,10), '2027-03-31');
    ok('the last day is included in full', p.end.getHours() === 23, String(p.end.getHours()));
    eq('labelled as an FY', p.label, 'FY 2026-27');
    ok('not flagged custom', p.custom === false, 'wrongly custom');
  }

  // ── custom range ──
  {
    const p = taxPeriod('custom', '2026-04-01', '2026-06-30');
    ok('a valid range has no error', !p.error, p.error);
    eq('start honoured', p.start.toISOString().slice(0,10), '2026-04-01');
    eq('end honoured', p.end.toISOString().slice(0,10), '2026-06-30');
    eq('labelled by its dates', p.label, '2026-04-01 to 2026-06-30');
    ok('flagged custom', p.custom === true, 'not flagged custom');
  }
  // A half-filled or inverted range must produce an error, NOT a silently
  // wrong window that yields plausible-looking tax numbers.
  ok('missing both dates errors', !!taxPeriod('custom','','').error, 'no error');
  ok('missing the end date errors', !!taxPeriod('custom','2026-04-01','').error, 'no error');
  ok('missing the start date errors', !!taxPeriod('custom','','2026-06-30').error, 'no error');
  {
    const p = taxPeriod('custom','2026-06-30','2026-04-01');
    ok('an inverted range errors', !!p.error, 'no error');
    ok('and says which way round', /start date is after the end date/.test(p.error), p.error);
  }
  ok('unreadable dates error', !!taxPeriod('custom','not-a-date','2026-06-30').error, 'no error');
  ok('a bad FY string errors', !!taxPeriod('nonsense').error, 'no error');
  {
    // No selection at all falls back to the current FY rather than a stale one.
    const p = taxPeriod(undefined);
    ok('no selection defaults to an FY window', !p.error && p.custom === false, JSON.stringify(p));
  }

  // ── wiring ──
  ok('the FY list is built at boot, not hard-coded', /fyOptions\(new Date\(\), 3\)/.test(SRC), 'still hard-coded');
  ok('a custom option is offered', /<option value="custom">Custom period/.test(SRC), 'no custom option');
  ok('custom date inputs exist', SRC.includes('id="tax-from"') && SRC.includes('id="tax-to"'), 'no date inputs');
  ok('taxation refuses to compute on a broken period',
     /if\(_period\.error\) return;/.test(SRC), 'computes over a bad window');
  ok('the error is shown to the user', /Nothing is computed until the period is valid/.test(SRC), 'error hidden');
  ok('harvesting uses the same resolver', /taxPeriodFromUI/.test(SRC), 'periods can diverge');
  ok('the stale hard-coded FY list is gone', !/AY 2025-26 \(FY 2024-25\)<\/option>/.test(SRC), 'old list remains');
  // The chip advertised 10% while the code computes 12.5%.
  ok('the LTCG chip matches the computed rate', /Equity 12\.5% tax above ₹1\.25L/.test(SRC), 'chip still says 10%');
  ok('no 10% LTCG claim remains', !/Equity 10% tax above/.test(SRC), 'stale 10% claim');
}

// ── Financial statements ───────────────────────────────────────────────────
group('financial statements');
{
  const src = slice('function _stNum(o){', '\n// ── Fetch + render', 'stmt');
  const { _stNum, _stDate, _stTable, _stParse, _stTsSeries, _stTsParse, _stCells, ST_INCOME } =
    load(src, ['_stNum','_stDate','_stTable','_stParse','_stTsSeries','_stTsParse','_stCells',
               'ST_INCOME'],
         { Date, Math, Array, Object, Set, isFinite, Number });

  // Yahoo wraps values as {raw,fmt}; absent keys and empty objects both occur.
  eq('unwraps a raw value', _stNum({ raw: 1234, fmt: '1.23k' }), 1234);
  eq('accepts a bare number', _stNum(5), 5);
  eq('null stays null', _stNum(null), null);
  eq('undefined stays null', _stNum(undefined), null);
  eq('an empty wrapper is null, not zero', _stNum({}), null);
  eq('a non-finite raw is null', _stNum({ raw: Infinity }), null);
  eq('zero is preserved as a real zero', _stNum({ raw: 0 }), 0);

  eq('epoch seconds become a date', _stDate({ raw: 1735689600 }), '2025-01-01');
  eq('a missing date is null', _stDate(null), null);

  // ── fundamentals-timeseries: the endpoint that still carries real data ──
  const tsEntry = (date, v) => ({ asOfDate: date, reportedValue: { raw: v } });
  const tsRes = (type, entries) => ({ meta: { type: [type] }, [type]: entries });
  {
    const json = { timeseries: { result: [
      tsRes('annualTotalRevenue', [ tsEntry('2024-03-31', 100), tsEntry('2025-03-31', 200) ]),
      tsRes('annualNetIncome',    [ tsEntry('2024-03-31', 10),  tsEntry('2025-03-31', 20) ]),
      tsRes('annualStockholdersEquity', [ tsEntry('2025-03-31', 400) ]),
      tsRes('annualOperatingCashFlow',  [ tsEntry('2025-03-31', 30) ]),
      tsRes('annualFreeCashFlow',       [ tsEntry('2025-03-31', 25) ]),
    ]}};
    const series = _stTsSeries(json);
    eq('series are keyed by type and date', series.annualTotalRevenue['2025-03-31'], 200);
    const p = _stTsParse(json, false);
    eq('the parsed result names its endpoint', p.source, 'timeseries');
    eq('newest period first', p.income.periods[0], '2025-03-31');
    const rev = p.income.rows.find(r => r.key === 'TotalRevenue');
    eq('values follow the period order', rev.values.join(','), '200,100');
    const cost = p.income.rows.find(r => r.key === 'CostOfRevenue');
    ok('a line the source omits is null, never 0', cost.values.every(v => v === null), JSON.stringify(cost.values));
    // A series that only covers the newest period must not smear into the older
    // column - the older cell is unknown, not a repeat.
    const eqr = p.balance.rows.find(r => r.key === 'StockholdersEquity');
    eq('a short series fills only its own period', eqr.values[0], 400);
    // The line map carries every field, including ones no table displays.
    eq('the parse exposes a line map for the ratio engine', p.line.TotalRevenue['2025-03-31'], 200);
    eq('and the union of every period seen', p.periodsAll[0], '2025-03-31');
  }
  eq('an empty timeseries yields null', _stTsParse({ timeseries: { result: [] } }, false), null);
  eq('a malformed timeseries yields null', _stTsParse({}, false), null);
  {
    // Padded entries come through as null and must be skipped, not counted.
    const json = { timeseries: { result: [
      tsRes('annualTotalRevenue', [ null, tsEntry('2025-03-31', 200) ]),
    ]}};
    const p = _stTsParse(json, false);
    eq('padded nulls are skipped', p.income.periods.length, 1);
  }
  {
    // The quarterly request must read the quarterly series, not the annual one.
    const json = { timeseries: { result: [
      tsRes('annualTotalRevenue',    [ tsEntry('2025-03-31', 900) ]),
      tsRes('quarterlyTotalRevenue', [ tsEntry('2025-06-30', 250) ]),
    ]}};
    const q = _stTsParse(json, true);
    eq('quarterly reads the quarterly prefix', q.income.periods[0], '2025-06-30');
    eq('and its values', q.income.rows.find(r => r.key === 'TotalRevenue').values[0], 250);
    eq('annual reads the annual prefix', _stTsParse(json, false).income.periods[0], '2025-03-31');
  }

  // ── quoteSummary fallback: table shaping ──
  const st = (endDate, rev, ni) => ({ endDate:{raw:endDate}, totalRevenue:{raw:rev}, netIncome:{raw:ni} });
  {
    const t2 = _stTable([ st(1704067200, 100, 10), st(1735689600, 200, 20) ], ST_INCOME);
    eq('newest period first', t2.periods[0], '2025-01-01');
    eq('older period second', t2.periods[1], '2024-01-01');
    const rev = t2.rows.find(r => r.key === 'TotalRevenue');
    eq('fallback rows carry the shared row key', rev.values.join(','), '200,100');
    const cost = t2.rows.find(r => r.key === 'CostOfRevenue');
    ok('a line the source omits is null, never 0', cost.values.every(v => v === null), JSON.stringify(cost.values));
    const fcf = t2.rows.find(r => r.key === 'FreeCashFlow');
    ok('a line the old endpoint never carried is null', !fcf || fcf.values.every(v => v === null), 'fabricated');
  }
  {
    // The reason this whole route is a fallback: it zero-fills lines it no
    // longer carries. A line reading exactly zero in every period is that
    // artefact - reporting it as a confident ₹0 would be a false claim about
    // the accounts.
    const z = (endDate) => ({ endDate:{raw:endDate}, totalRevenue:{raw:5000},
                              costOfRevenue:{raw:0}, grossProfit:{raw:0} });
    const t2 = _stTable([ z(1704067200), z(1735689600) ], ST_INCOME);
    const cost = t2.rows.find(r => r.key === 'CostOfRevenue');
    ok('an all-zero line is reported as unknown', cost.values.every(v => v === null), JSON.stringify(cost.values));
    const rev = t2.rows.find(r => r.key === 'TotalRevenue');
    eq('a line with real numbers is untouched', rev.values[0], 5000);
  }
  {
    // ...but a genuine zero alongside real numbers still means zero. A
    // debt-free company reporting 0 long-term debt is a fact, not a gap.
    const t2 = _stTable([ { endDate:{raw:1735689600}, totalRevenue:{raw:0}, netIncome:{raw:50} },
                          { endDate:{raw:1704067200}, totalRevenue:{raw:900}, netIncome:{raw:40} } ], ST_INCOME);
    eq('a zero in one period survives', t2.rows.find(r => r.key === 'TotalRevenue').values[0], 0);
  }
  eq('no statements -> null', _stTable([], ST_INCOME), null);
  eq('non-array -> null', _stTable(null, ST_INCOME), null);
  eq('statements with no dates -> null', _stTable([{ totalRevenue:{raw:5} }], ST_INCOME), null);
  {
    // A table where every cell is missing is not a statement - the UI must be
    // able to say "not available" rather than draw an empty grid.
    const t2 = _stTable([{ endDate:{raw:1735689600} }], ST_INCOME);
    eq('an all-empty statement yields null', t2, null);
  }
  {
    const many = [];
    for(let i=0;i<9;i++) many.push(st(1735689600 - i*31536000, 100+i, 10+i));
    eq('at most five periods are shown', _stTable(many, ST_INCOME).periods.length, 5);
  }

  // ── whole-response parsing ──
  {
    const json = { quoteSummary: { result: [{
      incomeStatementHistory: { incomeStatementHistory: [ st(1735689600, 1000, 100) ] },
      balanceSheetHistory:    { balanceSheetStatements: [ { endDate:{raw:1735689600}, totalAssets:{raw:5000}, totalStockholderEquity:{raw:2000}, longTermDebt:{raw:1000} } ] },
      cashflowStatementHistory:{ cashflowStatements:    [ { endDate:{raw:1735689600}, totalCashFromOperatingActivities:{raw:150}, capitalExpenditures:{raw:-50} } ] },
    }]}};
    const p = _stParse(json, false);
    eq('the fallback result names its endpoint', p.source, 'quoteSummary');
    ok('income parsed', !!p.income, 'no income');
    ok('balance parsed', !!p.balance, 'no balance');
    ok('cashflow parsed', !!p.cashflow, 'no cashflow');
    eq('filled cells are counted for the fallback decision', _stCells(p) > 0, true);
    // The fallback has no extra lines to offer, so its map is exactly what the
    // display tables hold - nothing is invented to fill the ratio engine.
    eq('the fallback also exposes a line map', p.line.TotalRevenue['2025-01-01'], 1000);
    ok('and invents no line it did not receive', p.line.EBIT === undefined, 'fabricated EBIT');
  }
  eq('an empty response yields null', _stParse({}, false), null);
  eq('a result with no statements yields null', _stParse({ quoteSummary:{ result:[{}] } }, false), null);
  eq('nothing parsed counts as zero cells', _stCells(null), 0);
  // ── wiring & honesty ──
  // The Worker is a separate file, so assert against it directly - checking
  // SRC would silently pass since worker.js is not part of index.html.
  {
    const wsrc = require('fs').readFileSync(require('path').join(__dirname,'..','proxy','worker.js'),'utf8');
    ok('the Worker exposes a timeseries route', /params\.get\('timeseries'\)/.test(wsrc), 'no timeseries route');
    ok('it calls the fundamentals-timeseries endpoint', /fundamentals-timeseries\/v1\/finance\/timeseries/.test(wsrc), 'wrong endpoint');
    ok('it asks for a period window', /period1=\$\{p1\}&period2=\$\{p2\}/.test(wsrc), 'no period window');
    ok('it prefixes types by period', /pre \+ f/.test(wsrc), 'types not prefixed');
    for(const f of ['TotalRevenue','CostOfRevenue','StockholdersEquity','OperatingCashFlow','FreeCashFlow'])
      ok('it requests ' + f, new RegExp("'" + f + "'").test(wsrc), f + ' not requested');
    ok('the Worker keeps the statements route as a fallback', /params\.get\('statements'\)/.test(wsrc), 'no statements route');
    ok('it requests all three statement modules',
       /incomeStatementHistory\$\{q\},balanceSheetHistory\$\{q\},cashflowStatementHistory\$\{q\}/.test(wsrc),
       'modules missing');
    ok('it supports a quarterly period', /period'\) === 'quarterly'/.test(wsrc), 'no quarterly option');
    ok('it validates the symbol', /\[A-Za-z0-9\.\\-\^\]\{1,20\}/.test(wsrc), 'symbol not validated');
    ok('it uses the crumb handshake', /_yahooAuth\(\)[\s\S]{0,400}timeseries/.test(wsrc), 'no crumb auth');
  }
  // The app must prefer the good endpoint and only fall back when it is thin.
  ok('the app asks the timeseries route first', /\?timeseries=\$\{enc\}\$\{per\}/.test(SRC), 'timeseries not used');
  ok('the fallback is conditional, not unconditional', /if\(_stCells\(out\) < 4\)\{/.test(SRC), 'always falls back');
  ok('the fallback only wins when it carries more', /if\(_stCells\(alt\) > _stCells\(out\)\) out = alt;/.test(SRC), 'thin fallback can overwrite');
  ok('a Financials tab exists', /data-rtab="financials"/.test(SRC), 'no tab');
  ok('statements load lazily on tab open', /if \(name === 'financials'\)/.test(SRC), 'not lazy');
  // Three markers, three distinct claims. A blank or a bare dash forces the
  // reader to guess which one applies.
  ok('a missing line renders as n/r, not zero',
     /if\(v == null\) return '<span class="rt-na" title="Not reported[^']*>n\/r<\/span>'/.test(SRC),
     'missing renders as a number');
  ok('no em dash survives in the page', (SRC.match(/\u2014/g) || []).length === 0, 'em dashes remain');
  ok('the UI explains n/r means absent', /not that the value is zero/.test(SRC), 'ambiguous marker');
  ok('the UI says when it fell back to the thinner feed', /older, thinner one, expect gaps/.test(SRC), 'fallback unlabelled');
  ok('thin source coverage is named as a source gap', /that is a gap in the source, not an error here/.test(SRC), 'blames the app');
  ok('it warns the data can lag the filing', /can lag the latest filing/.test(SRC), 'no staleness warning');
}

// ── Key ratios ─────────────────────────────────────────────────────────────
group('key ratios');
{
  const src = slice('const RT_EPS = 1e-9;', '\n// ── Display', 'ratios');
  const { computeRatios, ratioBand, isLender, _rtDiv, _rtGrowth, _rtLatest, _rtPair, RT_LENDER_NA } =
    load(src, ['computeRatios','ratioBand','isLender','_rtDiv','_rtGrowth','_rtLatest','_rtPair','RT_LENDER_NA'],
         { Math, Object, Array, isFinite, Number });

  // Build a statements object the way statements.js hands one over.
  const mk = (byDate) => {
    const line = {}, dates = Object.keys(byDate).sort().reverse();
    for(const d of dates) for(const k of Object.keys(byDate[d])) (line[k] || (line[k] = {}))[d] = byDate[d][k];
    return { line, periodsAll: dates };
  };

  // Rounding that survives a null: a regression must fail the assertion, not
  // crash the runner and take every later test with it.
  const fx = (v, dp) => (v == null || !isFinite(v)) ? null : +v.toFixed(dp);

  // ── division and growth guards ──
  eq('a normal division works', _rtDiv(10, 4), 2.5);
  eq('a null numerator is null', _rtDiv(null, 4), null);
  eq('a null denominator is null', _rtDiv(10, null), null);
  eq('division by zero is null, not Infinity', _rtDiv(10, 0), null);
  // A denominator that is float noise rather than a real number must not
  // produce an enormous ratio that reads as a genuine result.
  eq('division by float noise is null, not 1e13', _rtDiv(10, 1e-12), null);
  eq('growth needs a positive base', _rtGrowth({ now: 50, prev: -100 }), null);
  eq('growth from zero is null, not Infinity', _rtGrowth({ now: 50, prev: 0 }), null);
  eq('ordinary growth is a percentage', _rtGrowth({ now: 120, prev: 100 }), 20);
  eq('one period cannot make a growth rate', _rtPair(mk({ '2025-03-31': { TotalRevenue: 100 } }), 'TotalRevenue'), null);

  // A line is read at its own newest date: a balance sheet published later than
  // an income statement must not read as missing.
  {
    const t = mk({ '2025-03-31': { TotalRevenue: 100 }, '2024-03-31': { TotalRevenue: 80, TotalAssets: 500 } });
    eq('a lagging line is read at its own latest date', _rtLatest(t, 'TotalAssets').v, 500);
    eq('and reports which period that was', _rtLatest(t, 'TotalAssets').date, '2024-03-31');
    eq('a line never reported is null', _rtLatest(t, 'Inventory'), null);
  }

  // ── the headline ratios ──
  {
    const t = mk({ '2025-03-31': {
      TotalRevenue: 1000, CostOfRevenue: 600, GrossProfit: 400, OperatingIncome: 200,
      EBIT: 200, EBITDA: 260, PretaxIncome: 180, TaxProvision: 45, NetIncome: 135,
      TotalAssets: 2000, CurrentAssets: 800, CurrentLiabilities: 400, Inventory: 300,
      AccountsReceivable: 200, StockholdersEquity: 900, LongTermDebt: 500, TotalDebt: 600,
      CashAndCashEquivalents: 100, InterestExpense: 40, InvestedCapital: 1000,
      OperatingCashFlow: 180, CapitalExpenditure: -60, DilutedEPS: 13.5, OrdinarySharesNumber: 10,
    }, '2024-03-31': {
      TotalRevenue: 800, NetIncome: 100, DilutedEPS: 10,
    }});
    const r = computeRatios(t, null, 270);

    eq('gross margin', +r.grossMargin.toFixed(2), 40);
    eq('operating margin', +r.opMargin.toFixed(2), 20);
    eq('net margin', +r.netMargin.toFixed(2), 13.5);
    eq('ROE', +r.roe.toFixed(2), 15);
    eq('ROA', +r.roa.toFixed(2), 6.75);
    // ROCE = EBIT / (total assets - current liabilities) = 200 / 1600
    eq('ROCE uses capital employed, not equity', +r.roce.toFixed(2), 12.5);
    // ROIC = EBIT x (1 - 45/180) / invested capital = 200 x 0.75 / 1000
    eq('ROIC is after tax', +r.roic.toFixed(2), 15);
    eq('revenue growth', +r.revGrowth.toFixed(2), 25);
    eq('net income growth', +r.niGrowth.toFixed(2), 35);
    eq('EPS growth', +r.epsGrowth.toFixed(2), 35);
    eq('debt to equity uses total debt when present', +r.debtToEquity.toFixed(4), 0.6667);
    // net debt = 600 - 100 = 500, over EBITDA 260
    eq('net debt to EBITDA', +r.netDebtEbitda.toFixed(4), 1.9231);
    eq('interest coverage', +r.interestCover.toFixed(2), 5);
    eq('current ratio', +r.currentRatio.toFixed(2), 2);
    eq('quick ratio strips inventory', +r.quickRatio.toFixed(2), 1.25);
    eq('asset turnover', +r.assetTurnover.toFixed(2), 0.5);
    eq('inventory turnover', +r.invTurnover.toFixed(2), 2);
    eq('receivable days', Math.round(r.receivableDays), 73);
    // capex is negative, so FCF is OCF plus it
    eq('free cash flow nets capex', r.fcf, 120);
    eq('FCF margin', +r.fcfMargin.toFixed(2), 12);
    eq('cash conversion', +r.cashConversion.toFixed(4), 1.3333);
    eq('P/E from price and reported EPS', +r.pe.toFixed(2), 20);
    eq('earnings yield inverts P/E', +r.earningsYield.toFixed(2), 5);
    // PEG = P/E 20 / EPS growth 35
    eq('PEG divides P/E by the growth being paid for', +r.peg.toFixed(4), 0.5714);
  }

  // ── the refusals: every one of these must decline rather than invent ──
  {
    const empty = computeRatios(mk({ '2025-03-31': { TotalRevenue: 1000 } }), null, null);
    for(const k of ['roce','roic','currentRatio','quickRatio','interestCover','invTurnover',
                    'netDebtEbitda','pe','peg','pb','evEbitda','cashConversion','epsGrowth'])
      eq('with no inputs, ' + k + ' is null not a number', empty[k], null);
  }
  {
    // Capital employed at or below zero cannot produce a return on it.
    const t = mk({ '2025-03-31': { EBIT: 100, TotalAssets: 400, CurrentLiabilities: 400 } });
    eq('zero capital employed yields no ROCE', computeRatios(t, null, null).roce, null);
    // Negative capital employed is the dangerous one: a profitable company
    // would show a NEGATIVE return on capital and read as loss-making.
    const neg = mk({ '2025-03-31': { EBIT: 100, TotalAssets: 300, CurrentLiabilities: 500 } });
    eq('negative capital employed yields no ROCE either', computeRatios(neg, null, null).roce, null);
  }
  {
    // An effective tax rate outside a sane band means the inputs disagree;
    // scaling EBIT by it would produce a confident but wrong ROIC.
    const t = mk({ '2025-03-31': { EBIT: 100, PretaxIncome: 100, TaxProvision: 95, InvestedCapital: 500 } });
    eq('an implausible tax rate withholds ROIC', computeRatios(t, null, null).roic, null);
  }
  {
    // Cash conversion against a loss flips sign and reads as a healthy ratio.
    const t = mk({ '2025-03-31': { NetIncome: -100, OperatingCashFlow: -150 } });
    eq('cash conversion is withheld against a loss', computeRatios(t, null, null).cashConversion, null);
  }
  {
    // A negative PEG is not "cheap". It must be withheld and flagged, never
    // shown as the best number on the page.
    const t = mk({ '2025-03-31': { NetIncome: 50, DilutedEPS: 5 }, '2024-03-31': { NetIncome: 80, DilutedEPS: 8 } });
    const r = computeRatios(t, { pe: 20 }, null);
    eq('PEG on shrinking earnings is withheld', r.peg, null);
    eq('and the reason is recorded for the UI', r.pegBlocked, true);
  }
  {
    // Falling back to LongTermDebt when TotalDebt is absent is a substitution
    // of a like-for-like line, not an estimate.
    const t = mk({ '2025-03-31': { LongTermDebt: 300, StockholdersEquity: 600 } });
    eq('debt to equity falls back to long-term debt', +computeRatios(t, null, null).debtToEquity.toFixed(2), 0.5);
  }
  {
    // The feed's own figure wins over a derived one when both exist.
    const t = mk({ '2025-03-31': { NetIncome: 100, DilutedEPS: 10 } });
    eq('a feed P/E is preferred to a derived one', computeRatios(t, { pe: 33 }, 200).pe, 33);
  }
  {
    // Reported free cash flow beats OCF + capex.
    const t = mk({ '2025-03-31': { FreeCashFlow: 90, OperatingCashFlow: 180, CapitalExpenditure: -60 } });
    eq('reported free cash flow is used as reported', computeRatios(t, null, null).fcf, 90);
  }

  // ── EPS and PEG ──
  {
    // EPS is net profit over shares outstanding. A source that reports both but
    // carries no EPS line must still yield an EPS - and therefore an EPS growth
    // rate, and therefore a PEG.
    const t = mk({ '2025-03-31': { NetIncome: 1000, OrdinarySharesNumber: 100 },
                   '2024-03-31': { NetIncome: 800,  OrdinarySharesNumber: 100 } });
    const r = computeRatios(t, { pe: 20 }, 200);
    eq('EPS is derived from net profit and share count', r.eps, 10);
    eq('and price divided by it equals the P/E shown', +(200 / r.eps).toFixed(2), +r.pe.toFixed(2));
    eq('and gives an EPS growth rate', fx(r.epsGrowth, 2), 25);
    eq('which PEG is computed against', fx(r.peg, 2), 0.8);
    eq('and the panel says which growth it used', r.pegBasis, 'annual EPS growth');
  }
  {
    // A reported diluted EPS wins over the derived one: it accounts for
    // dilution the raw share count does not.
    const t = mk({ '2025-03-31': { DilutedEPS: 9, NetIncome: 1000, OrdinarySharesNumber: 100 } });
    eq('a reported diluted EPS is preferred', computeRatios(t, null, null).eps, 9);
  }
  {
    // Shares reported as zero cannot produce an EPS.
    const t = mk({ '2025-03-31': { NetIncome: 1000, OrdinarySharesNumber: 0 } });
    eq('a zero share count yields no EPS, not Infinity', computeRatios(t, null, null).eps, null);
  }
  {
    // The regression this fixes. The feed's earningsGrowth is a quarterly
    // year-on-year figure and is often negative for a company whose ANNUAL
    // earnings grew. Taking it unconditionally withheld PEG on the weaker
    // measure while a healthy annual EPS growth sat unused.
    const t = mk({ '2025-03-31': { DilutedEPS: 12 }, '2024-03-31': { DilutedEPS: 10 } });
    const r = computeRatios(t, { pe: 30, earnGrowth: -8 }, null);
    eq('annual EPS growth is preferred over a negative feed figure', fx(r.peg, 2), 1.5);
    eq('and the basis is named', r.pegBasis, 'annual EPS growth');
    ok('PEG is not blocked just because the feed figure was negative', !r.pegBlocked, 'blocked');
  }
  {
    // With no EPS series, the feed's figure is used rather than nothing.
    const t = mk({ '2025-03-31': { TotalRevenue: 100 } });
    const r = computeRatios(t, { pe: 24, earnGrowth: 12 }, null);
    eq('the feed growth is used when no EPS series exists', fx(r.peg, 2), 2);
    eq('and is named as such', r.pegBasis, 'the feed’s earnings growth (one quarter)');
  }
  {
    // Net income growth is the last resort - it ignores dilution, so it is
    // used only when nothing better was reported.
    const t = mk({ '2025-03-31': { NetIncome: 110 }, '2024-03-31': { NetIncome: 100 } });
    const r = computeRatios(t, { pe: 20 }, null);
    eq('net income growth is the fallback', fx(r.peg, 2), 2);
    eq('and is named honestly', r.pegBasis, 'net income growth');
  }
  {
    // Every measure available and none positive: that is a verdict, and the
    // panel says so.
    const t = mk({ '2025-03-31': { DilutedEPS: 8, NetIncome: 80 },
                   '2024-03-31': { DilutedEPS: 10, NetIncome: 100 } });
    const r = computeRatios(t, { pe: 20, earnGrowth: -5 }, null);
    eq('PEG on shrinking earnings stays withheld', r.peg, null);
    eq('and the reason is recorded', r.pegBlocked, true);
  }
  {
    // No growth measured at all is NOT the same claim. A dash, not a verdict.
    const t = mk({ '2025-03-31': { NetIncome: 100 } });
    const r = computeRatios(t, { pe: 20 }, null);
    eq('unmeasured growth leaves PEG null', r.peg, null);
    ok('but is not reported as shrinking earnings', !r.pegBlocked, 'claims a verdict it cannot support');
    eq('and names no basis', r.pegBasis, null);
  }
  // ── a withheld PEG must show its working ──
  {
    // Every measured growth rate is exposed, so a dash can be argued with.
    const t = mk({ '2025-03-31': { DilutedEPS: 8, NetIncome: 80 },
                   '2024-03-31': { DilutedEPS: 10, NetIncome: 100 } });
    const r = computeRatios(t, { pe: 20, earnGrowth: -5 }, null);
    // Read through a guard: a regression that empties this must fail the
    // assertion, not throw and take every later test down with it.
    const g0 = (r.pegGrowths && r.pegGrowths[0]) || {};
    eq('all three measures are reported back', (r.pegGrowths || []).length, 3);
    eq('the annual EPS figure is among them', fx(g0.value, 1), -20);
    eq('and carries the periods it spans', g0.span || null, '2024-03-31 → 2025-03-31');
    eq('the blocking measure is named', (r.pegBlockedBy || {}).label || null, 'annual EPS growth');
    eq('and it is an annual one, so the verdict stands', r.pegBlockedOnAnnual, true);
  }
  {
    // The distinction that matters: the feed's earningsGrowth is ONE quarter
    // against the same quarter a year earlier. A weak quarter is not evidence
    // that a company has stopped growing, so PEG is withheld without the app
    // asserting the stronger claim.
    const t = mk({ '2025-03-31': { TotalRevenue: 100 } });   // no annual measure at all
    const r = computeRatios(t, { pe: 20, earnGrowth: -8 }, null);
    eq('PEG is still withheld', r.peg, null);
    eq('and the block is recorded', r.pegBlocked, true);
    eq('but it is NOT presented as an annual verdict', r.pegBlockedOnAnnual, false);
    eq('the quarterly figure is named as the reason', (r.pegBlockedBy || {}).label || null, 'the feed’s earnings growth (one quarter)');
  }
  {
    // An annual measure that is negative outranks a positive-looking quarter
    // for the purposes of the verdict...
    const t = mk({ '2025-03-31': { NetIncome: 80 }, '2024-03-31': { NetIncome: 100 } });
    const r = computeRatios(t, { pe: 20, earnGrowth: -3 }, null);
    eq('the annual measure is what the verdict rests on', (r.pegBlockedBy || {}).label || null, 'net income growth');
    eq('and is marked as annual', r.pegBlockedOnAnnual, true);
  }
  {
    // A positive annual measure produces a PEG even when the quarter was poor.
    // This is the bug that hid PEG in the first place.
    const t = mk({ '2025-03-31': { DilutedEPS: 12 }, '2024-03-31': { DilutedEPS: 10 } });
    const r = computeRatios(t, { pe: 30, earnGrowth: -8 }, null);
    eq('PEG computes on the annual figure', fx(r.peg, 2), 1.5);
    eq('and reports the span it used', r.pegSpan, '2024-03-31 → 2025-03-31');
    eq('nothing is blocked', r.pegBlocked, false);
  }
  {
    // The dangerous direction, and the reason the rule changed. Axis Bank showed
    // annual EPS -6.3% and annual net income -6.0%, while the feed's single
    // quarter was strongly positive - and the panel published PEG 0.66 in green,
    // calling a company whose yearly earnings fell "cheap against growth".
    // An annual measure decides, whichever way it points.
    const t = mk({ '2025-03-31': { DilutedEPS: 9.37, NetIncome: 94 },
                   '2024-03-31': { DilutedEPS: 10.0, NetIncome: 100 } });
    const r = computeRatios(t, { pe: 14.3, earnGrowth: 21.7 }, null);
    eq('a strong quarter cannot override a negative year', r.peg, null);
    eq('the annual measure is what withheld it', (r.pegBlockedBy || {}).label || null, 'annual EPS growth');
    eq('and the verdict is an annual one', r.pegBlockedOnAnnual, true);
    // The quarterly figure is still shown, so the reader sees both.
    ok('the quarter is still reported for context',
       (r.pegGrowths || []).some(g => /one quarter/.test(g.label)), 'quarter hidden');
  }
  {
    // Net income growth stands in when no EPS series exists...
    const t = mk({ '2025-03-31': { NetIncome: 110 }, '2024-03-31': { NetIncome: 100 } });
    eq('net income growth is used when EPS is unavailable',
       fx(computeRatios(t, { pe: 20, earnGrowth: -50 }, null).peg, 2), 2);
  }
  {
    // ...but EPS outranks it when both exist, because it accounts for dilution.
    const t = mk({ '2025-03-31': { DilutedEPS: 10.2, NetIncome: 200 },
                   '2024-03-31': { DilutedEPS: 10.0, NetIncome: 100 } });
    const r = computeRatios(t, { pe: 20 }, null);
    eq('EPS growth outranks net income growth', r.pegBasis, 'annual EPS growth');
    eq('so dilution is not priced away', fx(r.peg, 1), 10);
  }
  {
    // Growth is measured between the two periods the series actually has. If
    // the source skipped a year, the span says so rather than presenting a
    // two-year change as an annual rate.
    const t = mk({ '2026-03-31': { NetIncome: 120 }, '2024-03-31': { NetIncome: 100 } });
    const r = computeRatios(t, null, null);
    eq('the gap is visible in the span', r.niSpan, '2024-03-31 → 2026-03-31');
  }

  ok('EPS is shown so the PEG inputs are visible', /'EPS',\s+'eps'/.test(SRC), 'EPS row missing');
  ok('a computed PEG states which growth it used', /vs \$\{r\.pegBasis\}/.test(SRC), 'basis not shown');

  // ── bands ──
  eq('a high ROCE bands good', ratioBand('roce', 22), 'good');
  eq('a middling ROCE bands fair', ratioBand('roce', 14), 'fair');
  eq('a low ROCE bands weak', ratioBand('roce', 4), 'weak');
  // Lower is better for these, so the comparison must invert.
  eq('low debt bands good', ratioBand('debtToEquity', 0.3), 'good');
  eq('high debt bands weak', ratioBand('debtToEquity', 2), 'weak');
  eq('a PEG under 1 bands good', ratioBand('peg', 0.8), 'good');
  eq('a null value has no band', ratioBand('roce', null), null);
  eq('a ratio with no defensible threshold is unbanded', ratioBand('receivableDays', 40), null);

  // ── lender-appropriate bands ──
  // A band is a claim about whether a number is good. Using a manufacturer's
  // threshold on a bank is a wrong answer, not an imprecise one.
  eq('1.4% ROA is weak for a manufacturer', ratioBand('roa', 1.4, false), 'weak');
  eq('but fair for a bank', ratioBand('roa', 1.4, true), 'fair');
  eq('1.8% ROA is good for a bank', ratioBand('roa', 1.8, true), 'good');
  eq('0.6% ROA is weak even for a bank', ratioBand('roa', 0.6, true), 'weak');
  // Values chosen to sit on opposite sides of the two tables; a value banding
  // the same either way would assert nothing.
  eq('11% ROE is weak for a manufacturer', ratioBand('roe', 11, false), 'weak');
  eq('but fair for a bank', ratioBand('roe', 11, true), 'fair');
  eq('16% ROE is only fair for a manufacturer', ratioBand('roe', 16, false), 'fair');
  eq('but good for a bank', ratioBand('roe', 16, true), 'good');
  // Ratios with no lender-specific table fall through to the general one.
  eq('an unbanded-for-lenders ratio keeps the general band', ratioBand('netMargin', 30, true), 'good');
  // Cash flow measures describe a manufacturer's earnings quality. A bank with
  // negative operating cash flow has usually grown its loan book.
  ok('FCF margin is not applied to lenders', RT_LENDER_NA.indexOf('fcfMargin') >= 0, 'still applied');
  ok('nor is cash conversion', RT_LENDER_NA.indexOf('cashConversion') >= 0, 'still applied');
  ok('nor receivable days', RT_LENDER_NA.indexOf('receivableDays') >= 0, 'still applied');
  ok('the panel passes the lender flag when banding', /ratioBand\(key, v, lender\)/.test(SRC), 'lender bands never apply');
  ok('and the insight payload bands the same way', /ratioBand\(k, r\[k\], lender\)/.test(SRC), 'narrative can disagree with the table');

  // ── lenders ──
  ok('a bank is recognised', isLender({ sector: 'Financial Services' }), 'not detected');
  ok('an insurer is recognised', isLender({ industry: 'Insurance - Life' }), 'not detected');
  ok('a manufacturer is not', !isLender({ sector: 'Consumer Cyclical' }), 'false positive');
  ok('no sector is not a lender', !isLender(null), 'null treated as lender');
  ok('the ratios suppressed for lenders include the current ratio', RT_LENDER_NA.indexOf('currentRatio') >= 0, 'not suppressed');
  ok('and inventory turnover', RT_LENDER_NA.indexOf('invTurnover') >= 0, 'not suppressed');

  // ── wiring & honesty ──
  // ── a share count that fails its own cross-check ──
  // Cupid Ltd, from the live feed: 134.47 crore shares reported, which at ₹280.46
  // implies a market value of ~₹37,700 Cr for a company with ₹451 Cr of equity
  // and ₹351 Cr of revenue. EPS came out 0.79 and P/E 277, while net margin and
  // ROE were correct to the decimal because they never divide by the share count.
  {
    const CUPID = mk({ '2026-03-31': {
      NetIncome: 1.082333e9, TotalRevenue: 3.509897e9, StockholdersEquity: 4.508058e9,
      OrdinarySharesNumber: 1.3446607e9, DilutedEPS: 0.79, TotalAssets: 5.532242e9,
    }});
    const PRICE = 280.46;
    {
      // Feed market cap ~₹757 Cr; price x shares says ₹37,712 Cr. They describe
      // the same quantity, so one of them is wrong.
      const r = computeRatios(CUPID, { mktCap: 7.572e9 }, PRICE);
      // Read through a guard: a regression that stops detecting must fail the
      // assertion, not throw and take the rest of the group with it.
      const sc = r.shareCountSuspect || {};
      ok('the disagreement is detected', !!r.shareCountSuspect, 'not detected');
      eq('and the factor is recorded', sc.factor == null ? null : Math.round(sc.factor), 50);
      eq('along with the share count it doubted', sc.shares == null ? null : sc.shares, 1.3446607e9);
      // The figures that do not divide by the share count must be untouched.
      eq('net margin is unaffected and correct', fx(r.netMargin, 1), 30.8);
      eq('ROE is unaffected and correct', fx(r.roe, 1), 24.0);
    }
    {
      // A consistent feed raises no flag.
      const r = computeRatios(CUPID, { mktCap: PRICE * 1.3446607e9 }, PRICE);
      ok('a consistent share count is not flagged', !r.shareCountSuspect, JSON.stringify(r.shareCountSuspect));
    }
    {
      // Within the tolerance band: prices move between the two snapshots, so a
      // modest difference is normal and must not cry wolf.
      const r = computeRatios(CUPID, { mktCap: PRICE * 1.3446607e9 * 1.4 }, PRICE);
      ok('a modest difference is tolerated', !r.shareCountSuspect, 'false positive at 1.4x');
    }
    {
      // No market cap to check against: nothing is claimed either way.
      const r = computeRatios(CUPID, {}, PRICE);
      ok('with nothing to cross-check, no accusation is made', !r.shareCountSuspect, 'flagged blindly');
    }
    {
      // The rating is withheld on the affected ratios, and only those. The
      // display half lives past this group's slice, so it is loaded here.
      const disp = load(slice('const RT_EPS = 1e-9;', '\n// ── UI ──', 'scui'),
        ['ratiosHtml'], { Math, Object, Array, JSON, isFinite, Number, String, encodeURIComponent,
          document: { createElement: () => ({}), head: { appendChild(){} } },
          AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error('none'); },
          localStorage: { getItem: () => null, setItem(){}, removeItem(){} } });
      const html = disp.ratiosHtml(CUPID, { mktCap: 7.572e9, pe: 277.2 }, PRICE);
      ok('the panel warns before the figures', /per-share figures below are not trustworthy/.test(html), 'no warning');
      ok('it shows the two market values that disagree', /37,712 Cr/.test(html) && /757 Cr/.test(html), html.slice(0,300));
      ok('it names which ratios inherit the error', /EPS, P\/E, PEG, P\/B, P\/S and the yields/.test(html), 'not named');
      ok('and which ones do not', /never touch the share count/.test(html), 'no all-clear');
      // Over-escaping here made every cell lookup return '', so the three
      // assertions below passed against an empty string rather than the markup.
      const cell = k => {
        const m = html.match(new RegExp('>' + k + '</th>\\s*<td class="(rt-val[^"]*)"'));
        ok('the ' + k + ' cell was actually found', !!m, 'cell lookup matched nothing');
        return m ? m[1] : '';
      };
      ok('earnings yield loses its rating', !/rt-(good|fair|weak)/.test(cell('Earnings yield')),
         cell('Earnings yield'));
      ok('and so does PEG', !/rt-(good|fair|weak)/.test(cell('PEG')), cell('PEG'));
      ok('but ROE keeps its rating', /rt-(good|fair|weak)/.test(cell('ROE')), cell('ROE'));
      ok('and net margin keeps its rating', /rt-(good|fair|weak)/.test(cell('Net margin')), cell('Net margin'));
      ok('and the cells say why', /share count unverified/.test(html), 'no per-cell note');
    }
  }

  // ── rendered output, not source text ──
  // Asserting that a string appears in the file only proves the string is in
  // the file. These render the panel and read the cell that comes out.
  {
    const rsrc = slice('const RT_EPS = 1e-9;', '\n// ── UI ──', 'ratiosrender');
    const { ratiosHtml } = load(rsrc, ['ratiosHtml'],
      { Math, Object, Array, JSON, isFinite, Number, String, encodeURIComponent,
        document: { createElement: () => ({}), head: { appendChild(){} } },
        AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error('none'); },
        localStorage: { getItem: () => null, setItem(){}, removeItem(){} } });
    const st = (byDate) => {
      const line = {}, dates = Object.keys(byDate).sort().reverse();
      for(const d of dates) for(const k of Object.keys(byDate[d])) (line[k] || (line[k] = {}))[d] = byDate[d][k];
      return { line, periodsAll: dates };
    };
    const pegCell = html => {
      const m = html.match(/>PEG<\/th>\s*<td class="rt-val[^"]*">([\s\S]*?)<\/tr>/);
      return m ? m[1] : '';
    };
    {
      // Earnings shrank: the cell must carry a marker and the figure, never a
      // blank and never a bare "not reported" (the source reported it fine).
      const t = st({ '2025-03-31': { DilutedEPS: 8 }, '2024-03-31': { DilutedEPS: 10 } });
      const cell = pegCell(ratiosHtml(t, { pe: 20 }, null));
      ok('a withheld PEG renders a marker, not an empty cell', /n\/m/.test(cell), cell);
      ok('and states the growth that withheld it', /growth -20\.0%/.test(cell), cell);
      ok('and names the measure', /annual EPS growth/.test(cell), cell);
      ok('it is not mislabelled as unreported', !/n\/r/.test(cell), cell);
    }
    {
      // Nothing reported at all: that IS "not reported", and says so.
      const cell = pegCell(ratiosHtml(st({ '2025-03-31': { TotalRevenue: 5 } }), null, null));
      ok('an unmeasurable PEG renders as not-reported', /n\/r/.test(cell), cell);
      ok('and claims no growth figure it does not have', !/growth [-+]/.test(cell), cell);
    }
    {
      // A computed PEG shows its basis and the periods it spans.
      const t = st({ '2025-03-31': { DilutedEPS: 12 }, '2024-03-31': { DilutedEPS: 10 } });
      const cell = pegCell(ratiosHtml(t, { pe: 30 }, null));
      ok('a computed PEG shows the number', /1\.50/.test(cell), cell);
      ok('and the basis it used', /vs annual EPS growth/.test(cell), cell);
      ok('and the periods it spans', /2024-03-31 → 2025-03-31/.test(cell), cell);
    }
    {
      // The same-period rule, end to end: net income from 2026 must not be
      // divided by a balance sheet from 2019. That produced a 112% ROA.
      const t = st({ '2026-03-31': { NetIncome: 1000, TotalRevenue: 5000 },
                     '2019-03-31': { NetIncome: 40, TotalAssets: 900 } });
      const html = ratiosHtml(t, null, null);
      const roa = (html.match(/>ROA<\/th>\s*<td class="rt-val[^"]*">([\s\S]*?)<\/tr>/) || [])[1] || '';
      ok('ROA uses the period where both lines exist, not the newest of each',
         /4\.4%/.test(roa), roa);
      ok('so it is not an impossible number', !/1[01]\d\.\d%/.test(roa), roa);
    }
  }
  // The reading starts on its own; the button is a re-run, not the way in.
  ok('the built-in reading starts without being asked',
     /if\(typeof insRunBuiltin === 'function'\) insRunBuiltin\(\);/.test(SRC), 'still needs a click');
  ok('and the button is offered as a repeat', /↻ Run again/.test(SRC), 'button is still the entry point');
  ok('no "Read the numbers" call to action remains', !/Read the numbers/.test(SRC), 'stale call to action');

  ok('the ratio panel is rendered into the Financials tab', /ratiosHtml\(t, ar\.fundamentals, price\)/.test(SRC), 'not wired');
  ok('ROCE is shown', /'ROCE',\s+'roce'/.test(SRC), 'no ROCE row');
  ok('PEG is shown', /'PEG',\s+'peg'/.test(SRC), 'no PEG row');
  ok('a withheld PEG names the figure that withheld it', /growth \$\{fig\}/.test(SRC), 'silent');
  // A blank cell reads as a fault. A withheld ratio carries a marker.
  ok('and the cell carries a marker rather than a blank', />n\/m<\/span>/.test(SRC), 'blank cell');
  ok('n\/m is distinguished from n\/a in the tooltip', /Not meaningful: PEG divides/.test(SRC), 'markers conflated');
  ok('and every measured growth rate is inspectable in the tooltip', /Growth measured: /.test(SRC), 'not inspectable');
  ok('the UI states n/r means missing inputs, not an estimate', /the ratio is not shown rather than estimated/.test(SRC), 'ambiguous marker');
  ok('the UI warns bank ratios differ', /deposits are raw material/.test(SRC), 'no lender warning');
  ok('the UI says the bands are rules of thumb', /broad rules of thumb/.test(SRC), 'bands look authoritative');
  ok('the UI states the maths runs locally', /nothing is sent anywhere/.test(SRC), 'no locality claim');
  // Numbers are the content: they must be bold and tabular so columns align.
  ok('figures are bold', /\.rt-val\{[^}]*font-weight:800/.test(SRC), 'values not bold');
  ok('and tabular, so digits line up', /\.rt-val\{[^}]*tabular-nums/.test(SRC), 'not tabular');
  ok('statement figures are bold too', /\.fin-table tbody td\{[^}]*font-weight:700/.test(SRC), 'statement values not bold');
  ok('statement figures are tabular', /\.fin-table tbody td\{[^}]*tabular-nums/.test(SRC), 'not tabular');
  // Calibri only exists on Windows; without a metric-compatible fallback the
  // app silently renders in a generic face everywhere else.
  ok('the font stack names Calibri first', /--font: 'Calibri'/.test(SRC), 'Calibri not primary');
  ok('and falls back to a metric-compatible face', /'Carlito'/.test(SRC), 'no metric fallback');
  ok('no bare Calibri declaration is left behind', !/'Calibri',sans-serif/.test(SRC), 'stale font declaration');
  // The Calibri chain is resolved from fonts already on the machine. Fetching
  // it would add a request that can fail exactly when the app is offline - and
  // Carlito is already installed on most Linux systems that lack Calibri.
  ok('the Calibri stack pulls no webfont of its own', !/family=(Calibri|Carlito)/.test(SRC), 'font fetched over the network');

  // ── the panel must survive the stylesheet it lives in ──
  // These are regressions, not hypotheticals: the ratio panel first shipped
  // with every value blank because the global table rules below reached into
  // it. Each assertion is paired with the global rule it has to beat, so if
  // that rule is ever removed the pairing is what tells us the override can go.
  {
    const globalMin = /\btable\{[^}]*min-width:800px/.test(SRC);
    ok('the wide-grid global table rule is still present', globalMin, 'global rule gone - the override below may be stale');
    // Inherited into a ~440px card with clipped overflow, an 800px minimum
    // pushes the whole value column out of sight: labels render, numbers vanish.
    ok('the ratio table overrides it so values are not pushed out of the card',
       /\.rt-table\{[^}]*min-width:0/.test(SRC), 'ratio values will be clipped out of view');
    ok('the statement table sets its own width too',
       /\.fin-table\{[^}]*min-width:520px/.test(SRC), 'statement table inherits 800px');
  }
  {
    const globalUpper = /\bth\{[^}]*text-transform:uppercase/.test(SRC);
    ok('the global th rule still uppercases', globalUpper, 'global rule gone - the override below may be stale');
    ok('ratio labels opt out, so they read as written',
       /\.rt-lbl\{[^}]*text-transform:none/.test(SRC), 'labels render shouting');
    ok('statement line items opt out too',
       /\.fin-table tbody th\{[^}]*text-transform:none/.test(SRC), 'line items render shouting');
  }
  {
    // Whatever the CSS does, every row must actually carry a value cell with
    // something in it - a dash at minimum. A blank cell is never correct.
    const dsrc = slice('const RT_DASH =', '\n// ══', 'ratiosui');
    const ui = load(src + '\n' + dsrc,
      ['ratiosHtml'], { Math, Object, Array, isFinite, Number });
    const t = { line: { TotalRevenue: { '2025-03-31': 1000 } }, periodsAll: ['2025-03-31'] };
    for(const [label, fund, price] of [['no data at all', null, null],
                                        ['a lender', { sector: 'Financial Services' }, 100]]) {
      const html = ui.ratiosHtml(t, fund, price);
      const cells = html.match(/<td class="rt-val[^"]*">(.*?)<\/td>/g) || [];
      ok('rows are rendered for ' + label, cells.length >= 20, 'only ' + cells.length + ' rows');
      const blank = cells.filter(c => /">\s*<\/td>$/.test(c));
      eq('no value cell is blank for ' + label, blank.length, 0);
    }
  }
}


// ── Valuation feed: quoteSummary through the Worker ────────────────────────
group('valuation feed');
{
  // The entire Valuation card (P/E, PEG, P/B, P/S, EV/EBITDA, yields) and the
  // sector that decides whether bank ratios are marked n/a all come from
  // quoteSummary. It needs Yahoo's cookie+crumb, which only a server can get,
  // so routing it through the public relays could never have worked.
  const wsrc = require('fs').readFileSync(require('path').join(__dirname,'..','proxy','worker.js'),'utf8');
  ok('the Worker exposes a quoteSummary route', /params\.get\('quotesummary'\)/.test(wsrc), 'no route');
  ok('it does the crumb handshake for it', /_yahooAuth\(\)[\s\S]{0,300}quoteSummary/.test(wsrc), 'unauthenticated');
  ok('it validates the symbol', /quotesummary'\)[\s\S]{0,200}\[A-Za-z0-9\.\\-\^\]\{1,20\}/.test(wsrc), 'symbol not validated');
  // Modules must not be a pass-through: the Worker is not an open proxy, and a
  // free-text parameter forwarded to Yahoo would make it one.
  ok('it validates the module list rather than forwarding it',
     /\^\[A-Za-z\]\{1,40\}\(,\[A-Za-z\]\{1,40\}\)\{0,9\}\$/.test(wsrc), 'modules passed through raw');
  {
    const re = new RegExp("\\^\\[A-Za-z\\]\\{1,40\\}(?:\\(,\\[A-Za-z\\]\\{1,40\\}\\)\\{0,9\\})\\$");
    const m = wsrc.match(/if \(!\/(\^\[A-Za-z\][^/]*)\/\.test\(mods\)\)/);
    ok('the module pattern is anchored at both ends', !!m && m[1].startsWith('^') && m[1].endsWith('$'), 'unanchored');
    if(m){
      const rx = new RegExp(m[1]);
      ok('a normal module list passes', rx.test('summaryDetail,defaultKeyStatistics,financialData,assetProfile'), 'rejected');
      ok('a URL smuggled in is refused', !rx.test('summaryDetail&url=https://evil.test'), 'accepted a URL');
      ok('a path traversal attempt is refused', !rx.test('../../etc/passwd'), 'accepted traversal');
      ok('an empty list is refused', !rx.test(''), 'accepted empty');
    }
  }
  // The app must reach for the Worker before the public relays, not after.
  ok('the app tries the Worker for quoteSummary', /\$\{_sp\}\/\?quotesummary=\$\{enc\(ySym\)\}/.test(SRC), 'Worker not used');
  {
    const i = SRC.indexOf('quotesummary=${enc(ySym)}');
    const j = SRC.indexOf("'https://corsproxy.io/?url='+enc(yUrl)");
    ok('and tries it first, ahead of the public relays', i > 0 && j > 0 && i < j, 'Worker is not first');
  }
  ok('with no Worker configured the relays are still tried', /\.\.\.\(_sp \? \[/.test(SRC), 'hard dependency on the Worker');
}

// ── Insights: Python bridge + AI provider layer ────────────────────────────
group('insights');
{
  // Load the real ratio engine alongside, rather than stubbing it. A stub here
  // would only prove the test agrees with itself - the point is that the
  // payload carries what computeRatios actually produced.
  const src = slice('const RT_EPS = 1e-9;', '\n// ── UI ──', 'ins');
  const { AI_PROVIDERS, insightPayload, aiPrompt, aiExtractText, aiRender } =
    load(src, ['AI_PROVIDERS','insightPayload','aiPrompt','aiExtractText','aiRender'],
    { Math, Object, Array, JSON, isFinite, Number, String, encodeURIComponent,
      document: { createElement: () => ({}), head: { appendChild(){} } },
      AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error('no network in tests'); },
      localStorage: (() => { const st = {}; return {
        getItem: k => (k in st ? st[k] : null), setItem: (k,v) => { st[k] = String(v); },
        removeItem: k => { delete st[k]; } }; })(),
    });
  const stmt = (byDate) => {
    const line = {}, dates = Object.keys(byDate).sort().reverse();
    for(const d of dates) for(const k of Object.keys(byDate[d])) (line[k] || (line[k] = {}))[d] = byDate[d][k];
    return { line, periodsAll: dates };
  };
  const REAL = stmt({ '2025-03-31': { EBIT: 400, TotalAssets: 2000, CurrentLiabilities: 400,
                                      TotalRevenue: 1000, NetIncome: 150 } });

  // ── the embedded Python must be the file on disk, byte for byte ──
  {
    const fs = require('fs'), path = require('path');
    const mm = SRC.match(/const PY_INTERPRET = ("(?:[^"\\]|\\.)*");/);
    ok('the Python source is embedded in the page', !!mm, 'PY_INTERPRET missing');
    if(mm){
      const embedded = JSON.parse(mm[1]);
      const disk = fs.readFileSync(path.join(__dirname,'..','src','py','interpret.py'),'utf8').replace(/\r\n/g,'\n');
      // If these drift, the browser runs different Python from the one the
      // Python test suite proved correct.
      eq('and is identical to src/py/interpret.py', embedded, disk);
      ok('it defines the bridge the page calls', /def interpret_json\(/.test(embedded), 'no interpret_json');
      ok('it is embedded as JSON, so quotes cannot break out of the script',
         /const PY_INTERPRET = "/.test(SRC), 'not a JSON string literal');
    }
  }

  // ── what leaves the device ──
  {
    const p = insightPayload(REAL, { sector:'Technology' }, 100, 'TCS.NS');
    eq('the payload names the symbol', p.symbol, 'TCS.NS');
    eq('and the sector', p.sector, 'Technology');
    eq('a tech company is not flagged as a lender', p.lender, false);
    // ROCE = EBIT 400 / (assets 2000 - current liabilities 400) = 25%.
    eq('it carries the ratios computeRatios actually produced', +p.ratios.roce.toFixed(2), 25);
    eq('and the band that ratio fell into', p.bands.roce, 'good');
    eq('a ratio with no inputs is null, not absent from the payload', p.ratios.currentRatio, null);
    // This payload is the entire thing an external API can see. Anything about
    // the user's holdings appearing here would be a leak, not a feature.
    const flat = JSON.stringify(p).toLowerCase();
    for(const forbidden of ['holding','portfolio','quantity','apikey','api_key','token','password','email'])
      ok('the payload carries no ' + forbidden, flat.indexOf(forbidden) < 0, 'leaked: ' + forbidden);
    eq('the payload has exactly the expected top-level keys',
       Object.keys(p).sort().join(','), 'bands,depositRate,lender,ratios,sector,symbol');
  }
  {
    const p = insightPayload(REAL, { sector:'Financial Services' }, 100, 'HDFCBANK.NS');
    eq('a bank is flagged as a lender', p.lender, true);
    const prompt = aiPrompt(p);
    ok('and the prompt tells the model not to judge it on manufacturer ratios',
       /do not judge it on those/.test(prompt), 'lender caveat missing');
  }

  // ── the prompt ──
  {
    const prompt = aiPrompt({ symbol:'X', ratios:{ roce: 20, pegBlocked: false }, bands:{} });
    ok('it forbids buy/sell advice outright', /Do NOT give buy, sell or hold advice/.test(prompt), 'advice not forbidden');
    ok('it forbids a price target', /price target/.test(prompt), 'targets not forbidden');
    ok('it forbids inventing figures', /Never invent a figure not listed above/.test(prompt), 'invention not forbidden');
    ok('it asks for plain English', /Plain English/.test(prompt), 'jargon not discouraged');
    ok('booleans are not passed off as figures', !/pegBlocked/.test(prompt), 'flag sent as a number');
  }

  // ── provider responses ──
  eq('gemini text is extracted', aiExtractText('gemini',
     { candidates:[{ content:{ parts:[{ text:'hello ' },{ text:'world' }] } }] }), 'hello world');
  eq('anthropic text is extracted', aiExtractText('anthropic',
     { content:[{ type:'text', text:'hi' },{ type:'tool_use' }] }), 'hi');
  eq('openai text is extracted', aiExtractText('openai',
     { choices:[{ message:{ content:'hi' } }] }), 'hi');
  eq('an empty reply is null, not an empty panel', aiExtractText('openai',
     { choices:[{ message:{ content:'   ' } }] }), null);
  eq('a malformed reply is null', aiExtractText('gemini', {}), null);
  eq('a null reply is null', aiExtractText('gemini', null), null);

  // ── model output is untrusted ──
  {
    const html = aiRender('<img src=x onerror=alert(1)> **bold** & <b>tags</b>');
    ok('script-ish markup from the model is escaped', html.indexOf('<img') < 0, html);
    ok('so are raw tags', html.indexOf('<b>tags</b>') < 0, html);
    ok('ampersands are escaped', /&amp;/.test(html), html);
    ok('but its own bold markup is honoured', /<b>bold<\/b>/.test(html), html);
  }

  // ── provider config ──
  for(const k of Object.keys(AI_PROVIDERS)){
    const c = AI_PROVIDERS[k];
    ok(k + ' has a default model', !!c.model, 'no model');
    ok(k + ' says what it costs', !!c.cost, 'no cost note');
    ok(k + ' links its key page over https', /^https:\/\//.test(c.keyUrl), 'bad key url');
    ok(k + ' has step-by-step key instructions', Array.isArray(c.steps) && c.steps.length >= 3, 'too few steps');
  }
  ok('the free-tier option is named as such', /genuinely free tier/.test(SRC), 'free tier not identified');
  ok('the paid ones are not passed off as free', /Paid\. Needs credit/.test(SRC), 'cost not stated');

  // ── wiring & honesty ──
  ok('the built-in reading runs Python, not a JS rewrite of it',
     /py\.runPython\(PY_INTERPRET\)/.test(SRC), 'Python not executed');
  ok('the runtime is fetched only when asked for', /function _loadPyodide/.test(SRC) && !/loadPyodide\(\);\s*<\/script>/.test(SRC), 'eager load');
  ok('a failed load does not poison later attempts', /_pyPromise\.catch\(\(\) => \{ _pyPromise = null; \}\)/.test(SRC), 'permanent failure');
  ok('a Python failure says the tables are unaffected', /ratio tables above are unaffected/.test(SRC), 'implies total failure');
  ok('the AI path requires explicit consent', /if\(!consent \|\| !consent\.checked\)/.test(SRC), 'sends without consent');
  ok('and says plainly that data leaves the device', /sends the figures off your device/.test(SRC), 'consent not informed');
  ok('the key is described as local-only', /stored in this browser only/.test(SRC), 'key handling unstated');
  ok('the provider error is relayed verbatim, not flattened', /j\.error\.message \|\| j\.error\.status/.test(SRC), 'error swallowed');
  ok('AI output is labelled as possibly wrong', /can be confidently wrong/.test(SRC), 'model output presented as fact');
  ok('neither reading is presented as advice', /not advice, not a recommendation/.test(SRC), 'reads as advice');
  ok('Anthropic gets the header its API needs from a browser',
     /anthropic-dangerous-direct-browser-access/.test(SRC), 'call would be blocked by CORS');
  ok('requests cannot hang forever', /setTimeout\(\(\) => ctrl\.abort\(\), 60000\)/.test(SRC), 'no timeout');
}

// ── Numbers are readable ───────────────────────────────────────────────────
group('number formatting');
{
  const src = slice('function _finGroup(', '\n// ── The ratios', 'fmt');
  const { _finGroup, _finUnit, FIN_ABBR } =
    load(src, ['_finGroup','_finUnit','FIN_ABBR'], { Math, Object, isFinite, Number, RT_EPS: 1e-9 });
  // Indian grouping: 1,92,566 not 192,566. A statement read at a glance is
  // misread without it.
  eq('indian grouping is used for rupee figures', _finGroup(192566.78, 2, true), '1,92,566.78');
  eq('western grouping for dollar figures', _finGroup(192566.78, 2, false), '192,566.78');
  eq('zero decimals when asked', _finGroup(1234567, 0, true), '12,34,567');
  eq('a missing number formats to nothing', _finGroup(null, 2, true), '');
  eq('infinity formats to nothing', _finGroup(Infinity, 2, true), '');
  // Every short form carries its meaning; that is the point of the helper.
  for(const u of ['Cr','L','B','M','×']){
    ok(u + ' is explained on hover', /title="/.test(_finUnit(u)), 'no tooltip for ' + u);
    ok(u + ' is marked as explainable', /class="fin-abbr"/.test(_finUnit(u)), 'not marked');
  }
  eq('an unknown unit is passed through untouched', _finUnit('zz'), 'zz');
  ok('crore is spelled out in figures', /1,00,00,000/.test(FIN_ABBR['Cr']), 'crore not quantified');
  ok('lakh is spelled out in figures', /1,00,000/.test(FIN_ABBR['L']), 'lakh not quantified');
  ok('the multiplication sign is distinguished from a percentage',
     /not a percentage/.test(FIN_ABBR['×']), 'x could be read as %');
  ok('a legend explains the short forms in place', /Reading the short forms/.test(SRC), 'no legend');
  ok('the legend says what n/r means', /not reported by the data source/.test(SRC), 'n/r unexplained');
  ok('and what n/m means', /cannot be computed to anything meaningful/.test(SRC), 'n/m unexplained');
  ok('and what n\\/a means', /does not describe this kind of business/.test(SRC), 'n/a unexplained');
  ok('statement figures go through the grouping helper', /_finGroup\(n, dp, isIndia\)/.test(SRC), 'ungrouped');
}

// ── Combined read: technicals against fundamentals ─────────────────────────
group('combined read');
{
  const src = slice('const CR_BULL = 60', '\n// ── Report sections', 'combined');
  const { combinedRead } = load(src, ['combinedRead'], { Math, isFinite, Number, String });

  const T = (score, extra) => Object.assign({ verdict: score >= 60 ? 'BUY' : score <= 40 ? 'SELL' : 'HOLD', score }, extra || {});
  const F = (composite, extra) => composite == null ? null
    : Object.assign({ composite, grade: composite >= 65 ? 'B' : composite >= 50 ? 'C' : 'D', coverage: 1 }, extra || {});

  // ── the four quadrants ──
  eq('strong price and strong business is called aligned',
     combinedRead(T(75), F(80), null).stance, 'Aligned, constructive');
  eq('weak and weak is called aligned the other way',
     combinedRead(T(20), F(30), null).stance, 'Aligned, negative');
  eq('rising price on weak accounts is named as momentum',
     combinedRead(T(75), F(30), null).stance, 'Momentum ahead of the accounts');
  eq('falling price on strong accounts is named as the reverse',
     combinedRead(T(20), F(80), null).stance, 'Accounts ahead of the price');
  eq('neither emphatic is not forced into a verdict',
     combinedRead(T(50), F(52), null).stance, 'No clear agreement');

  // ── the honest refusals ──
  {
    // A technical-only reading is not a view on the company, and must not be
    // presented as one.
    const c = combinedRead(T(75), null, null);
    eq('with no fundamentals the reading is labelled technical only', c.stance, 'Technical only');
    ok('and says price alone cannot judge a business',
       /Price behaviour alone cannot tell you whether a company is sound/.test(c.limits.join(' ')),
       c.limits.join(' '));
    ok('it is not dressed up as a positive verdict', c.tone === 'info', c.tone);
  }
  {
    const c = combinedRead({}, F(80), null);
    eq('with no technicals it is labelled fundamental only', c.stance, 'Fundamental only');
    ok('and says nothing about timing', /cannot say anything about the moment/.test(c.detail), c.detail);
  }
  {
    const c = combinedRead({}, null, null);
    eq('with neither, it concludes nothing', c.stance, 'No reading');
    ok('and says so plainly', /nothing to conclude from/.test(c.detail), c.detail);
  }

  // ── caveats that change how much weight the reading carries ──
  {
    const c = combinedRead(T(75, { isChop: true }), F(80), null);
    ok('a sideways trend is flagged as weakening the technical half',
       /trend is sideways/.test(c.limits.join(' ')), c.limits.join(' '));
  }
  {
    const c = combinedRead(T(75), F(80, { coverage: 0.3 }), null);
    ok('thin fundamental coverage is disclosed',
       /less than half the inputs/.test(c.limits.join(' ')), c.limits.join(' '));
  }
  {
    const c = combinedRead(T(75), F(80, { coverage: 1 }), null);
    ok('full coverage raises no such caveat',
       !/less than half the inputs/.test(c.limits.join(' ')), c.limits.join(' '));
  }
  {
    const c = combinedRead(T(50), F(50), { pegBlocked: true });
    ok('a withheld PEG is explained rather than silently absent',
       /price-to-growth ratio against flat or falling earnings has no meaning/.test(c.limits.join(' ')),
       c.limits.join(' '));
  }

  // ── an unreliable half must not drive the conclusion ──
  // From the NHPC report: verdict HOLD, score 12/100, confidence 25%, ADX 6.7,
  // fundamental 73/100. The summary announced "the business figures are strong
  // while the price is falling" - a direction claim - from a score the analyser
  // had already declared unreliable, next to a verdict box reading HOLD. Two
  // conclusions from one dataset, disagreeing, side by side.
  {
    const c = combinedRead({ verdict:'HOLD', score:12, confidence:25, isChop:true }, F(73), null);
    ok('a ranging market is not read as a falling price',
       !/price is falling/.test(c.headline + c.detail), c.headline);
    eq('the fundamentals carry the reading instead', c.stance, 'Fundamentals lead; no usable trend signal');
    eq('and the technical half is marked unusable', c.techUsable, false);
    ok('the reason names ADX rather than hand-waving',
       /ADX below 20/.test(c.limits.join(' ')), c.limits.join(' '));
    ok('and says what would make it usable again',
       /once ADX clears 20 to 25/.test(c.limits.join(' ')), c.limits.join(' '));
    ok('the score is still disclosed, not hidden',
       /12\/100/.test(c.limits.join(' ')), c.limits.join(' '));
    ok('it states plainly that the score is not what the conclusion rests on',
       /not what the\s+conclusion above rests on/.test(c.limits.join(' ').replace(/\s+/g,' '))
       || /not what the conclusion above rests on/.test(c.limits.join(' ')), c.limits.join(' '));
  }
  {
    // Low confidence without chop is the same problem: split indicators are not
    // evidence of a direction either.
    const c = combinedRead({ verdict:'SELL', score:22, confidence:20 }, F(73), null);
    eq('a low-confidence technical read is also set aside', c.techUsable, false);
    ok('and the reason is the disagreement, not the trend', /confidence below 35%/.test(c.limits.join(' ')), c.limits.join(' '));
    ok('a middling score is not spun as a "hold" answer',
       /the evidence\s+is split, not that the answer is "hold"/.test(c.limits.join(' ').replace(/\s+/g,' '))
       || /not that the answer is "hold"/.test(c.limits.join(' ')), c.limits.join(' '));
  }
  {
    // Weak fundamentals with no usable technical read must not be softened.
    const c = combinedRead({ verdict:'HOLD', score:50, confidence:10, isChop:true }, F(30), null);
    eq('weak accounts still lead when they are all there is', c.stance, 'Fundamentals lead, and they are weak');
    eq('and the tone stays negative', c.tone, 'weak');
  }
  {
    const c = combinedRead({ verdict:'HOLD', score:50, confidence:10, isChop:true }, F(52), null);
    eq('two inconclusive halves conclude nothing', c.stance, 'No usable reading on either side');
    ok('and it says it will not invent one', /will not manufacture one/.test(c.detail), c.detail);
  }
  {
    // A confident technical read is still used. The fix must not disable the
    // technical half wholesale.
    const c = combinedRead({ verdict:'BUY', score:78, confidence:56 }, F(80), null);
    eq('a confident trend reading is still used', c.techUsable, true);
    eq('and the quadrants still work', c.stance, 'Aligned, constructive');
  }
  {
    const c = combinedRead({ verdict:'SELL', score:20, confidence:60 }, F(80), null);
    eq('a genuine downtrend against strong accounts is still called that',
       c.stance, 'Accounts ahead of the price');
  }
  // ── the summary explains the divergence rather than printing both blankly ──
  {
    const rsrc = slice('const CR_TONE_COL', '\n// ══', 'reliabui');
    const csrc = slice('const CR_BULL = 60', '\n// ── Report sections', 'reliabcomb');
    const { repExecSummaryHtml } = load(csrc + '\n' + rsrc, ['repExecSummaryHtml'],
      { Math, isFinite, Number, String, Object, Array, RT_LENDER_NA: [] });
    const ar = { currentPrice: 76.45, priceChg: 1.63, pricePct: 2.18,
                 signals: { verdict:'HOLD', score:12, isChop:true, long:{ confidence:25 } } };
    const c = combinedRead({ verdict:'HOLD', score:12, confidence:25, isChop:true }, F(73), null);
    const html = repExecSummaryHtml(ar, c, F(73), '₹');
    ok('the summary reconciles the HOLD verdict with the low score',
       /They are not\s+in\s+conflict/.test(html.replace(/\s+/g,' ')) || /not in\s*conflict/.test(html), html.slice(0,1200));
    ok('and marks the score as not used', /not used/.test(html), html.slice(0,1200));
    ok('the fundamental grade is still shown', />B</.test(html), 'grade missing');
  }
  {
    const rsrc = slice('const CR_TONE_COL', '\n// ══', 'reliabui2');
    const csrc = slice('const CR_BULL = 60', '\n// ── Report sections', 'reliabcomb2');
    const { repExecSummaryHtml } = load(csrc + '\n' + rsrc, ['repExecSummaryHtml'],
      { Math, isFinite, Number, String, Object, Array, RT_LENDER_NA: [] });
    // When the technical read IS usable, no such explanation should appear.
    const ar = { currentPrice: 100, priceChg: 1, pricePct: 1,
                 signals: { verdict:'BUY', score:78, long:{ confidence:56 } } };
    const c = combinedRead({ verdict:'BUY', score:78, confidence:56 }, F(80), null);
    const html = repExecSummaryHtml(ar, c, F(80), '₹');
    ok('no divergence note when there is no divergence', !/not in conflict/.test(html), 'spurious note');
    ok('and the score is not marked unused', !/not used/.test(html), 'wrongly discounted');
  }

  // ── never advice ──
  {
    const all = [combinedRead(T(75), F(80)), combinedRead(T(20), F(20)),
                 combinedRead(T(75), F(20)), combinedRead(T(20), F(80)),
                 combinedRead(T(50), F(50)), combinedRead(T(75), null)];
    const body = all.map(c => [c.headline, c.detail, c.stance].concat(c.limits).join(' ')).join(' ').toLowerCase();
    for(const phrase of ['you should', 'we recommend', 'strong buy', 'must buy', 'avoid this', 'price target'])
      ok('no combined reading gives advice: ' + phrase, body.indexOf(phrase) < 0, phrase);
    // Agreement is not certainty, and the report says so.
    ok('agreement is not sold as safety',
       /agreement means the two\s+analyses are not contradicting each other, not that the outcome is known/.test(
         all[0].detail.replace(/\s+/g, ' ')) || /not that the outcome is known/.test(all[0].detail),
       all[0].detail);
  }

  // ── the report sections ──
  {
    const dsrc = slice('const CR_TONE_COL', '\n// ══', 'reportsec');
    const { repExecSummaryHtml, repFundamentalHtml } =
      load(src + '\n' + dsrc, ['repExecSummaryHtml','repFundamentalHtml'],
        { Math, isFinite, Number, String, Object, Array, RT_LENDER_NA: ['currentRatio'] });
    {
      const ar = { currentPrice: 100, priceChg: 1.5, pricePct: 1.5,
                   signals: { verdict: 'BUY', score: 75, long: { confidence: 60 } } };
      const html = repExecSummaryHtml(ar, combinedRead(T(75), F(80)), F(80), '₹');
      ok('the summary leads the report', /Executive Summary/.test(html), 'no heading');
      ok('it carries the technical score', /75\/100/.test(html), html.slice(0, 200));
      ok('and the fundamental grade', />B</.test(html), 'no grade');
      ok('and the combined stance', /Aligned, constructive/.test(html), 'no stance');
    }
    {
      // With no fundamentals the box says "not reported" rather than showing a
      // zero or an empty cell that reads as a bad score.
      const ar = { currentPrice: 100, signals: { verdict: 'BUY', score: 75 } };
      const html = repExecSummaryHtml(ar, combinedRead(T(75), null), null, '₹');
      ok('a missing grade is marked not reported', /not reported/.test(html), html.slice(0, 400));
      ok('and the limits section is printed', /What this report cannot tell you/.test(html), 'limits hidden');
    }
    {
      const html = repFundamentalHtml(null, false, null, null, []);
      ok('no statements is called a source gap, not a finding',
         /gap in the data source, not a finding about the company/.test(html), html);
    }
    {
      const groups = [['Profitability', [['ROCE', 'roce', v => v.toFixed(1) + '%'],
                                         ['Current ratio', 'currentRatio', v => v.toFixed(2)]]]];
      const html = repFundamentalHtml({ roce: 22, currentRatio: 1.5 }, true, null, null, groups);
      ok('a computed ratio is printed', /22\.0%/.test(html), html);
      ok('a lender-inapplicable ratio prints n/a, not a number', /n\/a/.test(html) && !/1\.50/.test(html), html);
      ok('and the reason is given', /deposits are raw material/.test(html), 'lender note missing');
      const html2 = repFundamentalHtml({ roce: null, currentRatio: 1.5 }, false, null, null, groups);
      // Read the ROCE cell itself. The legend below the table also contains
      // "n/r", so matching the whole document proves nothing about the cell.
      const roceCell = (html2.match(/<td>ROCE<\/td><td[^>]*>([^<]*)<\/td>/) || [])[1];
      eq('an unreported ratio prints n/r in its own cell', roceCell, 'n/r');
      ok('and never a fabricated zero', !/0\.0%/.test(html2), html2);
      ok('the markers are explained in the report itself', /not reported by the data source/.test(html2), 'no key');
      ok('and it states nothing is estimated', /Nothing is estimated to fill a gap/.test(html2), 'no claim');
    }
    {
      const interp = { summary: 'A mixed picture.', findings: [{ tone:'weak', label:'Margins', text:'Thin.' }] };
      const html = repFundamentalHtml({ roce: 5 }, false, interp, null, []);
      ok('the Python reading is carried into the report', /A mixed picture\./.test(html), 'summary missing');
      ok('with its findings', /Margins/.test(html) && /Thin\./.test(html), 'findings missing');
    }
  }

  // ── the printed page must not hide or mangle anything ──
  // All four came out of a real exported PDF (NHPC, 5 pages).
  {
    // The fixed header/footer bands were painted over the flowing content by
    // Edge's Print to PDF, so four indicator rows and the tail of a finding
    // vanished with no sign anything was missing.
    ok('no opaque band is positioned over the printed content',
       !/\.page-header\{position:fixed/.test(SRC) && !/\.page-footer\{position:fixed/.test(SRC),
       'fixed bands can cover text');
    ok('and the reason is recorded so it is not reintroduced',
       /painted OVER the flowing content/.test(SRC), 'no note against a regression');
    ok('the footer prints at the end of the document instead',
       SRC.indexOf('class="page-footer"') > SRC.indexOf('<div class="disc"'), 'footer still ahead of the content');
    ok('and only once', (SRC.match(/<div class="page-footer">/g) || []).length === 1, 'more than one footer');
  }
  {
    // Headings were being sliced in half across page breaks.
    ok('headings are not split across a page break', /h2\{[^}]*break-inside:avoid/.test(SRC), 'h2 splits');
    ok('nor are sub-headings', /h3\{break-after:avoid;break-inside:avoid\}/.test(SRC), 'h3 splits');
    ok('table rows stay whole', /\.tbl tr\{break-inside:avoid\}/.test(SRC), 'rows split');
    ok('and column headings repeat on a continued table',
       /thead\{display:table-header-group\}/.test(SRC), 'headings do not repeat');
  }
  {
    // 1.6300000000000097 printed in the price box.
    const rsrc = slice('const CR_TONE_COL', '\n// ══', 'pdfnum');
    const csrc = slice('const CR_BULL = 60', '\n// ── Report sections', 'pdfcomb');
    const { repExecSummaryHtml } = load(csrc + '\n' + rsrc, ['repExecSummaryHtml'],
      { Math, isFinite, Number, String, Object, Array, RT_LENDER_NA: [] });
    const ar = { currentPrice: 76.45000000001, priceChg: 1.6300000000000097,
                 pricePct: 2.1800000000000004, signals: { verdict: 'HOLD', score: 12 } };
    const html = repExecSummaryHtml(ar, { stance:'x', tone:'info', headline:'h', detail:'d', limits:[] }, null, '₹');
    ok('the price change is rounded for display', /\+1\.63/.test(html), html.slice(0, 700));
    ok('no float tail reaches the page', !/0000000/.test(html), html.slice(0, 700));
    ok('the percentage is rounded too', /2\.18%/.test(html), html.slice(0, 700));
    ok('and the price itself', /76\.45</.test(html) || /₹76\.45/.test(html), html.slice(0, 700));
  }
  {
    // A price the feed never sent must not print as "₹" with nothing after it.
    const rsrc = slice('const CR_TONE_COL', '\n// ══', 'pdfnum2');
    const csrc = slice('const CR_BULL = 60', '\n// ── Report sections', 'pdfcomb2');
    const { repExecSummaryHtml } = load(csrc + '\n' + rsrc, ['repExecSummaryHtml'],
      { Math, isFinite, Number, String, Object, Array, RT_LENDER_NA: [] });
    const html = repExecSummaryHtml({ signals: {} }, { stance:'x', tone:'info', headline:'h', detail:'d', limits:[] }, null, '₹');
    ok('a missing price prints n/r, not a bare currency symbol', /₹n\/r/.test(html), html.slice(0, 600));
    ok('and no empty parentheses are left behind', !/\(\)/.test(html), html.slice(0, 600));
  }

  // ── wiring ──
  ok('the report gathers the fundamental half before composing',
     /fx\.execSummary = repExecSummaryHtml/.test(SRC) && /fx\.fundamental = repFundamentalHtml/.test(SRC), 'not wired');
  ok('a failure there does not cost the technical report',
     /catch \(e\) \{ console\.warn\('fundamental section skipped', e\); \}/.test(SRC), 'one failure kills the report');
  ok('the summary is printed before the technical detail',
     SRC.indexOf('${fx.execSummary') < SRC.indexOf('<h2>Technical Analysis</h2>'), 'summary is not first');
  ok('the technical section says what it does not cover',
     /they say\s*\n?\s*nothing about what the business earns or owes/.test(SRC), 'technicals oversold');
  ok('the branding is market-wide, not NSE\\/BSE', !/NSE\/BSE Analysis/.test(SRC), 'stale branding');
  ok('and the report header matches', /Complete Stock Market Analysis/.test(SRC), 'header not updated');
  ok('the mode button reflects that fundamentals are included',
     /🔬 Detailed analysis/.test(SRC) && !/🔬 Full technicals/.test(SRC), 'button still says technicals only');
}

// ── Report consistency: one price, a P/E that ties, one trend claim ────────
// All three came out of an exported Cupid Ltd report.
group('report consistency');
{
  // ── 1. one current price ──
  // The Executive Summary read ₹279.95 while the levels table read ₹280.46
  // beside the words "Current price", and the chart label agreed with the
  // table. The price was resolved after the signals were built, so the signals
  // fell back to the last bar close while the header used the entered price.
  ok('the canonical price is resolved before the signals are built',
     SRC.indexOf('const currentPrice = (isFinite(_enteredLtp)') < SRC.indexOf('const signals  = generateSignals('),
     'price still resolved after the components that use it');
  ok('and is passed into the signal generator',
     /Object\.assign\(\{\}, extras, \{ currentPrice \}\)/.test(SRC), 'signals never see it');
  ok('the entry ladder quotes that price, not the bar close',
     /entryIdeal: f2\(_px\), entryAggressive: f2\(_px \* 1\.005\), entryConservative: f2\(_px \* 0\.99\)/.test(SRC),
     'entry ladder still on closes[idx]');
  ok('the bar close is still carried, so anything meaning "last bar" can say so',
     /lastClose: _lastClose/.test(SRC), 'last close discarded');
  ok('indicator maths still runs on the series it was computed from',
     /const c     = closes\[idx\];/.test(SRC), 'indicators moved off the bar close');
  {
    // The resolver itself: an entered price wins, anything unusable falls back.
    const src = slice('function generateSignals(', '\n  const rsiV', 'px');
    const px = (entered, close) => {
      const _pxIn = entered;
      return (typeof _pxIn === 'number' && isFinite(_pxIn) && _pxIn > 0) ? _pxIn : close;
    };
    eq('a live price wins over the bar close', px(279.95, 280.46), 279.95);
    eq('no live price falls back to the bar close', px(undefined, 280.46), 280.46);
    eq('a zero price is not treated as a price', px(0, 280.46), 280.46);
    eq('a negative price is not treated as a price', px(-5, 280.46), 280.46);
    eq('NaN falls back rather than propagating', px(NaN, 280.46), 280.46);
    ok('the guard matches the one in the source',
       /typeof _pxIn === 'number' && isFinite\(_pxIn\) && _pxIn > 0/.test(SRC), 'guard differs');
  }

  // ── 2. P/E and EPS must tie against the price ──
  {
    const src = slice('const RT_EPS = 1e-9;', '\n// ── Display', 'petie');
    const { computeRatios } = load(src, ['computeRatios'], { Math, Object, Array, isFinite, Number });
    const mk = (byDate) => {
      const line = {}, dates = Object.keys(byDate).sort().reverse();
      for(const d of dates) for(const k of Object.keys(byDate[d])) (line[k] || (line[k] = {}))[d] = byDate[d][k];
      return { line, periodsAll: dates };
    };
    const ties = (r, price) => (r.eps == null || r.pe == null) ? null
      : Math.abs(price / r.eps - r.pe) / r.pe;
    {
      // The reported case: feed P/E 277.2 at ₹280.46, statement EPS 0.79.
      // 0.79 x 277.2 = 219, not 280. The pair must never be printed like that.
      const t = mk({ '2025-03-31': { NetIncome: 790, OrdinarySharesNumber: 1000 } });
      const r = computeRatios(t, { pe: 277.2 }, 280.46);
      ok('the displayed pair ties against the price', ties(r, 280.46) < 0.01,
         'eps ' + r.eps + ' x pe ' + r.pe + ' = ' + (r.eps * r.pe));
      ok('the mismatched statement EPS is not the one shown', Math.abs(r.eps - 0.79) > 0.01, String(r.eps));
      ok('and the basis is stated', /implied by the feed/.test(r.peBasis || ''), r.peBasis);
    }
    {
      // Feed gives both and they agree: use them as given.
      const r = computeRatios(mk({ '2025-03-31': { NetIncome: 1 } }), { pe: 20, eps: 10 }, 200);
      eq('a self-consistent feed pair is used as given', r.pe, 20);
      eq('with its own EPS', r.eps, 10);
      ok('the basis names the feed', /from the data feed/.test(r.peBasis || ''), r.peBasis);
    }
    {
      // Feed gives both and they contradict the price: trust the price.
      const r = computeRatios(mk({ '2025-03-31': { NetIncome: 1 } }), { pe: 500, eps: 10 }, 200);
      eq('a feed pair that disagrees with the price is recomputed', r.pe, 20);
      ok('and says the feed disagreed with itself', /disagreed with its EPS/.test(r.peBasis || ''), r.peBasis);
    }
    {
      // No feed valuation: both from the statements and the price.
      const t = mk({ '2025-03-31': { NetIncome: 1000, OrdinarySharesNumber: 100 } });
      const r = computeRatios(t, null, 200);
      eq('EPS comes from the statements', r.eps, 10);
      eq('and the P/E from the price', r.pe, 20);
      ok('the basis says so', /latest reported EPS/.test(r.peBasis || ''), r.peBasis);
    }
    {
      // A P/E with no price to check it against: the statement EPS is withheld
      // rather than printed beside a figure it cannot tie with.
      const t = mk({ '2025-03-31': { NetIncome: 1000, OrdinarySharesNumber: 100 } });
      const r = computeRatios(t, { pe: 277.2 }, null);
      eq('the P/E still stands on its own', r.pe, 277.2);
      eq('but no EPS is printed beside it', r.eps, null);
    }
    ok('the P/E cell states which basis produced it', /r\.peBasis/.test(SRC), 'basis not surfaced');
  }

  // ── 3. one claim about the trend ──
  // "Uptrend In Force - 151% up over the last 90 bars" printed while ADX read
  // 15.1 and the verdict read "Sideways - no clear trend".
  ok('the pattern text reads the live regime, not only the 90-bar drift',
     /const _chopNow   = !!\(signals && signals\.isChop\);/.test(SRC), 'regime ignored');
  ok('a drifted-but-ranging stock is called a consolidation',
     /_consolidating \? 'Consolidation'/.test(SRC), 'still labelled a trend');
  ok('and its signal line says so too',
     /_consolidating \? 'Consolidating After A Move'/.test(SRC), 'signal still says in force');
  ok('"in force" is reserved for a stock actually trending now',
     /const _trending  = _drifted && !_chopNow;/.test(SRC), 'in force can fire while ranging');
  ok('the prior move is kept as context rather than deleted',
     /The prior direction is context, not a signal/.test(SRC), 'history discarded');
  ok('the narrative cites the ADX that overruled the drift',
     /ADX is \$\{_adxNow != null \? _adxNow\.toFixed\(1\) : 'below 20'\}/.test(SRC), 'no ADX cited');
  ok('and says what would make it a trend again',
     /until ADX clears 20 to 25/.test(SRC), 'no route back');
  {
    // The classifier itself.
    const cls = (driftPct, travel, chop) => {
      const _drifted = Math.abs(driftPct) > 15 && travel > 0.55;
      return { trending: _drifted && !chop, consolidating: _drifted && chop };
    };
    const cupid = cls(151, 0.9, true);
    eq('Cupid: a 151% move with ADX 15.1 is not a trend in force', cupid.trending, false);
    eq('it is a consolidation', cupid.consolidating, true);
    const trending = cls(151, 0.9, false);
    eq('the same move with a real ADX is a trend', trending.trending, true);
    eq('and not a consolidation', trending.consolidating, false);
    const flat = cls(3, 0.2, true);
    eq('a stock that never moved is neither', flat.trending || flat.consolidating, false);
  }
}

// ── The Financials panel actually renders ──────────────────────────────────
// Every other test here checks a function in isolation. This one runs
// renderStatements end to end against a real fundamentals-timeseries payload,
// through the app's own fetch and parse path, and reads what lands in the DOM.
// Nothing else catches a panel that silently produces nothing.
group('financials panel renders');
{
  let JSDOM = null;
  try { JSDOM = require('jsdom').JSDOM; } catch (e) {}
  if (!JSDOM) {
    ok('jsdom present for the render test', false, 'install jsdom (npm install) to run this group');
  } else {
    const a = SRC.indexOf('const RT_EPS = 1e-9;');
    const b = SRC.indexOf('async function renderStatements(){');
    const m = SRC.slice(b, b + 9000).match(/\n\}\n/);
    const e = b + (m ? m.index + 3 : 0);
    ok('the render function was located in the page', a >= 0 && b > a && e > b, 'slice bounds');

    const ts = (type, vals) => ({ meta:{ type:[type] },
      [type]: vals.map(([d, v]) => ({ asOfDate: d, reportedValue: { raw: v } })) });
    const payload = { timeseries: { result: [
      ts('annualTotalRevenue',       [['2025-03-31', 1000], ['2024-03-31', 800]]),
      ts('annualNetIncome',          [['2025-03-31', 100],  ['2024-03-31', 80]]),
      ts('annualTotalAssets',        [['2025-03-31', 2000]]),
      ts('annualStockholdersEquity', [['2025-03-31', 800]]),
      ts('annualDilutedEPS',         [['2025-03-31', 1.01], ['2024-03-31', 0.9]]),
    ]}};

    const run = (opts) => {
      const dom = new JSDOM('<div id="stmt-body"></div>');
      let dvm = 0, shared = null;
      const ar = { symbol:'CUPID', market:'NSE', currentPrice: 280.46,
                   fundamentals: { pe: 277.2, pb: 83.39 } };
      const mod = load(SRC.slice(a, b) + SRC.slice(b, e), ['renderStatements'], {
        document: dom.window.document,
        Math, Object, Array, JSON, isFinite, Number, String, Set, Date, encodeURIComponent,
        AbortController, setTimeout, clearTimeout, console,
        analysisResult: ar, marketMode: 'india',
        _selfProxyUrl: () => (opts.noProxy ? '' : 'https://example.invalid'),
        insightPayload: () => ({}), insRunBuiltin: () => {},
        renderDVMBadges: () => { dvm++; shared = ar.ratios; },
        fetch: async (url) => opts.empty
          ? ({ ok: true, json: async () => ({}) })
          : ({ ok: true, json: async () => (/timeseries=/.test(url) ? payload : {}) }),
      });
      return mod.renderStatements().then(() => ({
        html: dom.window.document.getElementById('stmt-body').innerHTML, dvm, shared,
      }));
    };

    pending.push(run({}).then(r => {
      ok('the panel renders something substantial', r.html.length > 5000, r.html.length + ' bytes');
      ok('the ratio panel is there', /Key Ratios/.test(r.html), r.html.slice(0, 200));
      ok('the statements are there', /Profit/.test(r.html), 'no P&L');
      ok('the marker legend is there', /Reading the short forms/.test(r.html), 'no legend');
      // The regression this guards: a ratio panel that renders but shows nothing.
      ok('and the ratios carry values, not only markers', /\d+\.\d+%/.test(r.html), 'all markers');
      // The DVM hand-off added alongside the valuation-badge fix.
      eq('the valuation badge is redrawn once the ratios exist', r.dvm, 1);
      ok('and the ratios were shared before that redraw', r.shared && r.shared.netMargin != null,
         JSON.stringify(r.shared && Object.keys(r.shared).slice(0, 4)));
    }));

    pending.push(run({ empty: true }).then(r => {
      ok('an empty feed says so rather than rendering blank',
         /No annual statements available/.test(r.html), r.html.slice(0, 200));
      ok('and names it as a source gap', /gap in the source, not an error here/.test(r.html), 'blames the app');
    }));

    pending.push(run({ noProxy: true }).then(r => {
      ok('with no Worker configured it says which step is missing',
         /Financial statements come through the data proxy/.test(r.html), r.html.slice(0, 200));
    }));
  }
}

// ── Cloud sync: pure logic ──────────────────────────────────────────────────
group('cloud sync');
{
  const src = slice('// ══════════ CLOUD SYNC', '\n// ══════════ SIGN-IN GATE', 'cloudsync');
  const toastCalls = [];
  const { _csNormEmail, _csBuildPayload, _csShouldPreferRemote, _csDebounce, CS_SYNC_KEYS, _csNotifyNotInvited } =
    load(src, ['_csNormEmail','_csBuildPayload','_csShouldPreferRemote','_csDebounce','CS_SYNC_KEYS','_csNotifyNotInvited'],
         { Math, Object, Array, isFinite, Number, String, setTimeout, clearTimeout,
           toast: (msg, type) => toastCalls.push({ msg, type }) });

  // ── email normalisation: must match how the allowlist document ID is read ──
  eq('trims and lowercases', _csNormEmail('  Vipin@Example.COM  '), 'vipin@example.com');
  eq('null becomes empty, not "null"', _csNormEmail(null), '');
  eq('undefined becomes empty', _csNormEmail(undefined), '');
  eq('already-normal input is unchanged', _csNormEmail('a@b.com'), 'a@b.com');

  // ── the sync payload never carries API keys, whatever S holds ──────────────
  {
    const state = { indEQ: [1], usEQ: [], crypto: [2,3], fd: [], mf: [], txns: [4],
                     usdInr: 83.1, tdApiKey: 'SECRET', pi_claude_key: 'SECRET2', aikey_x: 'SECRET3' };
    const payload = _csBuildPayload(state);
    ok('no key from S leaks into the payload that was not explicitly allowed',
       !('tdApiKey' in payload) && !('pi_claude_key' in payload) && !('aikey_x' in payload),
       JSON.stringify(payload));
    eq('holdings are carried', payload.indEQ.length, 1);
    eq('and the fx rate', payload.usdInr, 83.1);
    ok('the allowlist itself contains no key-shaped field',
       !CS_SYNC_KEYS.some(k => /key/i.test(k)), CS_SYNC_KEYS.join(','));
  }
  {
    // A field S never set still gets a sane empty value, not undefined -
    // Firestore rejects undefined, and a caller should not have to know that.
    const payload = _csBuildPayload({});
    ok('a missing array field becomes an empty array', Array.isArray(payload.indEQ) && payload.indEQ.length === 0,
       JSON.stringify(payload.indEQ));
    eq('a missing scalar field becomes null, not undefined', payload.usdInr, null);
  }

  // ── conflict resolution: newer wins, an unknown remote never overwrites ────
  eq('a newer remote wins', _csShouldPreferRemote(1000, 2000), true);
  eq('an older remote loses', _csShouldPreferRemote(2000, 1000), false);
  eq('equal timestamps keep the local copy', _csShouldPreferRemote(1000, 1000), false);
  eq('no remote timestamp never wins, however old local is', _csShouldPreferRemote(1, null), false);
  eq('no remote timestamp and no local: still no', _csShouldPreferRemote(null, null), false);
  eq('a remote timestamp with no local timestamp wins, since there is nothing to prefer it over',
     _csShouldPreferRemote(null, 500), true);
  eq('non-numeric local is treated as unknown', _csShouldPreferRemote('x', 500), true);
  eq('non-numeric remote is treated as unknown, so it cannot win', _csShouldPreferRemote(500, 'x'), false);

  // ── debounce: only the last call in a burst survives, and flush is immediate ──
  pending.push(new Promise((resolve) => {
    let calls = [];
    const fn = _csDebounce((v) => calls.push(v), 20);
    fn(1); fn(2); fn(3);
    setTimeout(() => {
      eq('only the last queued call ran', calls.join(','), '3');
      let calls2 = [];
      const fn2 = _csDebounce((v) => calls2.push(v), 5000);
      fn2('a');
      fn2.flush('b');
      eq('flush runs immediately, bypassing the delay', calls2.join(','), 'b');
      resolve();
    }, 60);
  }));

  // ── open sign-up + invite-only sync: the user is told, exactly once ────────
  {
    _csNotifyNotInvited();
    _csNotifyNotInvited();
    _csNotifyNotInvited();
    eq('a blocked sync (permission-denied) surfaces exactly one toast, not one per attempt',
       toastCalls.length, 1);
    ok('the toast explains the account is not yet invited, not a generic error',
       /invite list/.test(toastCalls[0].msg), toastCalls[0].msg);
  }

  ok('the sync payload is built by an explicit allowlist, not by copying S',
     /for \(const k of CS_SYNC_KEYS\) out\[k\]/.test(SRC), 'looks like a blanket copy');
  ok('the allowlist is a short, named, auditable list',
     /CS_SYNC_KEYS = \['indEQ', 'usEQ', 'crypto', 'fd', 'mf', 'txns', 'usdInr'\];/.test(SRC),
     'allowlist changed shape unexpectedly - update this assertion deliberately if so');
}

// ── Auth gate: friendly errors and email shape ──────────────────────────────
group('auth gate');
{
  const src = slice('// ══════════ SIGN-IN GATE', '\nasync function pmAuthSignIn', 'authgate');
  const { _csEmailLooksValid, _csFriendlyAuthError } =
    load(src, ['_csEmailLooksValid','_csFriendlyAuthError'], { String, RegExp });
  ok('a plausible email passes', _csEmailLooksValid('a@b.com'), 'rejected a@b.com');
  ok('no @ fails', !_csEmailLooksValid('not-an-email'), 'accepted garbage');
  ok('no domain dot fails', !_csEmailLooksValid('a@b'), 'accepted a@b');
  ok('empty fails', !_csEmailLooksValid(''), 'accepted empty');
  ok('null fails rather than throwing', !_csEmailLooksValid(null), 'threw or accepted null');

  eq('a known Firebase error code gets a specific, human sentence',
     _csFriendlyAuthError('auth/wrong-password'), 'Incorrect password.');
  eq('an unrecognised code still produces a sentence, not the raw code',
     _csFriendlyAuthError('auth/some-future-code'), 'Something went wrong. Please try again.');
  ok('the raw Firebase code never reaches the user for a known case',
     !/auth\//.test(_csFriendlyAuthError('auth/wrong-password')), 'leaked the code');

  // ── the unverified-user screen offers a way back in without a page reload ──
  ok('a Sign In button re-checks verification instead of only telling the user to reload',
     /onclick="pmAuthCheckVerified\(\)">Sign In</.test(SRC), 'button missing from the unverified gate');
  ok('the check calls reloadUser, since Firebase caches emailVerified until reload() is called',
     /await window\.CloudAuth\.reloadUser\(\)/.test(SRC), 'reloadUser not wired up');

  // ── account creation is not self-serve: Firebase Auth sign-up itself was
  //    never invite-gated, only Firestore sync was, so a form that could
  //    create accounts client-side would let anyone in ──────────────────────
  ok('there is no self-serve account creation left in the gate',
     !/createUserWithEmailAndPassword/.test(SRC), 'a sign-up path still exists');
  ok('the invite email points at the admin inbox, not a form Firebase would act on',
     /mailto:miyee\.india@gmail\.com/.test(SRC), 'the request-access address changed or is missing');

  // ── account settings: changing email/password re-authenticates first,
  //    since Firebase rejects both without a recent sign-in ─────────────────
  ok('updating the email re-authenticates before calling CloudAuth.updateEmail',
     /await window\.CloudAuth\.reauthenticate\(pass\);\s*\n\s*await window\.CloudAuth\.updateEmail\(/.test(SRC),
     'email update does not re-auth first');
  ok('updating the password re-authenticates before calling CloudAuth.updatePassword',
     /await window\.CloudAuth\.reauthenticate\(pass\);\s*\n\s*await window\.CloudAuth\.updatePassword\(/.test(SRC),
     'password update does not re-auth first');
  ok('the account badge opens settings rather than signing out immediately',
     /onclick="pmOpenAccountSettings\(\)"/.test(SRC), 'badge still signs out directly');
  // ── the modal must inherit #section-portfolio's scoped theme variables
  //    (--white, --bd, --T1, ...) or it renders as an invisible card - the
  //    exact bug the sign-in gate itself had before this was caught ────────
  ok('the account modal is parented inside #section-portfolio, not document.body',
     /getElementById\('section-portfolio'\) \|\| document\.body/.test(SRC) &&
     /host\.appendChild\(modal\)/.test(SRC),
     'modal falls back to document.body, which has none of the --white/--bd/--T1 theme variables');
}
// ── Signal scanner + backtest ──────────────────────────────────────────────
group('signal scanner');
{
  const sgSrc = slice('// ══════════ SIGNAL SCANNER + BACKTEST', '\n// ── Rendering ──', 'signals');
  // calcSMA lives in the template, not in signals.js; pull it in rather than
  // duplicating a second implementation the tests could agree with wrongly.
  const { calcSMA } = load(slice('function calcSMA', '\nfunction calcEMA', 'calcSMA'), ['calcSMA'], {});
  const { _sgCrossovers, _sgLatestCrossover, _sgBacktest, _sgRankByRecency } =
    load(sgSrc, ['_sgCrossovers','_sgLatestCrossover','_sgBacktest','_sgRankByRecency'],
         { Array, Math, isFinite, Number, String, Date, calcSMA });

  // Dates are consecutive days so "bars ago" and "days ago" agree, which keeps
  // the assertions about recency readable.
  const mkSeries = closes => closes.map((c, i) => ({
    d: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), c,
  }));

  // Flat, up, down, up, down - hand-checkable with SMA 2 vs SMA 4.
  const CLOSES = [10,10,10,10, 20,20,20,20, 5,5,5,5, 30,30,30,30, 1,1,1,1];
  const SERIES = mkSeries(CLOSES);

  {
    const xs = _sgCrossovers(CLOSES, 2, 4);
    eq('finds every crossover and no more', xs.length, 3);
    eq('the first is bearish where the step down happens', xs[0].type + '@' + xs[0].i, 'bearish@8');
    eq('then bullish on the step up', xs[1].type + '@' + xs[1].i, 'bullish@12');
    eq('then bearish again on the collapse', xs[2].type + '@' + xs[2].i, 'bearish@16');
    // Bars 0-3 have no long SMA at all, and bar 4 is the first comparable bar:
    // being above on the first bar you can see is not a crossing.
    ok('the first comparable bar is never itself a crossover', xs.every(x => x.i > 4),
       'a crossover was reported at or before the first comparable bar');
  }
  eq('too little history yields no signals, rather than a wrong one',
     _sgCrossovers([1,2,3], 2, 4).length, 0);
  eq('a series that never crosses yields nothing',
     _sgCrossovers([1,1,1,1,1,1,1,1,1,1], 2, 4).length, 0);

  {
    const s = _sgLatestCrossover(SERIES, 2, 4);
    eq('the latest crossover is the last one, not the first', s.date, SERIES[16].d);
    eq('and carries its direction', s.type, 'bearish');
    eq('recency is counted from the last bar of the series', s.barsAgo, 3);
    eq('and in days for the same consecutive-day series', s.ageDays, 3);
    eq('no crossover at all reads as null, not as a stale signal',
       _sgLatestCrossover(mkSeries([1,1,1,1,1,1,1,1,1,1]), 2, 4), null);
  }

  {
    const xs = _sgCrossovers(CLOSES, 2, 4);
    const bull = xs.find(x => x.type === 'bullish');
    const bear = xs.filter(x => x.type === 'bearish')[1];
    const bt = _sgBacktest(SERIES, 2, 4);

    // The lookahead guard: a crossover is confirmed BY a close, so it can only
    // be traded on the next one. Entering at the crossing bar's own close is
    // the bias that makes home-made backtests look better than the rule is.
    eq('entry is the bar after the bullish crossover confirms',
       bt.trades[0].entryDate, SERIES[bull.i + 1].d);
    ok('and never the crossover bar itself', bt.trades[0].entryDate !== SERIES[bull.i].d,
       'entered at the crossing close - lookahead bias');
    eq('exit is likewise the bar after the bearish crossover',
       bt.trades[0].exitDate, SERIES[bear.i + 1].d);

    eq('one closed trade came out of this series', bt.nTrades, 1);
    eq('the return is measured entry close to exit close',
       Math.round(bt.trades[0].ret * 100) / 100,
       Math.round((bt.trades[0].exitPrice - bt.trades[0].entryPrice) / bt.trades[0].entryPrice * 1e4) / 100);
    eq('a losing trade is not counted as a win', bt.wins, 0);
    eq('win rate reflects that', bt.winRate, 0);

    // A bearish cross with no position open is not a short: it is ignored.
    ok('a bearish signal before any entry opens nothing',
       bt.trades[0].entryDate > SERIES[8].d, 'traded on the leading bearish cross');
  }

  {
    // Ends mid-position: bullish at 12 (entry 13), nothing bearish afterwards.
    const openSeries = mkSeries([10,10,10,10, 20,20,20,20, 5,5,5,5, 30,30,30,30]);
    const bt = _sgBacktest(openSeries, 2, 4);
    eq('an unresolved position is not counted as a closed trade', bt.nTrades, 0);
    eq('and leaves the win rate undefined rather than 100%', bt.winRate, null);
    ok('but it is still reported, so the row is not silently empty', !!bt.open,
       'the open position vanished');
    eq('the open position entered on the bar after the crossover', bt.open.entryDate, openSeries[13].d);
  }

  {
    const bt = _sgBacktest(SERIES, 2, 4);
    // Buy-and-hold runs from the first bar the rule could have traded, so the
    // rule is not credited for sitting out the warm-up.
    eq('buy-and-hold starts at the end of the SMA warm-up', bt.from, SERIES[4].d);
    eq('and is measured to the last bar', bt.to, SERIES[SERIES.length - 1].d);
    const expected = (CLOSES[CLOSES.length - 1] - CLOSES[4]) / CLOSES[4] * 100;
    ok('buy-and-hold is the plain hold return over that window',
       Math.abs(bt.buyHold - expected) < 1e-9, `${bt.buyHold} vs ${expected}`);
    ok('drawdown is a percentage of the peak, never negative',
       bt.maxDD >= 0 && bt.maxDD <= 100, String(bt.maxDD));
  }
  eq('too short a series backtests to null rather than to a fake record',
     _sgBacktest(mkSeries([1,2,3]), 2, 4), null);

  {
    const rows = [
      { key:'A', signal:{ barsAgo: 9 } },
      { key:'B', signal:null },
      { key:'C', signal:{ barsAgo: 1 } },
      { key:'D', signal:{ barsAgo: 4 } },
    ];
    const ranked = _sgRankByRecency(rows);
    eq('most recent signal ranks first', ranked.map(r => r.key).join(''), 'CDAB');
    eq('holdings with no signal sink to the bottom but are not dropped', ranked.length, 4);
    eq('the caller\'s array is left alone', rows.map(r => r.key).join(''), 'ABCD');
  }
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

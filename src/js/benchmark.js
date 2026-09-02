// ══════════ BENCHMARK: PORTFOLIO vs NIFTY ══════════
// "Am I actually beating the index?" is the question stock-picking has to
// answer, and the app could not. Comparing your return to a headline index
// number is not enough - you did not invest a lump sum on 1 January. The only
// fair comparison replays YOUR cashflows: every rupee, on the date you actually
// invested it, put into the index instead. Then both sides get the same XIRR
// treatment and the difference is attributable to your stock picks.

const BENCH_SYMBOL = '^NSEI';        // Nifty 50
const BENCH_LABEL  = 'Nifty 50';

// Closes come back as [{ d:'YYYY-MM-DD', c:Number }] sorted ascending.
// Markets are shut at weekends and on holidays, so a purchase date often has no
// close of its own; take the most recent close on or before it. Returns null
// when the date precedes the series entirely - we cannot price what we cannot
// see, and must not extrapolate backwards.
function _bmCloseOnOrBefore(series, dateStr){
  if(!Array.isArray(series) || !series.length) return null;
  const t = new Date(dateStr).getTime();
  if(isNaN(t)) return null;
  let lo = 0, hi = series.length - 1, best = null;
  while(lo <= hi){
    const mid = (lo + hi) >> 1;
    const mt = new Date(series[mid].d).getTime();
    if(mt <= t){ best = series[mid]; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best && isFinite(+best.c) && +best.c > 0 ? +best.c : null;
}

// Replay the book into the index. Each lot buys index units at its own purchase
// date; the terminal value is those units at the latest close.
// Lots that cannot be priced (no date, or a date before the series starts) are
// excluded from BOTH sides, so the comparison stays like-for-like.
function _bmReplay(lots, series, asOf){
  const latest = series && series.length ? +series[series.length-1].c : null;
  if(!latest || !isFinite(latest)) return null;
  const cf = [], benchCf = [];
  let invested = 0, portValue = 0, benchValue = 0, used = 0, skipped = 0;
  (Array.isArray(lots) ? lots : []).forEach(l => {
    const inv = +l.invested, cur = +l.current;
    const d = l.buyDate ? new Date(l.buyDate) : null;
    const priceable = d && !isNaN(d.getTime()) && d <= asOf && isFinite(inv) && inv > 0 && isFinite(cur);
    const open = priceable ? _bmCloseOnOrBefore(series, l.buyDate) : null;
    if(!priceable || open == null){ skipped++; return; }
    const units = inv / open;
    invested   += inv;
    portValue  += cur + (isFinite(+l.dividend) && +l.dividend > 0 ? +l.dividend : 0);
    benchValue += units * latest;
    cf.push({ date:d, amount:-inv });
    benchCf.push({ date:d, amount:-inv });
    used++;
  });
  if(!used) return null;
  cf.push({ date:asOf, amount:portValue });
  benchCf.push({ date:asOf, amount:benchValue });
  cf.sort((a,b)=>a.date-b.date); benchCf.sort((a,b)=>a.date-b.date);
  let portXirr = null, benchXirr = null;
  try { portXirr  = xirr(cf); }      catch(e) {}
  try { benchXirr = xirr(benchCf); } catch(e) {}
  return {
    used, skipped, invested, portValue, benchValue,
    portXirr, benchXirr,
    valueDiff: portValue - benchValue,
    xirrDiff: (portXirr != null && benchXirr != null) ? portXirr - benchXirr : null,
  };
}

// Pull index history through the owner Worker (the Yahoo chart host is already
// on its allowlist). Returns [{d,c}] ascending, or null.
async function _bmFetchIndex(symbol, years){
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if(!sp) return null;
  const to = Math.floor(Date.now()/1000);
  const from = to - Math.round((years||8) * 365 * 24 * 3600);
  const y = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${to}&interval=1d`;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000);
    let r;
    try { r = await fetch(`${sp}/?url=${encodeURIComponent(y)}`, { signal: ctrl.signal }); }
    finally { clearTimeout(tid); }
    if(!r.ok) return null;
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    const ts = res && res.timestamp;
    const q  = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
    if(!Array.isArray(ts) || !q || !Array.isArray(q.close)) return null;
    const out = [];
    for(let i=0;i<ts.length;i++){
      const c = q.close[i];
      if(c == null || !isFinite(c)) continue;                 // holidays come back null
      out.push({ d:new Date(ts[i]*1000).toISOString().slice(0,10), c:+c });
    }
    return out.length ? out : null;
  } catch(e) { return null; }
}

let _bmSeries = null;
async function renderBenchmark(){
  const el = document.getElementById('ana-benchmark');
  if(!el) return;
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if(!sp){
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Benchmarking needs the data proxy. Deploy the Worker in <code>proxy/README.md</code> and this fills in automatically.</div>`;
    return;
  }
  el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Fetching ${BENCH_LABEL}…</div>`;
  if(!_bmSeries) _bmSeries = await _bmFetchIndex(BENCH_SYMBOL, 8);
  if(!_bmSeries){
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Couldn't reach ${BENCH_LABEL} history just now. Retry from the Refresh button.</div>`;
    return;
  }
  const r = _bmReplay(_pmLots(), _bmSeries, new Date());
  if(!r){
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">No holdings could be dated against ${BENCH_LABEL} yet — add purchase dates to compare.</div>`;
    return;
  }
  const ahead = r.valueDiff >= 0;
  const col = ahead ? '#00B386' : '#D93025';
  const tile = (lbl,val,sub,c) => `<div class="tax-sum-box"><div class="tax-sum-box-lbl">${lbl}</div>`
    + `<div class="tax-sum-box-val" style="color:${c}">${val}</div><div class="tax-sum-box-sub">${sub}</div></div>`;
  const pct = v => v==null ? '—' : (v>=0?'+':'')+v.toFixed(2)+'%';
  el.innerHTML = `<div class="tax-sum-grid">
    ${tile('Your XIRR', pct(r.portXirr), 'your actual picks', r.portXirr>=0?'#00B386':'#D93025')}
    ${tile(BENCH_LABEL+' XIRR', pct(r.benchXirr), 'same money, same dates', '#1A73E8')}
    ${tile(ahead?'Ahead of index':'Behind index',
        (ahead?'+':'-')+F.inr(Math.abs(r.valueDiff)),
        r.xirrDiff==null?'':pct(r.xirrDiff)+' a year', col)}
  </div>
  <div style="font-size:11px;color:var(--T3);margin-top:8px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
    Every rupee you invested is replayed into ${BENCH_LABEL} <b>on the date you actually invested it</b>, then both sides get the same XIRR — so this isolates your stock picking, not your timing.
    ${r.skipped ? ` <b>${r.skipped}</b> holding${r.skipped===1?'':'s'} excluded from both sides (no usable purchase date).` : ''}
  </div>`;
}

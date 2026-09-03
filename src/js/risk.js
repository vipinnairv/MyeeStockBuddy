// ══════════ PORTFOLIO RISK: VOLATILITY, BETA, SHARPE ══════════
// Return alone cannot tell you whether you were skilful or merely lucky with
// risk. These are the three numbers an advisor puts next to performance:
//   Volatility - how violently the portfolio swings, annualised.
//   Beta       - how much it moves for a given move in the index. 1.0 = in line.
//   Sharpe     - excess return per unit of volatility. Higher is better paid.
// All are computed from daily returns of a value-weighted portfolio series
// reconstructed from each holding's own price history.

const RISK_TRADING_DAYS = 252;
const RISK_FREE_DEFAULT = 6.5;   // India ~10y G-sec, in percent per year

// [{d,c}] ascending -> simple daily returns aligned to the dates present in ALL
// series. Aligning matters: a holding that stops trading for a day must not
// shift another holding's returns by one day.
function _rkAlignedReturns(seriesMap, weights){
  const names = Object.keys(seriesMap || {});
  if(!names.length) return null;
  // Dates common to every series.
  let common = null;
  for(const n of names){
    const s = seriesMap[n];
    if(!Array.isArray(s) || s.length < 2) return null;   // needs 2 closes to yield a return
    const set = new Set(s.map(p => p.d));
    common = common ? new Set([...common].filter(d => set.has(d))) : set;
  }
  const dates = [...(common || [])].sort();
  // Two common dates give one return. Whether that is ENOUGH is _rkMetrics's
  // call, not this function's - a single thin holding must not silently
  // nullify the whole portfolio's risk figures.
  if(dates.length < 2) return null;
  const closeAt = {};
  names.forEach(n => { const m = {}; seriesMap[n].forEach(p => { m[p.d] = +p.c; }); closeAt[n] = m; });

  const wSum = names.reduce((s,n) => s + (+weights[n] || 0), 0);
  if(!(wSum > 0)) return null;
  const out = [];
  for(let i = 1; i < dates.length; i++){
    let r = 0, used = 0;
    for(const n of names){
      const p0 = closeAt[n][dates[i-1]], p1 = closeAt[n][dates[i]];
      const w = (+weights[n] || 0) / wSum;
      if(!(p0 > 0) || !(p1 > 0) || !(w > 0)) continue;
      r += w * ((p1 - p0) / p0);
      used += w;
    }
    if(used > 0) out.push({ d: dates[i], r: r / used });   // renormalise if some were missing
  }
  return out.length >= 1 ? out : null;
}

function _rkStdev(xs){
  const n = xs.length;
  if(n < 2) return null;
  const m = xs.reduce((a,b) => a + b, 0) / n;
  const v = xs.reduce((a,b) => a + (b - m) * (b - m), 0) / (n - 1);   // sample stdev
  return Math.sqrt(v);
}

// Beta and correlation of the portfolio against a benchmark, over the dates
// they share. Returns null when there is nothing to regress against.
function _rkBeta(portRets, benchRets){
  if(!Array.isArray(portRets) || !Array.isArray(benchRets)) return null;
  const bm = {}; benchRets.forEach(p => { bm[p.d] = p.r; });
  const xs = [], ys = [];
  portRets.forEach(p => { if(p.d in bm){ ys.push(p.r); xs.push(bm[p.d]); } });
  if(xs.length < 20) return null;                 // too few overlapping days to mean anything
  const mx = xs.reduce((a,b)=>a+b,0)/xs.length, my = ys.reduce((a,b)=>a+b,0)/ys.length;
  let cov = 0, varx = 0, vary = 0;
  for(let i=0;i<xs.length;i++){
    const dx = xs[i]-mx, dy = ys[i]-my;
    cov += dx*dy; varx += dx*dx; vary += dy*dy;
  }
  if(!(varx > 0)) return null;
  const beta = cov / varx;
  const corr = (varx > 0 && vary > 0) ? cov / Math.sqrt(varx*vary) : null;
  return { beta, corr, days: xs.length };
}

// Everything together. rf is the annual risk-free rate in percent.
function _rkMetrics(portRets, benchRets, rf){
  if(!Array.isArray(portRets) || portRets.length < 20) return null;   // < 1 month is noise
  const rs = portRets.map(p => p.r);
  const sd = _rkStdev(rs);
  if(sd == null) return null;
  const rawVol = sd * Math.sqrt(RISK_TRADING_DAYS) * 100;              // annualised %
  // Floating point leaves a perfectly steady series with a volatility around
  // 1e-15 rather than exactly zero. Dividing by that produced a Sharpe of ~2e16,
  // which would render as a spectacular risk-adjusted return. Below this
  // threshold there is no measurable risk, so Sharpe is undefined, not enormous.
  const VOL_EPS = 1e-6;
  const vol = rawVol < VOL_EPS ? 0 : rawVol;
  const meanDaily = rs.reduce((a,b)=>a+b,0) / rs.length;
  const annRet = (Math.pow(1 + meanDaily, RISK_TRADING_DAYS) - 1) * 100;
  const rfPct = isFinite(+rf) ? +rf : RISK_FREE_DEFAULT;
  const sharpe = vol >= VOL_EPS ? (annRet - rfPct) / vol : null;
  const b = _rkBeta(portRets, benchRets);
  return {
    days: portRets.length, vol, annRet, riskFree: rfPct, sharpe,
    beta: b ? b.beta : null, corr: b ? b.corr : null, betaDays: b ? b.days : 0,
  };
}

// ── Glue: fetch each holding's history through the owner Worker ────────────
// Reuses _bmFetchIndex, which already speaks to the Worker and drops holiday
// nulls. Equities and crypto only; funds and FDs have no comparable series.
function _rkHoldings(){
  const out = [];
  try {
    (S.indEQ||[]).forEach(h => { const c = cIND(h);
      if(c.cur > 0 && h.ticker) out.push({ key:h.name || h.ticker, sym:_toYahooSymbol(h.ticker,'India EQ'), weight:c.cur }); });
    (S.usEQ||[]).forEach(h => { const c = cUS(h);
      if(c.cur > 0 && h.ticker) out.push({ key:h.name || h.ticker, sym:_toYahooSymbol(h.ticker,'US EQ'), weight:c.cur }); });
    (S.crypto||[]).forEach(c => { const v = cCRY(c);
      const sym = (typeof cryptoMarketSymbol === 'function')
        ? cryptoMarketSymbol(c, 'INR', typeof CRYPTO_DB !== 'undefined' ? CRYPTO_DB : null) : null;
      if(v.cur > 0 && sym) out.push({ key:c.coin || sym, sym, weight:v.cur }); });
  } catch(e) {}
  return out;
}

let _rkCache = null;
async function renderRisk(){
  const el = document.getElementById('ana-risk');
  if(!el) return;
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if(!sp){
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Risk metrics need per-holding price history, which comes through the data proxy. Deploy the Worker in <code>proxy/README.md</code> and this fills in automatically.</div>`;
    return;
  }
  const hold = _rkHoldings();
  if(!hold.length){ el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">No priced equity or crypto holdings to measure.</div>`; return; }

  el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Fetching price history for ${hold.length} holdings… (first run only)</div>`;
  if(!_rkCache){
    const seriesMap = {}, weights = {}; const missing = [];
    for(let i = 0; i < hold.length; i += 6){                 // small batches, same as the price refresh
      const batch = hold.slice(i, i + 6);
      const got = await Promise.all(batch.map(h => _bmFetchIndex(h.sym, 2).catch(() => null)));
      got.forEach((s, j) => {
        const h = batch[j];
        if(Array.isArray(s) && s.length > 30){ seriesMap[h.key] = s; weights[h.key] = h.weight; }
        else missing.push(h.key);
      });
    }
    const bench = await _bmFetchIndex(BENCH_SYMBOL, 2).catch(() => null);
    _rkCache = { seriesMap, weights, bench, missing, covered:Object.keys(seriesMap).length, total:hold.length };
  }
  const { seriesMap, weights, bench, missing, covered, total } = _rkCache;
  const port = _rkAlignedReturns(seriesMap, weights);
  const benchRets = bench ? _rkAlignedReturns({ b: bench }, { b: 1 }) : null;
  const m = port ? _rkMetrics(port, benchRets, RISK_FREE_DEFAULT) : null;
  if(!m){
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Not enough overlapping price history yet to measure risk (needs about a month of common trading days across ${covered || 0} holdings).</div>`;
    return;
  }
  const tile = (lbl,val,sub,c,tip) => `<div class="tax-sum-box" title="${tip||''}" style="cursor:help">`
    + `<div class="tax-sum-box-lbl">${lbl}</div><div class="tax-sum-box-val" style="color:${c}">${val}</div>`
    + `<div class="tax-sum-box-sub">${sub}</div></div>`;
  const betaWord = m.beta == null ? '' : m.beta > 1.15 ? 'more volatile than the index'
                 : m.beta < 0.85 ? 'steadier than the index' : 'moves roughly with the index';
  const sharpeWord = m.sharpe == null ? '' : m.sharpe >= 1 ? 'well paid for the risk'
                   : m.sharpe >= 0.5 ? 'reasonably paid' : m.sharpe >= 0 ? 'thinly paid' : 'not paid for the risk';
  el.innerHTML = `<div class="tax-sum-grid">
    ${tile('Volatility', m.vol.toFixed(1)+'%', 'annualised swing', '#F59E0B',
        'How violently the portfolio moves, annualised from daily returns. Higher means bigger swings both ways - it is not itself bad, but it should be paid for.')}
    ${tile('Beta vs Nifty', m.beta==null?'-':m.beta.toFixed(2), m.beta==null?'needs more overlap':betaWord, '#1A73E8',
        'How much the portfolio moves for a 1% move in the index. Above 1 amplifies the market; below 1 dampens it.')}
    ${tile('Sharpe ratio', m.sharpe==null?'-':m.sharpe.toFixed(2), m.sharpe==null?'-':sharpeWord,
        m.sharpe==null?'var(--T3)':m.sharpe>=0.5?'#00B386':m.sharpe>=0?'#F59E0B':'#D93025',
        'Return above the risk-free rate, per unit of volatility. It answers whether the swings were worth enduring.')}
  </div>
  <div style="font-size:11px;color:var(--T3);margin-top:8px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
    From ${m.days} days of common trading history across <b>${covered} of ${total}</b> holdings, weighted by current value.
    Risk-free rate assumed ${m.riskFree}% a year.
    ${missing.length ? `No usable history for: ${missing.slice(0,5).join(', ')}${missing.length>5?` +${missing.length-5} more`:''} - these are excluded.` : ''}
    ${m.beta==null ? 'Beta needs at least 20 days overlapping with the index.' : `Beta measured over ${m.betaDays} shared days.`}
    These describe the past; they are not a forecast.
  </div>`;
}

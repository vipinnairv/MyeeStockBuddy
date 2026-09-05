// ══════════ SIGNAL SCANNER + BACKTEST ══════════
// A moving-average crossover scanner over the holdings you actually own,
// with the backtest attached to every signal.
//
// The scanner half is the familiar idea: compute a short and a long SMA, find
// the bars where they cross, rank by recency. The backtest half is the part
// that is usually missing, and it is the more important one - a crossover on
// its own is a chart annotation, not evidence. Showing "this rule has fired 14
// times on this stock and won 6 of them, returning less than simply holding"
// is the difference between a signal you can judge and one you can only
// believe.
//
// Price history comes through _bmFetchIndex (benchmark.js), which already
// speaks to the owner Worker and drops holiday nulls, and the holdings list
// through _rkHoldings (risk.js). This module adds no new data plumbing.

const SG_SHORT_DEFAULT = 6;    // the pair from the Varsity walkthrough, and a
const SG_LONG_DEFAULT  = 30;   // reasonable swing-trading default either way
const SG_YEARS         = 5;    // enough history for the backtest to mean something

// Bars where the short SMA crosses the long one. The crossover bar is the bar
// where the sign of (short - long) flips, so it needs both SMAs to exist and a
// previous sign to flip from - which is why the first comparable bar never
// counts as a crossover, however far apart the averages already are.
// An exact tie is not a cross: it is skipped, and the sign carries over, so a
// flat touch that resolves back the way it came does not fire a signal.
function _sgCrossovers(closes, shortP, longP) {
  if (!Array.isArray(closes) || closes.length < longP + 1) return [];
  const s = calcSMA(closes, shortP), l = calcSMA(closes, longP);
  const out = [];
  let prev = null;
  for (let i = 0; i < closes.length; i++) {
    if (s[i] == null || l[i] == null) continue;
    const diff = s[i] - l[i];
    if (diff === 0) continue;
    const sign = diff > 0 ? 1 : -1;
    if (prev !== null && sign !== prev) out.push({ i, type: sign > 0 ? 'bullish' : 'bearish' });
    prev = sign;
  }
  return out;
}

// The most recent crossover in a [{d,c}] series, with its age. Age is measured
// from the series' own last bar rather than from today, so a stale feed reads
// as "3 days after the last close I have" instead of silently ageing.
function _sgLatestCrossover(series, shortP, longP) {
  if (!Array.isArray(series) || !series.length) return null;
  const closes = series.map(p => +p.c);
  const xs = _sgCrossovers(closes, shortP, longP);
  if (!xs.length) return null;
  const last = xs[xs.length - 1];
  const bar = series[last.i];
  const s = calcSMA(closes, shortP), l = calcSMA(closes, longP);
  const ms = new Date(series[series.length - 1].d) - new Date(bar.d);
  return {
    type: last.type,
    date: bar.d,
    close: +bar.c,
    short: s[last.i],
    long: l[last.i],
    barsAgo: series.length - 1 - last.i,
    ageDays: isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : null,
  };
}

// Long-only replay of the same rule over the same series.
//
// A crossover is only actionable on the NEXT bar: the crossover is confirmed by
// a close, and you cannot trade at a close you have not seen yet. Entering on
// the crossover bar itself is lookahead bias, and it is what makes most
// home-made backtests look better than the rule really is.
//
// Bearish crossovers close the position rather than opening a short one -
// that is how this rule actually gets used on a long-only equity book.
function _sgBacktest(series, shortP, longP) {
  if (!Array.isArray(series) || series.length < longP + 2) return null;
  const closes = series.map(p => +p.c);
  const xs = _sgCrossovers(closes, shortP, longP);
  const trades = [];
  let entry = null;

  xs.forEach(x => {
    const t = x.i + 1;                       // act on the bar after confirmation
    if (t >= series.length) return;          // crossed on the last bar: nothing to act on yet
    if (x.type === 'bullish' && !entry) {
      entry = { i: t, d: series[t].d, p: closes[t] };
    } else if (x.type === 'bearish' && entry) {
      trades.push({
        entryIdx: entry.i, entryDate: entry.d, entryPrice: entry.p,
        exitIdx: t, exitDate: series[t].d, exitPrice: closes[t],
        ret: (closes[t] - entry.p) / entry.p * 100,
      });
      entry = null;
    }
  });

  // A position still open at the end of the data is reported separately and
  // kept out of the win rate: it has not resolved, and counting an unrealised
  // gain as a win is how a losing rule flatters itself.
  let open = null;
  if (entry) {
    const li = series.length - 1;
    open = {
      entryIdx: entry.i, entryDate: entry.d, entryPrice: entry.p,
      exitIdx: li, exitDate: series[li].d, exitPrice: closes[li],
      ret: (closes[li] - entry.p) / entry.p * 100,
    };
  }

  const n = trades.length;
  const wins = trades.filter(t => t.ret > 0).length;
  let eq = 1;
  trades.forEach(t => { eq *= (1 + t.ret / 100); });

  // Buy-and-hold is measured from the first bar the rule could have traded on,
  // not from the start of the data - comparing a strategy that sat out the
  // warm-up period against a hold that did not would flatter the hold.
  const startIdx = Math.min(longP, series.length - 1);
  const endIdx = series.length - 1;
  const buyHold = closes[startIdx] > 0
    ? (closes[endIdx] - closes[startIdx]) / closes[startIdx] * 100 : null;

  // Equity curve: compounds the daily move while a position is open, flat while
  // out. Drawdown measured on that curve is the loss the rule actually put you
  // through, not the stock's own drawdown.
  const inPos = new Array(series.length).fill(false);
  trades.concat(open ? [open] : []).forEach(t => {
    for (let i = t.entryIdx; i <= t.exitIdx && i < series.length; i++) inPos[i] = true;
  });
  let e = 1, peak = 1, maxDD = 0;
  for (let i = 1; i < series.length; i++) {
    if (inPos[i] && closes[i - 1] > 0) e *= closes[i] / closes[i - 1];
    if (e > peak) peak = e;
    const dd = peak > 0 ? (peak - e) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades, open,
    nTrades: n,
    wins,
    winRate: n ? wins / n * 100 : null,
    avgRet: n ? trades.reduce((s, t) => s + t.ret, 0) / n : null,
    stratRet: n ? (eq - 1) * 100 : null,
    buyHold,
    maxDD,
    from: series[startIdx].d,
    to: series[endIdx].d,
    bars: series.length,
  };
}

// Most recent signal first; holdings the rule has never fired on sink to the
// bottom rather than being dropped, so "no signal" stays visible as an answer.
function _sgRankByRecency(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const as = a && a.signal, bs = b && b.signal;
    if (!as && !bs) return 0;
    if (!as) return 1;
    if (!bs) return -1;
    return as.barsAgo - bs.barsAgo;
  });
}

// ── Rendering ───────────────────────────────────────────────────────────────

let _sgCache = null;      // { years, seriesMap } - refetching on every scan would
                          // burn the proxy for no reason; periods change locally

function _sgPeriods() {
  const gi = id => {
    const el = document.getElementById(id);
    const v = el ? parseInt(el.value, 10) : NaN;
    return isFinite(v) ? v : null;
  };
  let short = gi('sg-short') || SG_SHORT_DEFAULT;
  let long = gi('sg-long') || SG_LONG_DEFAULT;
  if (short < 2) short = 2;
  if (long <= short) long = short + 1;    // a long average must be the longer one
  return { short, long };
}

function _sgFmtPct(v, dp) {
  if (v == null || !isFinite(v)) return '-';
  return (v >= 0 ? '+' : '') + v.toFixed(dp == null ? 1 : dp) + '%';
}

async function scanSignals() {
  const el = document.getElementById('sg-results');
  if (!el) return;
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if (!sp) {
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">The scanner needs price history, which comes through the data proxy. Deploy the Worker in <code>proxy/README.md</code> and this fills in automatically.</div>`;
    return;
  }
  const hold = (typeof _rkHoldings === 'function') ? _rkHoldings() : [];
  if (!hold.length) {
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">No priced equity or crypto holdings to scan. Add holdings and set their prices first.</div>`;
    return;
  }

  const { short, long } = _sgPeriods();
  if (!_sgCache) {
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Fetching ${SG_YEARS} years of history for ${hold.length} holdings… (first scan only)</div>`;
    const seriesMap = {};
    for (let i = 0; i < hold.length; i += 6) {        // small batches, same as the risk card
      const batch = hold.slice(i, i + 6);
      const got = await Promise.all(batch.map(h => _bmFetchIndex(h.sym, SG_YEARS).catch(() => null)));
      got.forEach((s, j) => { if (Array.isArray(s) && s.length > long + 2) seriesMap[batch[j].key] = s; });
    }
    _sgCache = { seriesMap };
  }
  const seriesMap = _sgCache.seriesMap;

  const rows = hold.map(h => {
    const series = seriesMap[h.key];
    if (!series) return { key: h.key, missing: true };
    return {
      key: h.key,
      signal: _sgLatestCrossover(series, short, long),
      bt: _sgBacktest(series, short, long),
      last: series[series.length - 1],
    };
  });
  renderSignalRows(rows, short, long);
}

function renderSignalRows(rows, short, long) {
  const el = document.getElementById('sg-results');
  if (!el) return;
  const ranked = _sgRankByRecency(rows.filter(r => !r.missing));
  const missing = rows.filter(r => r.missing);

  if (!ranked.length) {
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Couldn't fetch usable history for any holding just now. Try Scan again.</div>`;
    return;
  }

  const fired = ranked.filter(r => r.signal);
  const recent = fired.filter(r => r.signal.barsAgo <= 5).length;

  const body = ranked.map(r => {
    const s = r.signal, bt = r.bt;
    if (!s) {
      return `<tr><td class="tn">${r.key}</td><td colspan="6" style="color:var(--T3);font-size:11.5px">no crossover in this window</td></tr>`;
    }
    const bull = s.type === 'bullish';
    const col = bull ? 'var(--G)' : 'var(--R)';
    const fresh = s.barsAgo <= 5;
    // The comparison that matters is the rule against doing nothing, so it is
    // coloured on the difference, not on whether the rule made money.
    const beat = (bt && bt.stratRet != null && bt.buyHold != null) ? bt.stratRet - bt.buyHold : null;
    return `<tr${fresh ? ' style="background:var(--BL)"' : ''}>
      <td class="tn">${r.key}</td>
      <td style="color:${col};font-weight:700">${bull ? '▲ Bullish' : '▼ Bearish'}</td>
      <td class="tm">${s.date}</td>
      <td class="r tm">${s.barsAgo === 0 ? 'today' : s.barsAgo + ' bar' + (s.barsAgo === 1 ? '' : 's')}</td>
      <td class="r tm">${s.close.toFixed(2)}</td>
      <td class="r tm">${bt && bt.nTrades ? bt.nTrades + ' · ' + bt.winRate.toFixed(0) + '%' : '-'}</td>
      <td class="r tm" style="color:${beat == null ? 'var(--T3)' : beat >= 0 ? 'var(--G)' : 'var(--R)'};font-weight:600">${
        bt && bt.stratRet != null ? _sgFmtPct(bt.stratRet, 0) + ' vs ' + _sgFmtPct(bt.buyHold, 0) : '-'}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="font-size:12.5px;color:var(--T2);margin-bottom:10px">
      Scanned <b>${ranked.length}</b> holdings on the <b>${short}/${long}</b> SMA crossover.
      ${recent ? `<b style="color:var(--P)">${recent}</b> crossed in the last 5 bars.` : 'None crossed in the last 5 bars.'}
      ${missing.length ? ` <span style="color:var(--T3)">(${missing.length} had no usable history)</span>` : ''}
    </div>
    <div class="ts"><table style="min-width:680px">
      <thead><tr>
        <th>Holding</th><th>Signal</th><th>Crossed</th><th class="r">Age</th>
        <th class="r">Close</th><th class="r" title="How many times this rule fired on this stock, and how many of those trades closed in profit">Trades · Win</th>
        <th class="r" title="What following every signal returned, against simply holding the stock over the same period">Rule vs Hold</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div style="font-size:11px;color:var(--T3);margin-top:10px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
      The backtest replays this rule over ${SG_YEARS} years, buying on the bar <i>after</i> a bullish
      crossover confirms and selling on the bar after a bearish one - never at the crossing close
      itself, which you could not have traded at. It ignores brokerage, STT and slippage, so a real
      account would do somewhat worse than shown. <b>"Rule vs Hold" is the number to read</b>: a rule
      that trades a lot and still trails buy-and-hold is costing you money and attention, however
      good its individual signals look. Past behaviour is not a forecast.
    </div>`;
}

function renderSignals() {
  const el = document.getElementById('sg-results');
  if (!el) return;
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if (!sp) {
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">The scanner needs price history, which comes through the data proxy. Deploy the Worker in <code>proxy/README.md</code> and this fills in automatically.</div>`;
    return;
  }
  el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">Set the two averages above and press Scan.</div>`;
}

// Periods changed: the cached history is still good, only the maths is stale.
function sgRescan() {
  if (_sgCache) scanSignals();
}

// ══════════ DIVERSIFICATION: CORRELATION & EFFECTIVE HOLDINGS ══════════
// Owning twenty stocks is not the same as having twenty bets. If they move
// together, the book behaves like far fewer positions than the count suggests -
// which is exactly when a "diversified" portfolio falls as one.
//
// Two measures, because they answer different questions:
//   Effective holdings (1 / sum of squared weights) - concentration by SIZE.
//     Twenty names with one at 60% behaves like ~3 holdings.
//   Average pairwise correlation - concentration by BEHAVIOUR. Weight-blind:
//     twenty equal names that all move together are still one bet.

// Pearson correlation of two aligned return arrays.
function _dvCorr(xs, ys){
  const n = Math.min(xs.length, ys.length);
  if(n < 20) return null;                       // too short to mean anything
  let mx = 0, my = 0;
  for(let i=0;i<n;i++){ mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let cov = 0, vx = 0, vy = 0;
  for(let i=0;i<n;i++){
    const dx = xs[i]-mx, dy = ys[i]-my;
    cov += dx*dy; vx += dx*dx; vy += dy*dy;
  }
  if(!(vx > 0) || !(vy > 0)) return null;       // a flat series has no correlation
  return cov / Math.sqrt(vx*vy);
}

// Herfindahl-based effective number of holdings from current values.
function _dvEffective(weights){
  const vals = (Array.isArray(weights) ? weights : []).map(Number).filter(v => isFinite(v) && v > 0);
  const tot = vals.reduce((a,b) => a+b, 0);
  if(!(tot > 0) || !vals.length) return null;
  const hhi = vals.reduce((a,v) => a + Math.pow(v/tot, 2), 0);
  return { n: vals.length, effective: 1/hhi, topWeightPct: Math.max(...vals)/tot*100 };
}

// Average pairwise correlation across holdings, plus the most-correlated pairs.
// seriesMap: { name: [{d,c}] }. Returns null when fewer than two holdings have
// enough overlapping history.
function _dvMatrix(seriesMap){
  const names = Object.keys(seriesMap || {});
  if(names.length < 2) return null;
  // Common dates across ALL series, so every pair is measured on the same days.
  let common = null;
  for(const n of names){
    const s = seriesMap[n];
    if(!Array.isArray(s) || s.length < 21) return null;
    const set = new Set(s.map(p => p.d));
    common = common ? new Set([...common].filter(d => set.has(d))) : set;
  }
  const dates = [...(common || [])].sort();
  if(dates.length < 21) return null;
  const rets = {};
  names.forEach(n => {
    const m = {}; seriesMap[n].forEach(p => { m[p.d] = +p.c; });
    const r = [];
    for(let i=1;i<dates.length;i++){
      const p0 = m[dates[i-1]], p1 = m[dates[i]];
      r.push((p0 > 0 && p1 > 0) ? (p1-p0)/p0 : 0);
    }
    rets[n] = r;
  });
  const pairs = [];
  let sum = 0, count = 0;
  for(let i=0;i<names.length;i++){
    for(let j=i+1;j<names.length;j++){
      const c = _dvCorr(rets[names[i]], rets[names[j]]);
      if(c == null) continue;
      pairs.push({ a:names[i], b:names[j], c });
      sum += c; count++;
    }
  }
  if(!count) return null;
  pairs.sort((x,y) => y.c - x.c);
  return { avg: sum/count, pairs, days: dates.length - 1, holdings: names.length };
}

// Plain reading of the average correlation.
function _dvVerdict(avg){
  if(avg == null) return null;
  if(avg >= 0.75) return { word:'Barely diversified', why:'these move almost as one', col:'#D93025' };
  if(avg >= 0.55) return { word:'Lightly diversified', why:'they move together more often than not', col:'#F59E0B' };
  if(avg >= 0.30) return { word:'Reasonably diversified', why:'partly independent', col:'#1A73E8' };
  return { word:'Well diversified', why:'they move largely independently', col:'#00B386' };
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderDiversification(){
  const el = document.getElementById('ana-diversification');
  if(!el) return;
  const hold = (typeof _rkHoldings === 'function') ? _rkHoldings() : [];
  const eff = _dvEffective(hold.map(h => h.weight));
  const tile = (lbl,val,sub,c,tip) => `<div class="tax-sum-box" title="${tip||''}" style="cursor:help">`
    + `<div class="tax-sum-box-lbl">${lbl}</div><div class="tax-sum-box-val" style="color:${c}">${val}</div>`
    + `<div class="tax-sum-box-sub">${sub}</div></div>`;

  // Size concentration needs no price history, so show it either way.
  const effHtml = eff ? tile('Effective holdings', eff.effective.toFixed(1),
      `you hold ${eff.n} · largest is ${eff.topWeightPct.toFixed(0)}%`,
      eff.effective < eff.n/2 ? '#F59E0B' : '#00B386',
      'How many equally-sized holdings your book behaves like. Far below your actual count means a few positions dominate.') : '';

  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if(!sp || !_rkCache){
    el.innerHTML = `<div class="tax-sum-grid">${effHtml}</div>
      <div style="font-size:11px;color:var(--T3);margin-top:8px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
        ${sp ? 'Correlation appears once the Risk &amp; Reward card above has loaded its price history.'
             : 'Correlation needs price history via the data proxy, deploy the Worker in <code>proxy/README.md</code>.'}
      </div>`;
    return;
  }
  const m = _dvMatrix(_rkCache.seriesMap);
  if(!m){
    el.innerHTML = `<div class="tax-sum-grid">${effHtml}</div>
      <div style="font-size:11px;color:var(--T3);margin-top:8px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
        Not enough overlapping history yet to correlate holdings (needs about a month of common trading days across at least two of them).
      </div>`;
    return;
  }
  const v = _dvVerdict(m.avg);
  const top = m.pairs.slice(0,5);
  const rows = top.map(p => `<tr>
      <td class="tn">${p.a}</td><td class="tn">${p.b}</td>
      <td class="r tm" style="color:${p.c>=0.75?'var(--R)':p.c>=0.5?'#F59E0B':'var(--T2)'};font-weight:600">${p.c.toFixed(2)}</td>
    </tr>`).join('');
  el.innerHTML = `<div class="tax-sum-grid">
      ${effHtml}
      ${tile('Average correlation', m.avg.toFixed(2), v ? v.why : '', v ? v.col : 'var(--T3)',
        'How closely your holdings move together on average. 1.00 means identical, 0 means unrelated. High correlation means fewer real bets than the count suggests.')}
      ${tile('Verdict', v ? v.word : '-', `${m.holdings} holdings · ${m.days} days`, v ? v.col : 'var(--T3)',
        'A plain reading of the average correlation.')}
    </div>
    ${rows ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--T3);margin:12px 0 6px">Most closely linked pairs</div>
    <div class="ts"><table style="min-width:420px"><thead><tr><th>Holding</th><th>Holding</th><th class="r">Correlation</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    <div style="font-size:11px;color:var(--T3);margin-top:10px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
      Correlation is measured on daily moves over ${m.days} shared days and is <b>weight-blind</b>, it says nothing about position size, which is what "effective holdings" covers. Past correlation rises in a crash; treat a comfortable number with caution.
    </div>`;
}

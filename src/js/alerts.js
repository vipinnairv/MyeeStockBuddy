// ══════════ PRICE TARGETS & ALERTS ══════════
// The Analyser works out entry/exit levels, but nothing carried that back to
// the actual book: you had to remember which of 34 holdings was near its
// target. Each equity holding can now carry a target and a stop; anything that
// has crossed one is surfaced on the dashboard.
//
// These are levels YOU set. Nothing here predicts a price or fires
// automatically - it reports, in one place, which of your own thresholds
// today's price has crossed.

// One holding -> alert state, or null when no level is set / price unusable.
// Levels are in the holding's own currency, the same units as its LTP.
function _alEvaluate(h){
  if(!h) return null;
  const ltp = +h.ltp;
  if(!isFinite(ltp) || ltp <= 0) return null;              // no price, no claim
  const tgt = +h.target, stop = +h.stop;
  const hasT = isFinite(tgt) && tgt > 0;
  const hasS = isFinite(stop) && stop > 0;
  if(!hasT && !hasS) return null;
  const out = { name:h.name, ticker:h.ticker, ltp, target:hasT?tgt:null, stop:hasS?stop:null,
                hit:null, distPct:null };
  if(hasT && ltp >= tgt){
    out.hit = 'target';
    out.distPct = (ltp - tgt) / tgt * 100;
  } else if(hasS && ltp <= stop){
    out.hit = 'stop';
    out.distPct = (stop - ltp) / stop * 100;
  } else if(hasT){
    out.distPct = (tgt - ltp) / ltp * 100;                 // how far still to go
  } else if(hasS){
    out.distPct = (ltp - stop) / ltp * 100;                // headroom above the stop
  }
  return out;
}

// Scan the equity book. Returns { hits, watching } - hits first, nearest-first.
function _alScan(indEQ, usEQ){
  const rows = [];
  const add = (list, cls) => (Array.isArray(list) ? list : []).forEach(h => {
    const a = _alEvaluate(h);
    if(a){ a.cls = cls; rows.push(a); }
  });
  add(indEQ, 'India EQ'); add(usEQ, 'US EQ');
  const hits = rows.filter(r => r.hit).sort((a,b) => (b.distPct||0) - (a.distPct||0));
  const watching = rows.filter(r => !r.hit)
                       .sort((a,b) => Math.abs(a.distPct||1e9) - Math.abs(b.distPct||1e9));
  return { hits, watching };
}

function renderAlerts(){
  const host = document.getElementById('alerts-host');
  if(!host) return;
  const { hits, watching } = _alScan(S.indEQ, S.usEQ);
  if(!hits.length){
    // Nothing crossed. Say so, and show the closest few so the panel is useful
    // rather than empty - but never imply an alert that has not happened.
    if(!watching.length){ host.innerHTML = ''; return; }
    const near = watching.slice(0,3).map(r =>
      `<span style="white-space:nowrap"><b>${r.name}</b> ${r.target?`→ ${F.inr(r.target)}`:`↓ ${F.inr(r.stop)}`} (${Math.abs(r.distPct).toFixed(1)}% away)</span>`
    ).join(' · ');
    host.innerHTML = `<div style="margin:0 0 14px;background:var(--BL);border:1px solid var(--bd);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--T2)">
      🎯 <b>No targets hit.</b> Closest: ${near}</div>`;
    return;
  }
  const row = r => {
    const isT = r.hit === 'target';
    return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 0;border-top:1px solid rgba(0,0,0,.06)">
      <span style="font-size:15px">${isT?'🎯':'🛑'}</span>
      <b style="font-size:13px">${r.name}</b>
      <span style="font-size:11px;color:var(--T3)">${r.cls}</span>
      <span style="font-size:12px;color:${isT?'#00B386':'#D93025'};font-weight:700">
        ${isT?'Target hit':'Stop breached'}, ${F.inr(r.ltp)} vs ${F.inr(isT?r.target:r.stop)}
        (${r.distPct>=0?'+':''}${r.distPct.toFixed(1)}%)
      </span>
    </div>`;
  };
  host.innerHTML = `<div style="margin:0 0 14px;background:var(--AUL,#FEF3C7);border:1px solid var(--AU,#F59E0B);border-radius:10px;padding:11px 14px">
    <div style="font-size:13px;font-weight:800;color:var(--T1)">🔔 ${hits.length} holding${hits.length===1?'':'s'} crossed a level you set</div>
    ${hits.map(row).join('')}
    <div style="font-size:11px;color:var(--T3);margin-top:8px">These are your own target/stop levels, checked against the latest fetched price, not advice, and not automatic orders.</div>
  </div>`;
}

// ══════════ PORTFOLIO GROWTH HISTORY ══════════
// The app only ever knew today's value, so there was no way to see the journey:
// no growth curve, no peak, no drawdown. This records one value snapshot per
// day in localStorage and charts it. It is a forward-looking record - it cannot
// reconstruct history that was never captured, and it does not pretend to:
// the chart says how many days it has been collecting.

const _GH_KEY = 'pf_value_history';
const _GH_MAX = 1825;                  // ~5 years of daily points

function _ghLoad(){
  try {
    const v = JSON.parse(localStorage.getItem(_GH_KEY) || '[]');
    return Array.isArray(v) ? v.filter(p => p && p.d && isFinite(+p.v)) : [];
  } catch(e) { return []; }
}
function _ghSave(list){
  try { localStorage.setItem(_GH_KEY, JSON.stringify(list.slice(-_GH_MAX))); } catch(e) {}
}

// One point per calendar day: a later reading on the same day replaces the
// earlier one, so the series is end-of-day rather than whatever time you
// happened to open the app.
function _ghUpsert(list, day, value, invested){
  const v = +value, inv = +invested;
  if(!day || !isFinite(v) || v <= 0) return list;          // never record a zero/garbage day
  const out = Array.isArray(list) ? list.slice() : [];
  const i = out.findIndex(p => p.d === day);
  const point = { d:day, v:+v.toFixed(2), i: isFinite(inv) && inv > 0 ? +inv.toFixed(2) : undefined };
  if(i >= 0) out[i] = point; else out.push(point);
  out.sort((a,b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  return out;
}

// Peak, current drawdown and worst drawdown across the recorded series.
function _ghStats(list){
  const pts = (Array.isArray(list) ? list : []).filter(p => isFinite(+p.v) && +p.v > 0);
  if(!pts.length) return null;
  let peak = 0, peakDate = null, maxDD = 0, maxDDDate = null;
  pts.forEach(p => {
    const v = +p.v;
    if(v > peak){ peak = v; peakDate = p.d; }
    if(peak > 0){
      const dd = (peak - v) / peak * 100;
      if(dd > maxDD){ maxDD = dd; maxDDDate = p.d; }
    }
  });
  const first = +pts[0].v, last = +pts[pts.length-1].v;
  return {
    days: pts.length, first, last, firstDate: pts[0].d, lastDate: pts[pts.length-1].d,
    peak, peakDate, maxDD, maxDDDate,
    currentDD: peak > 0 ? (peak - last) / peak * 100 : 0,
    change: first > 0 ? (last - first) / first * 100 : null,
  };
}

// Record today's value. Called after any save so the series builds itself.
function ghRecordToday(){
  try {
    if(typeof grand !== 'function') return;
    const g = grand();
    const day = new Date().toISOString().slice(0,10);
    _ghSave(_ghUpsert(_ghLoad(), day, g.totC, g.totI));
  } catch(e) {}
}

function renderGrowth(){
  const el = document.getElementById('ana-growth');
  if(!el) return;
  const list = _ghLoad();
  const st = _ghStats(list);
  if(!st || st.days < 2){
    el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">
      📈 Building your growth history — <b>${st ? st.days : 0}</b> day${(st&&st.days===1)?'':'s'} recorded so far.
      A point is saved each day you open the app; the curve appears from the second day.
      <div style="margin-top:5px;font-size:11.5px">This is a forward record: it can't reconstruct value from before tracking began.</div>
    </div>`;
    return;
  }
  const tile = (lbl,val,sub,c) => `<div class="tax-sum-box"><div class="tax-sum-box-lbl">${lbl}</div>`
    + `<div class="tax-sum-box-val" style="color:${c}">${val}</div><div class="tax-sum-box-sub">${sub}</div></div>`;
  const w = 640, h = 150, pad = 4;
  const vals = list.map(p => +p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
  const pts = list.map((p,i) => {
    const x = pad + (i / Math.max(1, list.length - 1)) * (w - pad*2);
    const y = pad + (1 - ((+p.v - lo) / span)) * (h - pad*2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = st.last >= st.first;
  const col = up ? '#00B386' : '#D93025';
  el.innerHTML = `<div class="tax-sum-grid" style="margin-bottom:12px">
    ${tile('Since tracking began', (st.change>=0?'+':'')+st.change.toFixed(2)+'%', `${st.days} days · from ${st.firstDate}`, col)}
    ${tile('Peak value', F.lac(st.peak), 'on '+st.peakDate, '#1A73E8')}
    ${tile('Worst drawdown', '-'+st.maxDD.toFixed(1)+'%', st.maxDDDate ? 'on '+st.maxDDDate : '—', '#D93025')}
    ${tile('From peak now', st.currentDD<=0.005?'At peak':'-'+st.currentDD.toFixed(1)+'%', 'current value '+F.lac(st.last), st.currentDD<=0.005?'#00B386':'#F59E0B')}
  </div>
  <div style="overflow-x:auto">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:150px;display:block">
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
  </div>
  <div style="font-size:11px;color:var(--T3);margin-top:8px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
    One point per day, recorded locally as you use the app. Range ${F.lac(lo)} – ${F.lac(hi)}. Days you don't open the app leave no point.
  </div>`;
}

// ══════════ REBALANCING & CONCENTRATION ══════════
// A portfolio drifts: winners grow into an outsized share and the mix you chose
// quietly becomes a mix you did not. This compares your target allocation
// against reality, sizes the drift in rupees, and flags any single holding or
// sector that has grown past a limit you set.
//
// Targets are yours; nothing here is a recommendation to trade.

const _RB_KEY = 'rebalance_targets';   // { indEQ:%, usEQ:%, crypto:%, mf:%, fd:% }
const _RB_CLASSES = [
  ['indEQ','India Equity'], ['usEQ','US Equity'], ['crypto','Crypto'],
  ['mf','Mutual Funds'], ['fd','FD / Bonds'],
];

function rbLoadTargets(){
  try { const o = JSON.parse(localStorage.getItem(_RB_KEY) || 'null');
        return (o && typeof o === 'object') ? o : null; } catch(e) { return null; }
}
function rbSaveTargets(o){ try { localStorage.setItem(_RB_KEY, JSON.stringify(o)); } catch(e) {} }

// Compare actual against target. Percentages are of the whole book.
// Classes with no target set are reported as untargeted rather than assumed 0 -
// treating an unset target as "should be zero" would demand selling everything
// the user simply had not configured yet.
function _rbDrift(actualByClass, targets){
  const act = actualByClass || {};
  const tgt = targets || {};
  const total = Object.keys(act).reduce((s,k) => s + (+act[k] || 0), 0);
  if(!(total > 0)) return null;
  const rows = [];
  let targetedPct = 0;
  _RB_CLASSES.forEach(([key,label]) => {
    const value = +act[key] || 0;
    const actualPct = value / total * 100;
    const hasTarget = isFinite(+tgt[key]) && +tgt[key] >= 0 && tgt[key] !== '' && tgt[key] != null;
    const targetPct = hasTarget ? +tgt[key] : null;
    if(hasTarget) targetedPct += targetPct;
    rows.push({
      key, label, value, actualPct, targetPct, hasTarget,
      driftPct: hasTarget ? actualPct - targetPct : null,
      driftValue: hasTarget ? value - (targetPct/100 * total) : null,
    });
  });
  return {
    total, rows, targetedPct,
    anyTarget: rows.some(r => r.hasTarget),
    // A target set that does not add to 100 cannot be acted on coherently.
    targetsSumOk: !rows.some(r => r.hasTarget) || Math.abs(targetedPct - 100) < 0.5,
  };
}

// Holdings or sectors that exceed a concentration limit.
function _rbConcentration(items, limitPct){
  const lim = isFinite(+limitPct) && +limitPct > 0 ? +limitPct : 15;
  const list = (Array.isArray(items) ? items : []).filter(x => isFinite(+x.value) && +x.value > 0);
  const total = list.reduce((s,x) => s + (+x.value), 0);
  if(!(total > 0)) return null;
  const rows = list.map(x => ({ name:x.name, value:+x.value, pct:+x.value/total*100 }))
                   .sort((a,b) => b.pct - a.pct);
  return { limit: lim, rows, breaches: rows.filter(r => r.pct > lim), total,
           top5Pct: rows.slice(0,5).reduce((s,r) => s + r.pct, 0) };
}

// ── Render ─────────────────────────────────────────────────────────────────
function rbSetTarget(key, val){
  const t = rbLoadTargets() || {};
  const v = parseFloat(val);
  if(val === '' || isNaN(v) || v < 0) delete t[key]; else t[key] = Math.min(100, v);
  rbSaveTargets(t);
  renderRebalance();
}
function rbSetLimit(val){
  const t = rbLoadTargets() || {};
  const v = parseFloat(val);
  t._limit = (isNaN(v) || v <= 0) ? 15 : Math.min(100, v);
  rbSaveTargets(t);
  renderRebalance();
}

function renderRebalance(){
  const el = document.getElementById('ana-rebalance');
  if(!el) return;
  let g; try { g = grand(); } catch(e) { return; }
  const actual = { indEQ:g.iC, usEQ:g.uC, crypto:g.crC, mf:g.mfC, fd:g.fdC };
  const targets = rbLoadTargets() || {};
  const d = _rbDrift(actual, targets);
  if(!d){ el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">No holdings to rebalance yet.</div>`; return; }

  const rows = d.rows.map(r => {
    const over = r.driftPct != null && r.driftPct > 0;
    const col = r.driftPct == null ? 'var(--T3)' : Math.abs(r.driftPct) < 2 ? '#00B386' : over ? '#F59E0B' : '#1A73E8';
    return `<tr>
      <td class="tn">${r.label}</td>
      <td class="r tm">${r.actualPct.toFixed(1)}%</td>
      <td class="r"><input type="number" min="0" max="100" step="any" value="${r.hasTarget ? r.targetPct : ''}"
          placeholder="—" onchange="rbSetTarget('${r.key}', this.value)"
          style="width:74px;text-align:right;padding:4px 7px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--T1);font-size:12px"></td>
      <td class="r tm" style="color:${col};font-weight:600">${r.driftPct == null ? '—' : (r.driftPct>=0?'+':'')+r.driftPct.toFixed(1)+'%'}</td>
      <td class="r tm" style="color:${col}">${r.driftValue == null ? '—'
          : (r.driftValue>=0 ? 'trim '+F.inr(r.driftValue) : 'add '+F.inr(Math.abs(r.driftValue)))}</td>
    </tr>`;
  }).join('');

  // Single-holding concentration across the equity book.
  const items = [];
  try {
    (S.indEQ||[]).forEach(h => items.push({ name:h.name, value:cIND(h).cur }));
    (S.usEQ||[]).forEach(h => items.push({ name:h.name, value:cUS(h).cur }));
  } catch(e) {}
  const lim = isFinite(+targets._limit) ? +targets._limit : 15;
  const conc = _rbConcentration(items, lim);

  el.innerHTML = `<div class="ts"><table style="min-width:560px">
      <thead><tr><th>Asset class</th><th class="r">Actual</th><th class="r">Target %</th><th class="r">Drift</th><th class="r">To reach target</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${d.anyTarget && !d.targetsSumOk ? `<div style="font-size:12px;color:var(--T1);margin-top:10px;padding:10px 13px;background:var(--RL);border-radius:var(--r3);border-left:3px solid var(--R)">
      ⚠️ Your targets add up to <b>${d.targetedPct.toFixed(1)}%</b>, not 100%. The drift figures are still shown, but they cannot all be satisfied at once until the targets balance.
    </div>` : ''}
    ${!d.anyTarget ? `<div style="font-size:12px;color:var(--T3);margin-top:10px">Set a target % against any class to see drift. Classes left blank are simply untargeted — they are not treated as "should be zero".</div>` : ''}
    ${conc ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--T3);margin:16px 0 6px">
        Single-holding concentration · limit
        <input type="number" min="1" max="100" step="any" value="${lim}" onchange="rbSetLimit(this.value)"
          style="width:64px;text-align:right;padding:3px 6px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--T1);font-size:12px">%
      </div>
      ${conc.breaches.length ? `<div style="font-size:12.5px;color:var(--T1);padding:10px 13px;background:var(--AUL,#FEF3C7);border:1px solid var(--AU,#F59E0B);border-radius:var(--r3)">
          <b>${conc.breaches.length} holding${conc.breaches.length===1?'':'s'} above ${lim}% of your equity book:</b>
          ${conc.breaches.map(b=>`${b.name} <b>${b.pct.toFixed(1)}%</b>`).join(' · ')}
        </div>`
        : `<div style="font-size:12.5px;color:var(--T2)">No single holding exceeds ${lim}% of the equity book. Top 5 together are ${conc.top5Pct.toFixed(1)}%.</div>`}` : ''}
    <div style="font-size:11px;color:var(--T3);margin-top:10px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
      Targets and the limit are yours and stay on this device. "To reach target" is arithmetic on today's values, not advice — and rebalancing realises gains, which is taxable. Check the Taxation tab before acting.
    </div>`;
}

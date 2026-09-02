// ══════════ RETURN ATTRIBUTION & TAX-LOSS HARVESTING ══════════
// Two questions a portfolio review always answers and this app could not:
//   1. WHICH holdings produced the return? "+18% overall" hides that two names
//      carried the book and five lost money. Contribution splits the total P&L
//      by holding, in rupees and as a share of the whole.
//   2. WHAT can I book before year end? Unrealised losses can offset realised
//      gains, and the Rs 1.25 lakh LTCG exemption is use-it-or-lose-it. Both
//      are invisible until you go looking, usually too late in March.
// Pure functions over lots; the glue reads S separately.

// lots: [{ name, invested, current, dividend, buyDate, cls }] all in INR.
// Contribution is measured against TOTAL INVESTED, so the parts sum to the
// portfolio's own return - the only definition that makes the shares add up.
function _atContribution(lots){
  const rows = [];
  let invested = 0, current = 0, income = 0;
  (Array.isArray(lots) ? lots : []).forEach(l => {
    const inv = +l.invested, cur = +l.current;
    if(!isFinite(inv) || inv <= 0 || !isFinite(cur)) return;   // unpriceable: no claim
    const div = isFinite(+l.dividend) && +l.dividend > 0 ? +l.dividend : 0;
    const pl = (cur - inv) + div;
    invested += inv; current += cur; income += div;
    rows.push({ name:l.name || '—', cls:l.cls || '', invested:inv, current:cur,
                dividend:div, pl, retPct: inv > 0 ? pl / inv * 100 : null });
  });
  if(!rows.length) return null;
  const totalPL = (current - invested) + income;
  // Share of the total move. When winners and losers offset, the denominator
  // can be tiny or zero - reporting a share then is meaningless, so we don't.
  const denom = Math.abs(totalPL);
  rows.forEach(r => { r.sharePct = denom > 1e-9 ? r.pl / totalPL * 100 : null; });
  rows.sort((a,b) => b.pl - a.pl);
  return {
    rows, invested, current, income, totalPL,
    totalRetPct: invested > 0 ? totalPL / invested * 100 : null,
    winners: rows.filter(r => r.pl > 0), losers: rows.filter(r => r.pl < 0),
    shareMeaningful: denom > 1e-9,
  };
}

// Unrealised losses that could be booked, largest first, against the gains
// already realised this financial year.
function _atHarvest(lots, realisedLTCG, realisedSTCG, exemption){
  const ex = isFinite(+exemption) ? +exemption : 125000;
  const cand = (Array.isArray(lots) ? lots : []).map(l => {
    const inv = +l.invested, cur = +l.current;
    if(!isFinite(inv) || inv <= 0 || !isFinite(cur)) return null;
    const loss = inv - cur;                       // positive when under water
    return loss > 0 ? { name:l.name || '—', cls:l.cls || '', invested:inv, current:cur,
                        loss, lossPct: loss / inv * 100 } : null;
  }).filter(Boolean).sort((a,b) => b.loss - a.loss);

  const totalLoss = cand.reduce((a,r) => a + r.loss, 0);
  const ltcg = isFinite(+realisedLTCG) ? +realisedLTCG : 0;
  const stcg = isFinite(+realisedSTCG) ? +realisedSTCG : 0;
  // The exemption absorbs long-term gains first; only what is left is worth
  // offsetting with a booked loss.
  const ltcgAfterExempt = Math.max(0, ltcg - ex);
  const offsettable = ltcgAfterExempt + Math.max(0, stcg);
  return {
    candidates: cand, totalLoss,
    realisedLTCG: ltcg, realisedSTCG: stcg,
    exemption: ex,
    exemptionUsed: Math.min(Math.max(0, ltcg), ex),
    exemptionLeft: Math.max(0, ex - Math.max(0, ltcg)),
    offsettable,
    usefulLoss: Math.min(totalLoss, offsettable),   // booking beyond this offsets nothing this year
  };
}

// ── Glue + rendering ───────────────────────────────────────────────────────
// Lots carry a name and class so the tables can identify holdings.
function _atLots(){
  const out = [];
  try {
    (S.indEQ||[]).forEach(h => { const c = cIND(h);
      out.push({ name:h.name, cls:'India EQ', invested:c.inv, current:c.cur, dividend:+h.div||0 }); });
    (S.usEQ||[]).forEach(h => { const c = cUS(h);
      out.push({ name:h.name, cls:'US EQ', invested:c.inv, current:c.cur, dividend:(+h.div||0)*(S.usdInr||1) }); });
    (S.crypto||[]).forEach(c => { const v = cCRY(c);
      out.push({ name:c.coin, cls:'Crypto', invested:+c.invested||0, current:v.cur, dividend:0 }); });
    (S.mf||[]).forEach(f => { const cv = cMF(f);
      out.push({ name:f.name, cls:'MF', invested:cv.inv, current:cv.cur, dividend:0 }); });
  } catch(e) {}
  return out;
}

// Realised equity gains this FY, reusing the FIFO matcher so the harvesting
// panel and the Taxation tab can never disagree.
function _atRealisedThisFY(){
  try {
    if(typeof fifoMatchSells !== 'function' || typeof taxPeriodFromUI !== 'function') return { ltcg:0, stcg:0 };
    // Same resolver the Taxation tab uses, so the two can never disagree about
    // which period "realised this year" refers to.
    const p = taxPeriodFromUI();
    if(p.error) return { ltcg:0, stcg:0 };
    const a = p.start, b = p.end;
    const m = fifoMatchSells(S.txns||[]).matched.filter(r => {
      const d = new Date(r.date);
      return d >= a && d <= b && (r.cls==='India EQ'||r.cls==='US EQ'||r.cls==='MF');
    });
    return {
      ltcg: m.filter(r=>r.isLTCG).reduce((s,r)=>s+r.gain,0),
      stcg: m.filter(r=>!r.isLTCG).reduce((s,r)=>s+r.gain,0),
    };
  } catch(e) { return { ltcg:0, stcg:0 }; }
}

function renderAttribution(){
  const el = document.getElementById('ana-attribution');
  if(!el) return;
  const a = _atContribution(_atLots());
  if(!a){ el.innerHTML = `<div style="font-size:12.5px;color:var(--T3);padding:10px 0">No priced holdings yet.</div>`; return; }
  const pos = a.totalPL >= 0;
  const bar = r => {
    const share = a.shareMeaningful ? Math.abs(r.sharePct) : 0;
    const w = Math.max(1, Math.min(100, share));
    const col = r.pl >= 0 ? '#00B386' : '#D93025';
    return `<div class="ab-item">
      <div class="ab-row">
        <span class="ab-name">${r.name} <span style="font-size:10px;color:var(--T3)">${r.cls}</span></span>
        <span class="ab-pct" style="color:${col}">${r.pl>=0?'+':'-'}${F.inr(Math.abs(r.pl))}${a.shareMeaningful?` · ${r.sharePct>=0?'+':''}${r.sharePct.toFixed(0)}%`:''}</span>
      </div>
      <div class="ab-track"><div class="ab-fill" style="width:${w.toFixed(1)}%;background:${col}"></div></div>
    </div>`;
  };
  const top = a.rows.slice(0,5), bottom = a.rows.slice(-5).filter(r => r.pl < 0).reverse();
  el.innerHTML = `<div class="tax-sum-grid" style="margin-bottom:12px">
      <div class="tax-sum-box"><div class="tax-sum-box-lbl">Total P&amp;L</div>
        <div class="tax-sum-box-val" style="color:${pos?'#00B386':'#D93025'}">${pos?'+':'-'}${F.inr(Math.abs(a.totalPL))}</div>
        <div class="tax-sum-box-sub">${a.totalRetPct==null?'':(a.totalRetPct>=0?'+':'')+a.totalRetPct.toFixed(2)+'% on cost'}</div></div>
      <div class="tax-sum-box"><div class="tax-sum-box-lbl">Winners</div>
        <div class="tax-sum-box-val" style="color:#00B386">${a.winners.length}</div>
        <div class="tax-sum-box-sub">of ${a.rows.length} holdings</div></div>
      <div class="tax-sum-box"><div class="tax-sum-box-lbl">Losers</div>
        <div class="tax-sum-box-val" style="color:#D93025">${a.losers.length}</div>
        <div class="tax-sum-box-sub">${a.losers.length?'costing '+F.inr(Math.abs(a.losers.reduce((s,r)=>s+r.pl,0))):'none'}</div></div>
    </div>
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--T3);margin:4px 0 8px">Biggest contributors</div>
    ${top.map(bar).join('')}
    ${bottom.length?`<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--T3);margin:14px 0 8px">Biggest drags</div>${bottom.map(bar).join('')}`:''}
    <div style="font-size:11px;color:var(--T3);margin-top:10px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
      Rupee figures are profit or loss including dividends. ${a.shareMeaningful
        ? 'Percentages are each holding\'s share of the total move, so they sum to 100%.'
        : 'Winners and losers almost cancel out, so a "share of total" would be meaningless here and is omitted.'}
    </div>`;
}

function renderHarvest(){
  const el = document.getElementById('ana-harvest');
  if(!el) return;
  const r = _atRealisedThisFY();
  const h = _atHarvest(_atLots(), r.ltcg, r.stcg);
  const tile = (lbl,val,sub,c) => `<div class="tax-sum-box"><div class="tax-sum-box-lbl">${lbl}</div>`
    + `<div class="tax-sum-box-val" style="color:${c}">${val}</div><div class="tax-sum-box-sub">${sub}</div></div>`;
  const rows = h.candidates.slice(0,8).map(c => `<tr>
      <td class="tn">${c.name}</td><td style="font-size:11px;color:var(--T3)">${c.cls}</td>
      <td class="r tm">${F.inr(c.invested)}</td><td class="r tm">${F.inr(c.current)}</td>
      <td class="r tm" style="color:var(--R);font-weight:600">-${F.inr(c.loss)}</td>
      <td class="r" style="font-size:11.5px;color:var(--R)">-${c.lossPct.toFixed(1)}%</td>
    </tr>`).join('');
  el.innerHTML = `<div class="tax-sum-grid" style="margin-bottom:12px">
      ${tile('Unrealised losses', h.totalLoss>0?F.inr(h.totalLoss):'—',
             h.candidates.length?h.candidates.length+' holding'+(h.candidates.length===1?'':'s')+' under water':'nothing at a loss',
             h.totalLoss>0?'#D93025':'#00B386')}
      ${tile('Gains to offset', h.offsettable>0?F.inr(h.offsettable):'—',
             h.offsettable>0?'realised, after exemption':'none booked yet this FY','#1A73E8')}
      ${tile('₹1.25L exemption left', F.inr(h.exemptionLeft),
             h.exemptionUsed>0?F.inr(h.exemptionUsed)+' used':'none used yet','#F59E0B')}
      ${tile('Worth booking', h.usefulLoss>0?F.inr(h.usefulLoss):'—',
             h.usefulLoss>0?'offsets tax this year':'no gains to offset', h.usefulLoss>0?'#7C3AED':'var(--T3)')}
    </div>
    ${rows?`<div class="ts"><table style="min-width:560px"><thead><tr><th>Holding</th><th>Class</th><th class="r">Invested</th><th class="r">Now</th><th class="r">Unrealised loss</th><th class="r">%</th></tr></thead><tbody>${rows}</tbody></table></div>`
          :`<div style="font-size:12.5px;color:var(--T3);padding:6px 0">No holdings are currently at a loss.</div>`}
    <div style="font-size:11px;color:var(--T3);margin-top:10px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
      These are <b>unrealised</b> losses — nothing is booked until you actually sell and record the transaction.
      "Worth booking" is capped at the gains you have already realised this year, because a loss beyond that offsets nothing now.
      Selling purely for tax has real costs (spread, brokerage, and being out of the position) — check with your CA.
    </div>`;
}

// ══════════ ESTIMATED TAX IF SOLD TODAY ══════════
// The Taxation tab only reported gains already booked. The question an investor
// actually asks before selling is "what would this cost me in tax if I sold
// now?" - which needs unrealised gains classified by holding period and priced
// at today's value.
//
// One honest limitation, surfaced in the UI: the app stores ONE average cost
// and ONE purchase date per holding, not individual lots. Real tax on a sale is
// FIFO across lots, so a position built over several purchases is estimated
// from its average. Where a holding has no purchase date at all it cannot be
// classified long or short term, and is excluded rather than guessed.

function _ifSoldRows(lots, asOf, ltDays){
  const LT = isFinite(+ltDays) ? +ltDays : 365;
  const rows = [], undated = [];
  (Array.isArray(lots) ? lots : []).forEach(l => {
    const inv = +l.invested, cur = +l.current;
    if(!isFinite(inv) || inv <= 0 || !isFinite(cur)) return;
    const d = l.buyDate ? new Date(l.buyDate) : null;
    if(!d || isNaN(d.getTime()) || d > asOf){
      undated.push({ name:l.name || '—', cls:l.cls || '', gain:cur - inv });
      return;                                        // cannot be classified: excluded
    }
    const days = Math.round((asOf - d) / 864e5);
    rows.push({ name:l.name || '—', cls:l.cls || '', invested:inv, current:cur,
                gain:cur - inv, holdingDays:days, isLTCG: days > LT });
  });
  return { rows, undated };
}

// Aggregate to an estimated liability. Equity uses the LTCG exemption; crypto
// (VDA) is taxed on gains only with no set-off and no exemption.
function _ifSoldTax(lots, asOf, rules){
  const R = Object.assign({ ltcgExempt:125000, ltcgRate:0.125, stcgRate:0.20,
                            vdaRate:0.30, ltDays:365 }, rules || {});
  const { rows, undated } = _ifSoldRows(lots, asOf, R.ltDays);
  const isVda = r => r.cls === 'Crypto';
  const eq = rows.filter(r => !isVda(r));
  const vda = rows.filter(isVda);

  const ltcgTotal = eq.filter(r => r.isLTCG).reduce((s,r) => s + r.gain, 0);
  const stcgTotal = eq.filter(r => !r.isLTCG).reduce((s,r) => s + r.gain, 0);
  const ltcgTaxable = Math.max(0, ltcgTotal - R.ltcgExempt);
  const stcgTaxable = Math.max(0, stcgTotal);
  const ltcgTax = ltcgTaxable * R.ltcgRate;
  const stcgTax = stcgTaxable * R.stcgRate;
  // VDA losses cannot be set off against VDA gains, so only gains are taxed.
  const vdaGain = vda.reduce((s,r) => s + (r.gain > 0 ? r.gain : 0), 0);
  const vdaTax = vdaGain * R.vdaRate;

  const total = ltcgTax + stcgTax + vdaTax;
  return {
    rows, undated,
    ltcgTotal, stcgTotal, ltcgTaxable, stcgTaxable, ltcgTax, stcgTax,
    vdaGain, vdaTax, total, cess: total * 0.04, totalWithCess: total * 1.04,
    exemption: R.ltcgExempt,
    ltcgRatePct: R.ltcgRate * 100, stcgRatePct: R.stcgRate * 100, vdaRatePct: R.vdaRate * 100,
    grossGain: rows.reduce((s,r) => s + r.gain, 0),
  };
}

function renderIfSold(){
  const el = document.getElementById('tax-ifsold');
  if(!el) return;
  // Built directly from S rather than reusing _atLots, because the holding
  // period - and therefore the whole LTCG/STCG split - needs the purchase date.
  const lots = [];
  try {
    (S.indEQ||[]).forEach(h => { const c = cIND(h); lots.push({ name:h.name, cls:'India EQ', invested:c.inv, current:c.cur, buyDate:h.buyDate }); });
    (S.usEQ||[]).forEach(h => { const c = cUS(h); lots.push({ name:h.name, cls:'US EQ', invested:c.inv, current:c.cur, buyDate:h.buyDate }); });
    (S.crypto||[]).forEach(c => { const v = cCRY(c); lots.push({ name:c.coin, cls:'Crypto', invested:+c.invested||0, current:v.cur, buyDate:c.buyDate }); });
    (S.mf||[]).forEach(f => { const cv = cMF(f); lots.push({ name:f.name, cls:'MF', invested:cv.inv, current:cv.cur, buyDate:f.startDate }); });
  } catch(e) {}
  const r = _ifSoldTax(lots, new Date());
  const tile = (lbl,val,sub,c) => `<div class="tax-sum-box"><div class="tax-sum-box-lbl">${lbl}</div>`
    + `<div class="tax-sum-box-val" style="color:${c}">${val}</div><div class="tax-sum-box-sub">${sub}</div></div>`;
  const body = r.rows.sort((a,b) => b.gain - a.gain).map(x => `<tr>
      <td class="tn">${x.name}</td><td style="font-size:11px;color:var(--T3)">${x.cls}</td>
      <td class="r tm">${F.inr(x.invested)}</td><td class="r tm">${F.inr(x.current)}</td>
      <td class="r tm" style="color:${x.gain>=0?'var(--G)':'var(--R)'};font-weight:600">${x.gain>=0?'+':'-'}${F.inr(Math.abs(x.gain))}</td>
      <td class="r" style="font-size:11px">${x.holdingDays}d</td>
      <td><span class="chip ${x.cls==='Crypto'?'c-sell':x.isLTCG?'c-active':'c-due'}">${x.cls==='Crypto'?'VDA 30%':x.isLTCG?'LTCG':'STCG'}</span></td>
    </tr>`).join('');
  el.innerHTML = `<div class="tax-sum-grid" style="margin-bottom:12px">
      ${tile('Unrealised gain', (r.grossGain>=0?'+':'-')+F.inr(Math.abs(r.grossGain)), 'if everything sold today', r.grossGain>=0?'#00B386':'#D93025')}
      ${tile(`LTCG tax @${r.ltcgRatePct}%`, F.inr(r.ltcgTax), `on ${F.inr(r.ltcgTaxable)} after ₹1.25L exemption`, '#1A73E8')}
      ${tile(`STCG tax @${r.stcgRatePct}%`, F.inr(r.stcgTax), `on ${F.inr(r.stcgTaxable)}`, '#F59E0B')}
      ${tile('Estimated total', F.inr(r.totalWithCess), `${F.inr(r.total)} + 4% cess`, r.total>0?'#D93025':'#00B386')}
    </div>
    ${r.vdaGain>0?`<div style="font-size:12px;color:var(--T2);margin-bottom:10px">Includes crypto (VDA) gains of ${F.inr(r.vdaGain)} taxed at ${r.vdaRatePct}% — losses cannot be set off.</div>`:''}
    ${body?`<div class="ts"><table style="min-width:660px"><thead><tr><th>Holding</th><th>Class</th><th class="r">Invested</th><th class="r">Value now</th><th class="r">Unrealised</th><th class="r">Held</th><th>Category</th></tr></thead><tbody>${body}</tbody></table></div>`
          :`<div style="font-size:12.5px;color:var(--T3);padding:6px 0">No datable holdings to estimate.</div>`}
    ${r.undated.length?`<div style="font-size:12px;color:var(--T1);margin-top:10px;padding:10px 13px;background:var(--RL);border-radius:var(--r3);border-left:3px solid var(--R)">
      ⚠️ <b>${r.undated.length} holding${r.undated.length===1?'':'s'} excluded</b> — no purchase date, so they cannot be classified long or short term. Add a purchase date to include them.
      <div style="margin-top:5px;font-size:11.5px;color:var(--T2)">${r.undated.slice(0,5).map(u=>u.name).join(', ')}${r.undated.length>5?` +${r.undated.length-5} more`:''}</div>
    </div>`:''}
    <div style="font-size:11px;color:var(--T3);margin-top:10px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
      A <b>what-if</b> estimate on today's prices — nothing here is booked. The app stores one average cost and one purchase date per holding, so a position built from several purchases is estimated from its average; actual tax on sale is computed FIFO lot by lot and will differ. Prices move, and so will this. Confirm with your CA before acting.
    </div>`;
}

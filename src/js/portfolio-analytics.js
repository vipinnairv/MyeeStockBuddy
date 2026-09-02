// ══════════ PORTFOLIO INCOME & TRUE RETURN ══════════
// Two things the Portfolio Manager could not answer before:
//   1. "What have I actually earned in dividends?" - the field simply did not
//      exist, so income was invisible and total return was understated.
//   2. "What is my real annualised return?" - only MF SIPs had an XIRR. Absolute
//      return flatters a long hold and punishes a recent one; XIRR is
//      money-weighted, so a 2020 buy and a 2024 buy are compared honestly.
// The functions below are pure (they take lots, not globals) so they can be
// unit-tested; _pmLots() is the only glue that reads S.

// One lot: everything already normalised to INR.
//   { invested, current, buyDate, dividend }
function _pmCashflows(lots, asOf){
  if(!Array.isArray(lots)) return [];
  const usable = lots.filter(l => {
    const inv = +l.invested, cur = +l.current;
    if(!isFinite(inv) || inv <= 0 || !isFinite(cur)) return false;
    const d = l.buyDate ? new Date(l.buyDate) : null;
    return !!d && !isNaN(d.getTime()) && d <= asOf;   // undated or future-dated lots cannot be timed
  });
  if(!usable.length) return [];
  const cf = usable.map(l => ({ date: new Date(l.buyDate), amount: -(+l.invested) }));
  // Dividends are tracked as an annual total, not per payment date, so they are
  // credited at asOf. Money that actually arrived earlier is therefore treated
  // as arriving later, which UNDERSTATES the true XIRR - deliberately conservative.
  const terminal = usable.reduce((s,l) => {
    const div = +l.dividend;
    return s + (+l.current) + (isFinite(div) && div > 0 ? div : 0);
  }, 0);
  cf.push({ date: asOf, amount: terminal });
  cf.sort((a,b) => a.date - b.date);
  return cf;
}

// Money-weighted annualised return across the whole book, as a percent.
function _pmXirr(lots, asOf){
  const cf = _pmCashflows(lots, asOf || new Date());
  if(cf.length < 2) return null;
  try { return xirr(cf); } catch(e) { return null; }
}

// Dividend income and yield on cost (income against what you actually paid,
// not against today's price - that is the number that tells you what the
// position yields you).
function _pmIncome(lots){
  let total = 0, invested = 0, paying = 0;
  (Array.isArray(lots) ? lots : []).forEach(l => {
    const d = +l.dividend, inv = +l.invested;
    if(isFinite(d) && d > 0){ total += d; paying++; }
    if(isFinite(inv) && inv > 0) invested += inv;
  });
  // No recorded dividends means the yield is UNKNOWN, not measured-zero -
  // reporting 0.00% would imply we checked and you earn nothing.
  return { total, invested, paying,
           yieldOnCost: (invested > 0 && total > 0) ? total / invested * 100 : null };
}

// Glue: build the lot list from S, everything converted to INR.
function _pmLots(){
  const out = [];
  try {
    (S.indEQ||[]).forEach(h => { const c = cIND(h);
      out.push({ invested:c.inv, current:c.cur, buyDate:h.buyDate, dividend:+h.div||0, name:h.name }); });
    (S.usEQ||[]).forEach(h => { const c = cUS(h);
      // avgCost/ltp/div for US holdings are in USD; cUS already returns INR.
      out.push({ invested:c.inv, current:c.cur, buyDate:h.buyDate,
                 dividend:(+h.div||0)*(S.usdInr||1), name:h.name }); });
    (S.crypto||[]).forEach(c => { const v = cCRY(c);
      out.push({ invested:+c.invested||0, current:v.cur, buyDate:c.buyDate, dividend:0, name:c.coin }); });
    (S.mf||[]).forEach(f => { const cv = cMF(f);
      out.push({ invested:cv.inv, current:cv.cur, buyDate:f.startDate, dividend:0, name:f.name }); });
  } catch(e) {}
  return out;
}

function renderIncome(){
  const el = document.getElementById('ana-income');
  if(!el) return;
  const lots = _pmLots();
  const inc  = _pmIncome(lots);
  const xr   = _pmXirr(lots, new Date());
  const dated = _pmCashflows(lots, new Date()).length;
  const cov  = lots.length ? Math.round((dated ? dated - 1 : 0) / lots.length * 100) : 0;
  const tile = (lbl,val,sub,col,tip) => `<div class="tax-sum-box" title="${tip||''}" style="cursor:help">
    <div class="tax-sum-box-lbl">${lbl}</div>
    <div class="tax-sum-box-val" style="color:${col}">${val}</div>
    <div class="tax-sum-box-sub">${sub}</div></div>`;
  el.innerHTML = `<div class="tax-sum-grid">
    ${tile('Portfolio XIRR',
        xr==null ? '—' : (xr>=0?'+':'')+xr.toFixed(2)+'%',
        xr==null ? 'needs purchase dates' : cov+'% of holdings dated',
        xr==null ? 'var(--T3)' : (xr>=0?'#00B386':'#D93025'),
        'Money-weighted annualised return. Unlike absolute return it accounts for WHEN you invested, so an old holding and a recent one are compared fairly. Dividends are credited today, which slightly understates it.')}
    ${tile('Dividend Income',
        inc.total>0 ? F.inr(inc.total) : '—',
        inc.total>0 ? inc.paying+' holding'+(inc.paying===1?'':'s')+' paying' : 'add dividends per holding',
        inc.total>0 ? '#7C3AED' : 'var(--T3)',
        'Total dividends recorded against your holdings. Enter it per stock when adding or editing a position.')}
    ${tile('Yield on Cost',
        inc.yieldOnCost ? inc.yieldOnCost.toFixed(2)+'%' : '—',
        inc.yieldOnCost ? 'income vs what you paid' : 'needs dividend data',
        inc.yieldOnCost ? '#F59E0B' : 'var(--T3)',
        'Dividends as a percent of your original cost - what the position actually yields you, not what a new buyer gets at the current price.')}
  </div>
  <div style="font-size:11px;color:var(--T3);margin-top:8px;padding:8px 12px;background:var(--BL);border-radius:var(--r3)">
    XIRR is money-weighted across equity, crypto and funds using each purchase date. Holdings without a purchase date are excluded from XIRR but still counted in income.
  </div>`;
}

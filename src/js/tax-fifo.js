// ══════════ CAPITAL GAINS: FIFO LOT MATCHING ══════════
// The previous computation had three defects that produced wrong tax numbers:
//   1. When a sale had no matching BUY it invented a cost basis of 70% of the
//      sale price - a fabricated 30% profit, reported as fact.
//   2. That same path hard-coded a 730-day holding period, so every unmatched
//      sale was classified LTCG and never STCG.
//   3. It described itself as FIFO but used a weighted average cost with the
//      OLDEST buy date, which overstates the holding period and biases toward
//      the lower LTCG rate.
// This module does real FIFO: a sale consumes buy lots oldest-first, so each
// slice carries its own cost and its own holding period. One sale can
// legitimately split across STCG and LTCG. Nothing is ever invented - a sale
// that cannot be matched is returned as unmatched for the UI to flag.

// Indian equity, post-Budget-2024 (23 July 2024 onwards).
const TAX_RULES = {
  ltcgExempt: 125000,   // Section 112A exemption
  ltcgRate:   0.125,    // 12.5% (was 10% before Budget 2024)
  stcgRate:   0.20,     // 20% (was 15%)
  vdaRate:    0.30,     // crypto / VDA, no loss set-off
  ltDays:     365,      // listed equity: >12 months is long term
};

// txns: [{id,date,type:'BUY'|'SELL',cls,name,qty,price}]
// Returns { matched, unmatched }. Amounts are per-slice, not per-transaction.
function fifoMatchSells(txns, rules){
  const R = Object.assign({}, TAX_RULES, rules||{});
  const list = Array.isArray(txns) ? txns : [];
  const EPS = 1e-9;

  // Buy lots per asset, oldest first.
  const lots = {};
  list.filter(t => t && t.type === 'BUY').forEach(t => {
    const d = new Date(t.date);
    if(isNaN(d.getTime())) return;
    const qty = +t.qty, price = +t.price;
    if(!isFinite(qty) || qty <= 0 || !isFinite(price)) return;
    (lots[t.name] = lots[t.name] || []).push({ date:d, price, qty });
  });
  Object.keys(lots).forEach(k => lots[k].sort((a,b) => a.date - b.date));

  const sells = list.filter(t => t && t.type === 'SELL' && !isNaN(new Date(t.date).getTime()))
                    .slice().sort((a,b) => new Date(a.date) - new Date(b.date));

  const matched = [], unmatched = [];
  sells.forEach(s => {
    const sd = new Date(s.date);
    const sellPrice = +s.price;
    let remaining = +s.qty;
    if(!isFinite(remaining) || remaining <= 0 || !isFinite(sellPrice)){
      unmatched.push({ id:s.id, date:s.date, name:s.name, cls:s.cls,
                       qty:(+s.qty||0), price:(+s.price||0), reason:'invalid quantity or price' });
      return;
    }
    const avail = lots[s.name] || [];
    for(const lot of avail){
      if(remaining <= EPS) break;
      if(lot.qty <= EPS) continue;
      if(lot.date > sd) continue;              // cannot sell shares bought later
      const take = Math.min(lot.qty, remaining);
      const days = Math.round((sd - lot.date) / 864e5);
      matched.push({
        id:s.id, date:s.date, name:s.name, cls:s.cls,
        qty:take, price:sellPrice, sellPrice, buyPrice:lot.price,
        buyDate:lot.date.toISOString().slice(0,10),
        holdingDays:days, isLTCG: days > R.ltDays,
        gain:(sellPrice - lot.price) * take,
      });
      lot.qty -= take;
      remaining -= take;
    }
    if(remaining > EPS){
      // No buy record covers this quantity. Refuse to guess a cost basis.
      unmatched.push({ id:s.id, date:s.date, name:s.name, cls:s.cls,
                       qty:remaining, price:sellPrice,
                       reason:'no BUY transaction covers this quantity' });
    }
  });
  return { matched, unmatched };
}

// Equity capital-gains tax for a set of matched slices.
function computeEquityTax(rows, rules){
  const R = Object.assign({}, TAX_RULES, rules||{});
  const ltcg = (rows||[]).filter(r => r.isLTCG);
  const stcg = (rows||[]).filter(r => !r.isLTCG);
  const ltcgTotal = ltcg.reduce((a,r) => a + r.gain, 0);
  const stcgTotal = stcg.reduce((a,r) => a + r.gain, 0);
  const ltcgTaxable = Math.max(0, ltcgTotal - R.ltcgExempt);
  const stcgTaxable = Math.max(0, stcgTotal);
  return {
    ltcgRows:ltcg, stcgRows:stcg, ltcgTotal, stcgTotal,
    ltcgTaxable, stcgTaxable,
    ltcgTax: ltcgTaxable * R.ltcgRate,
    stcgTax: stcgTaxable * R.stcgRate,
    ltcgRatePct: R.ltcgRate * 100, stcgRatePct: R.stcgRate * 100,
    exempt: R.ltcgExempt,
  };
}

// Crypto / VDA: gains taxed at 30%, losses cannot be set off against anything,
// so only positive slices are counted.
function computeVdaTax(rows, rules){
  const R = Object.assign({}, TAX_RULES, rules||{});
  const gain = (rows||[]).reduce((a,r) => a + (r.gain > 0 ? r.gain : 0), 0);
  return { gain, tax: gain * R.vdaRate, ratePct: R.vdaRate * 100 };
}

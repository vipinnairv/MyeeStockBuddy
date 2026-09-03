// ══════════════════════ KEY RATIOS ══════════════════════
// Ratios computed from the statements the Financials tab already fetched, plus
// the market figures (price, P/E, market cap) the fundamentals feed supplies.
//
// All of it runs here, in the browser, in JavaScript. There is no server doing
// the arithmetic — which is the point: nothing about what you look at or hold
// is sent anywhere.
//
// Two rules govern every figure below.
//
//  1. A ratio whose inputs are missing is null and shows as a dash. None of
//     these are estimated, substituted or carried over from another period.
//  2. A ratio whose denominator is at or near zero is null, not Infinity, and
//     not a huge number that looks like a real result.
//
// Bands (good / fair / weak) are shown only where a rule holds across ordinary
// businesses. They are wrong for lenders, and the UI says so when the sector
// is known: a bank has no inventory, no meaningful current ratio, and debt is
// its raw material rather than a risk measure.

const RT_EPS = 1e-9;

// ── Shared number formatting ───────────────────────────────────────────────
// Indian grouping puts separators at 1,00,00,000 rather than 10,000,000, so a
// crore figure reads the way it is spoken. Both statement figures and ratios
// go through here, so the two tables never disagree on how a number looks.
function _finGroup(n, dp, isIndia){
  if(n == null || !isFinite(n)) return '';
  return n.toLocaleString(isIndia ? 'en-IN' : 'en-US',
    { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
// Short forms are unavoidable on a statement - the full numbers do not fit -
// but they are jargon to anyone outside finance, so each carries what it means.
const FIN_ABBR = {
  'Cr': 'Crore — 1,00,00,000, i.e. ten million',
  'L':  'Lakh — 1,00,000, i.e. one hundred thousand',
  'B':  'Billion — 1,000,000,000',
  'M':  'Million — 1,000,000',
  '×':  'Times — a multiple, not a percentage. 2× means twice.',
};
function _finUnit(u){
  const tip = FIN_ABBR[u];
  return tip ? `<abbr class="fin-abbr" title="${tip}">${u}</abbr>` : u;
}

// Latest reported value for a line, and the period it came from. Lines are not
// all published on the same date - a balance sheet can lag an income statement
// - so each line is read at its own newest date rather than forced onto one.
function _rtLatest(t, key){
  if(!t || !t.line || !t.periodsAll) return null;
  const m = t.line[key];
  if(!m) return null;
  for(const d of t.periodsAll) if(m[d] != null) return { v: m[d], date: d };
  return null;
}
function _rtVal(t, key){
  const r = _rtLatest(t, key);
  return r ? r.v : null;
}
// The two most recent values of a line, for a growth rate. Both must be real
// reported numbers - a single period cannot produce a growth rate.
function _rtPair(t, key){
  if(!t || !t.line || !t.periodsAll) return null;
  const m = t.line[key];
  if(!m) return null;
  const got = [];
  for(const d of t.periodsAll){ if(m[d] != null) got.push(m[d]); if(got.length === 2) break; }
  return got.length === 2 ? { now: got[0], prev: got[1] } : null;
}
// Division that refuses to produce a number it cannot stand behind.
function _rtDiv(a, b){
  if(a == null || b == null) return null;
  if(!isFinite(a) || !isFinite(b)) return null;
  if(Math.abs(b) < RT_EPS) return null;
  const r = a / b;
  return isFinite(r) ? r : null;
}
// Growth from a to b. A negative or zero base makes a percentage change
// meaningless (a swing from -100 to 50 is not "150% growth"), so it is null.
function _rtGrowth(pair){
  if(!pair) return null;
  if(pair.prev == null || pair.prev <= 0) return null;
  return (pair.now - pair.prev) / pair.prev * 100;
}
// Earnings per share, period by period. The source's own diluted EPS is used
// where it exists; otherwise EPS is what it is defined as — net profit divided
// by the shares outstanding in that same period. Without this fallback a
// company reporting both of those but no EPS line yielded no EPS at all, and
// with it no EPS growth and so no PEG.
function _rtEpsSeries(t){
  if(!t || !t.line || !t.periodsAll) return null;
  const rep = t.line.DilutedEPS || {}, ni = t.line.NetIncome || {}, sh = t.line.OrdinarySharesNumber || {};
  const out = {};
  for(const d of t.periodsAll){
    if(rep[d] != null){ out[d] = rep[d]; continue; }
    if(ni[d] != null && sh[d] != null && Math.abs(sh[d]) > RT_EPS) out[d] = ni[d] / sh[d];
  }
  return Object.keys(out).length ? out : null;
}
// The two most recent values of an already-built series, newest first.
function _rtPairFrom(map, periodsAll){
  if(!map || !periodsAll) return null;
  const got = [];
  for(const d of periodsAll){ if(map[d] != null) got.push(map[d]); if(got.length === 2) break; }
  return got.length === 2 ? { now: got[0], prev: got[1] } : null;
}

// First of several lines that is actually reported. Used where the source may
// carry either of two equivalent names.
function _rtFirst(t, keys){
  for(const k of keys){ const v = _rtVal(t, k); if(v != null) return v; }
  return null;
}

// ── The ratios ─────────────────────────────────────────────────────────────
function computeRatios(t, fund, price){
  const f = fund || {};
  const rev    = _rtVal(t, 'TotalRevenue');
  const cogs   = _rtVal(t, 'CostOfRevenue');
  const gross  = _rtVal(t, 'GrossProfit');
  const opInc  = _rtVal(t, 'OperatingIncome');
  const ebit   = _rtFirst(t, ['EBIT', 'OperatingIncome']);
  const ebitda = _rtVal(t, 'EBITDA');
  const pretax = _rtVal(t, 'PretaxIncome');
  const tax    = _rtVal(t, 'TaxProvision');
  const ni     = _rtVal(t, 'NetIncome');
  const assets = _rtVal(t, 'TotalAssets');
  const ca     = _rtVal(t, 'CurrentAssets');
  const cl     = _rtVal(t, 'CurrentLiabilities');
  const inv    = _rtVal(t, 'Inventory');
  const ar     = _rtVal(t, 'AccountsReceivable');
  const eq     = _rtVal(t, 'StockholdersEquity');
  const cash   = _rtVal(t, 'CashAndCashEquivalents');
  const debt   = _rtFirst(t, ['TotalDebt', 'LongTermDebt']);
  const interest = _rtVal(t, 'InterestExpense');
  const invCap = _rtVal(t, 'InvestedCapital');
  const ocf    = _rtVal(t, 'OperatingCashFlow');
  const capex  = _rtVal(t, 'CapitalExpenditure');
  const fcfRep = _rtVal(t, 'FreeCashFlow');
  const shares = _rtVal(t, 'OrdinarySharesNumber');

  const r = {};
  const pct = (a, b) => { const q = _rtDiv(a, b); return q == null ? null : q * 100; };

  // Profitability
  r.grossMargin = pct(gross != null ? gross : (rev != null && cogs != null ? rev - cogs : null), rev);
  r.opMargin    = pct(opInc, rev);
  r.netMargin   = pct(ni, rev);
  r.roe         = pct(ni, eq);
  r.roa         = pct(ni, assets);
  // ROCE: operating profit against the capital actually tied up in the
  // business. Capital employed must be positive for the ratio to mean anything.
  const capEmployed = (assets != null && cl != null) ? assets - cl : null;
  r.roce = (capEmployed != null && capEmployed > 0) ? pct(ebit, capEmployed) : null;
  // ROIC uses after-tax operating profit. The effective tax rate is only
  // trusted inside a sane band; outside it the ratio is left unreported rather
  // than scaled by a nonsense rate.
  const taxRate = _rtDiv(tax, pretax);
  r.roic = (taxRate != null && taxRate >= 0 && taxRate <= 0.6 && ebit != null && invCap != null)
         ? pct(ebit * (1 - taxRate), invCap) : null;

  // Growth
  r.revGrowth = _rtGrowth(_rtPair(t, 'TotalRevenue'));
  r.niGrowth  = _rtGrowth(_rtPair(t, 'NetIncome'));
  const epsSeries = _rtEpsSeries(t);
  r.epsGrowth = _rtGrowth(_rtPairFrom(epsSeries, t && t.periodsAll));

  // Leverage
  r.debtToEquity = _rtDiv(debt, eq);
  const netDebt = (debt != null && cash != null) ? debt - cash : null;
  r.netDebtEbitda = (netDebt != null && netDebt > 0) ? _rtDiv(netDebt, ebitda) : (netDebt != null ? 0 : null);
  r.interestCover = (interest != null && Math.abs(interest) > RT_EPS)
                  ? _rtDiv(ebit, Math.abs(interest)) : null;

  // Liquidity
  r.currentRatio = _rtDiv(ca, cl);
  r.quickRatio   = (ca != null && inv != null) ? _rtDiv(ca - inv, cl) : null;

  // Efficiency
  r.assetTurnover = _rtDiv(rev, assets);
  r.invTurnover   = _rtDiv(cogs, inv);
  r.receivableDays = (() => { const q = _rtDiv(ar, rev); return q == null ? null : q * 365; })();

  // Cash quality
  const fcf = fcfRep != null ? fcfRep : ((ocf != null && capex != null) ? ocf + capex : null);
  r.fcf = fcf;
  r.fcfMargin = pct(fcf, rev);
  // Only meaningful when the company actually made a profit; against a loss the
  // ratio flips sign and reads as if cash conversion were terrible or superb.
  r.cashConversion = (ni != null && ni > 0) ? _rtDiv(ocf, ni) : null;

  // Valuation. These need the market's price, not just the accounts.
  const p = (typeof price === 'number' && isFinite(price) && price > 0) ? price : null;
  let eps = null;
  if(epsSeries && t && t.periodsAll) for(const d of t.periodsAll){ if(epsSeries[d] != null){ eps = epsSeries[d]; break; } }
  r.eps = eps;
  r.pe  = (f.pe != null && isFinite(f.pe) && f.pe > 0) ? f.pe : (p != null && eps != null && eps > 0 ? _rtDiv(p, eps) : null);
  r.pb  = (f.pb != null && isFinite(f.pb) && f.pb > 0) ? f.pb
        : ((p != null && eq != null && shares != null) ? _rtDiv(p, _rtDiv(eq, shares)) : null);
  r.ps  = (f.ps != null && isFinite(f.ps) && f.ps > 0) ? f.ps
        : ((f.mktCap != null && rev != null) ? _rtDiv(f.mktCap, rev) : null);
  r.earningsYield = r.pe != null ? _rtDiv(100, r.pe) : null;
  r.divYield = (f.divYield != null && isFinite(f.divYield)) ? f.divYield : null;
  // EV/EBITDA from the accounts when the feed does not carry it.
  const ev = (f.mktCap != null && netDebt != null) ? f.mktCap + netDebt : null;
  r.evEbitda = (f.evEbitda != null && isFinite(f.evEbitda) && f.evEbitda > 0) ? f.evEbitda
             : ((ev != null && ebitda != null && ebitda > 0) ? _rtDiv(ev, ebitda) : null);
  // PEG: P/E divided by the growth rate it is being paid for. Against flat or
  // shrinking earnings the ratio has no meaning at all - a negative PEG is not
  // "cheap" - so it is withheld rather than shown as a bargain.
  // Preference order matters. Annual EPS growth from the statements is what
  // PEG is defined against. The feed's own earningsGrowth is a quarterly
  // year-on-year figure that is often negative for a company whose annual
  // earnings grew, and taking it unconditionally withheld PEG on the weaker
  // measure. Net income growth is the last resort: it ignores dilution.
  const pegCandidates = [
    ['annual EPS growth', r.epsGrowth],
    ['the feed\u2019s earnings growth', (f.earnGrowth != null && isFinite(f.earnGrowth)) ? f.earnGrowth : null],
    ['net income growth', r.niGrowth],
  ].filter(c => c[1] != null);
  const pegOn = pegCandidates.find(c => c[1] > 0);
  r.peg = (r.pe != null && pegOn) ? _rtDiv(r.pe, pegOn[1]) : null;
  r.pegBasis = r.peg != null ? pegOn[0] : null;
  // Only "no growth to price" when growth was actually measured and was not
  // positive. Growth we simply do not have is a dash, not a verdict.
  r.pegBlocked = (r.pe != null && pegCandidates.length > 0 && !pegOn);

  return r;
}

// Bands. `hi` means a bigger number is better. A ratio with no entry here is
// shown without a colour, because no single threshold is defensible for it.
const RT_BANDS = {
  grossMargin:   { hi:true,  good:40,  fair:20 },
  opMargin:      { hi:true,  good:15,  fair:8 },
  netMargin:     { hi:true,  good:10,  fair:5 },
  roe:           { hi:true,  good:18,  fair:12 },
  roce:          { hi:true,  good:18,  fair:12 },
  roic:          { hi:true,  good:15,  fair:10 },
  roa:           { hi:true,  good:8,   fair:4 },
  revGrowth:     { hi:true,  good:15,  fair:5 },
  niGrowth:      { hi:true,  good:15,  fair:5 },
  debtToEquity:  { hi:false, good:0.5, fair:1 },
  netDebtEbitda: { hi:false, good:1.5, fair:3 },
  interestCover: { hi:true,  good:5,   fair:2.5 },
  currentRatio:  { hi:true,  good:1.5, fair:1 },
  quickRatio:    { hi:true,  good:1,   fair:0.7 },
  cashConversion:{ hi:true,  good:0.9, fair:0.6 },
  fcfMargin:     { hi:true,  good:10,  fair:4 },
  peg:           { hi:false, good:1,   fair:2 },
  earningsYield: { hi:true,  good:6,   fair:3 },
};
function ratioBand(key, v){
  const b = RT_BANDS[key];
  if(!b || v == null || !isFinite(v)) return null;
  if(b.hi) return v >= b.good ? 'good' : v >= b.fair ? 'fair' : 'weak';
  return v <= b.good ? 'good' : v <= b.fair ? 'fair' : 'weak';
}

// Ratios that describe a manufacturer or retailer and say nothing useful about
// a lender: a bank holds no inventory, its "current ratio" is an artefact of
// how deposits are classified, and debt is its input, not its risk.
const RT_LENDER_NA = ['currentRatio','quickRatio','invTurnover','debtToEquity','netDebtEbitda','evEbitda','assetTurnover'];
function isLender(fund){
  const s = ((fund && (fund.sector || fund.industry)) || '').toLowerCase();
  return /bank|financial|insur|nbfc|capital market|credit/.test(s);
}

// ── Display ────────────────────────────────────────────────────────────────
const RT_DASH = '<span class="rt-na">—</span>';
function _rtPct(v){ return v == null ? RT_DASH : (v >= 0 ? '' : '-') + Math.abs(v).toFixed(1) + '%'; }
function _rtX(v, dp){ return v == null ? RT_DASH : v.toFixed(dp == null ? 2 : dp) + _finUnit('×'); }
function _rtRaw(v, dp){ return v == null ? RT_DASH : _finGroup(v, dp == null ? 2 : dp, true); }
function _rtDays(v){ return v == null ? RT_DASH : _finGroup(Math.round(v), 0, true) + ' days'; }

// label, key, formatter, what it actually tells you
const RT_GROUPS = [
  ['💰 Profitability', [
    ['Gross margin',      'grossMargin', _rtPct, 'What is left of each rupee of sales after the direct cost of producing it.'],
    ['Operating margin',  'opMargin',    _rtPct, 'Profit from running the business, before interest and tax.'],
    ['Net margin',        'netMargin',   _rtPct, 'What finally reaches the bottom line, per rupee of sales.'],
    ['ROE',               'roe',         _rtPct, 'Return on equity: profit earned on the shareholders’ own money.'],
    ['ROCE',              'roce',        _rtPct, 'Return on capital employed: operating profit against all capital tied up in the business (total assets less current liabilities). Harder to flatter with debt than ROE, which is why it is the one to look at first.'],
    ['ROIC',              'roic',        _rtPct, 'Return on invested capital: after-tax operating profit against invested capital.'],
    ['ROA',               'roa',         _rtPct, 'Return on assets: profit against everything the company owns.'],
  ]],
  ['📈 Growth', [
    ['Revenue growth',    'revGrowth',   _rtPct, 'Change in revenue against the previous reported period.'],
    ['Net income growth', 'niGrowth',    _rtPct, 'Change in net profit against the previous reported period.'],
    ['EPS growth',        'epsGrowth',   _rtPct, 'Change in earnings per share — growth after any dilution.'],
  ]],
  ['⚖️ Leverage & solvency', [
    ['Debt / Equity',     'debtToEquity',  v => _rtRaw(v), 'Borrowings against shareholders’ funds. Above 1 means the business leans more on lenders than on owners.'],
    ['Net debt / EBITDA', 'netDebtEbitda', v => _rtX(v),   'Years of operating earnings it would take to clear debt net of cash. Above 3 is where lenders start to care.'],
    ['Interest coverage', 'interestCover', v => _rtX(v, 1),'How many times operating profit covers the interest bill. Under 2 is fragile.'],
  ]],
  ['💧 Liquidity', [
    ['Current ratio',     'currentRatio', v => _rtRaw(v), 'Short-term assets against short-term dues. Below 1 means near-term bills exceed near-term resources.'],
    ['Quick ratio',       'quickRatio',   v => _rtRaw(v), 'The same, excluding inventory — what could be paid without selling stock first.'],
  ]],
  ['⚙️ Efficiency', [
    ['Asset turnover',    'assetTurnover', v => _rtX(v),   'Revenue generated per rupee of assets.'],
    ['Inventory turnover','invTurnover',   v => _rtX(v, 1),'How many times inventory is sold and replaced in a period.'],
    ['Receivable days',   'receivableDays', _rtDays,       'Average days customers take to pay.'],
  ]],
  ['💵 Cash quality', [
    ['FCF margin',        'fcfMargin',     _rtPct,         'Free cash flow as a share of revenue — cash left after running and maintaining the business.'],
    ['Cash conversion',   'cashConversion', v => _rtX(v),  'Operating cash flow divided by net profit. Well under 1 means profits are not turning into cash.'],
  ]],
  ['🏷️ Valuation', [
    ['EPS',               'eps',           v => _rtRaw(v),    'Earnings per share: net profit divided by the shares outstanding, or the source\u2019s own diluted figure where it reports one.'],
    ['P/E',               'pe',            v => _rtRaw(v, 1), 'Price paid per rupee of annual earnings.'],
    ['PEG',               'peg',           v => _rtRaw(v),    'P/E divided by the earnings growth rate being paid for. Around 1 means growth and price are roughly in line; under 1 is the classic screen for growth at a reasonable price.'],
    ['P/B',               'pb',            v => _rtRaw(v),    'Price against book value — the accounting net worth per share.'],
    ['P/S',               'ps',            v => _rtRaw(v),    'Price against annual revenue. Useful where earnings are small or negative.'],
    ['EV / EBITDA',       'evEbitda',      v => _rtRaw(v, 1), 'Whole-company value (market cap plus net debt) against operating earnings. Comparable across different debt loads.'],
    ['Earnings yield',    'earningsYield', _rtPct,            'Earnings per rupee invested — the P/E inverted, so it can be read against a deposit rate.'],
    ['Dividend yield',    'divYield',      _rtPct,            'Annual dividend as a share of the current price.'],
  ]],
];

function ratiosHtml(t, fund, price){
  const r = computeRatios(t, fund, price);
  const lender = isLender(fund);
  const cell = (label, key, fmt, tip) => {
    const v = r[key];
    const na = lender && RT_LENDER_NA.indexOf(key) >= 0;
    const band = na ? null : ratioBand(key, v);
    const shown = na && v != null
      ? `<span class="rt-na" title="This ratio does not describe a lender's balance sheet.">n/a</span>`
      : fmt(v);
    let note = '';
    if(key === 'peg'){
      if(v == null && r.pegBlocked) note = `<div class="rt-note">no growth to price</div>`;
      else if(v != null && r.pegBasis) note = `<div class="rt-note">vs ${r.pegBasis}</div>`;
    }
    return `<tr class="rt-row"><th scope="row" class="rt-lbl" title="${tip.replace(/"/g,'&quot;')}">${label}</th>
      <td class="rt-val ${band ? 'rt-'+band : ''}">${shown}${note}</td></tr>`;
  };
  const groups = RT_GROUPS.map(([title, rows]) => `
    <div class="rt-card">
      <div class="rt-card-h">${title}</div>
      <table class="rt-table"><tbody>${rows.map(x => cell(x[0], x[1], x[2], x[3])).join('')}</tbody></table>
    </div>`).join('');
  const lenderNote = lender
    ? `<div class="rt-warn">This looks like a bank or financial company. Liquidity, turnover and debt ratios are marked <b>n/a</b> because they describe manufacturers and retailers, not lenders — for a bank, deposits are raw material, not a liability to worry about. Judge it on ROE, net margin and growth instead.</div>`
    : '';
  return `<div class="rt-wrap">
    <div class="rt-h">📐 Key Ratios</div>
    ${lenderNote}
    <div class="rt-grid">${groups}</div>
    <div class="rt-foot">Computed in your browser from the reported statements above and the current price — nothing is sent anywhere.
      A dash means the source did not carry the inputs, so the ratio is not shown rather than estimated.
      Colours are broad rules of thumb across ordinary businesses; a capital-heavy company and an asset-light one are not judged on the same numbers.
      Hover any label for what it measures.</div>
  </div>`;
}

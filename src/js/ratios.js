// ══════════════════════ KEY RATIOS ══════════════════════
// Ratios computed from the statements the Financials tab already fetched, plus
// the market figures (price, P/E, market cap) the fundamentals feed supplies.
//
// All of it runs here, in the browser, in JavaScript. There is no server doing
// the arithmetic, which is the point: nothing about what you look at or hold
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
  'Cr': 'Crore, 1,00,00,000, i.e. ten million',
  'L':  'Lakh, 1,00,000, i.e. one hundred thousand',
  'B':  'Billion, 1,000,000,000',
  'M':  'Million, 1,000,000',
  '×':  'Times, a multiple, not a percentage. 2× means twice.',
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
  return _rtPairFrom(t && t.line ? t.line[key] : null, t && t.periodsAll);
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
// where it exists; otherwise EPS is what it is defined as, net profit divided
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
// The two most recent values of a series, newest first, with the periods they
// came from. A growth rate is only interpretable alongside the span it covers:
// where a year is missing from the source, "growth" is really two years of it.
function _rtPairFrom(map, periodsAll){
  if(!map || !periodsAll) return null;
  const got = [];
  for(const d of periodsAll){ if(map[d] != null) got.push([d, map[d]]); if(got.length === 2) break; }
  if(got.length !== 2) return null;
  return { now: got[0][1], prev: got[1][1], nowDate: got[0][0], prevDate: got[1][0] };
}
function _rtSpan(pair){
  return (pair && pair.nowDate && pair.prevDate) ? pair.prevDate + ' → ' + pair.nowDate : null;
}

// The newest period at which EVERY line a ratio needs is reported, and the
// values there. This is the fix for a genuine error: reading each line at its
// own latest date meant a 2026 income statement could be divided by a balance
// sheet from years earlier, which produced a return on assets of 112%, net
// income cannot exceed everything a company owns. A ratio is only a ratio if
// its parts describe the same moment.
//
// A key may be an array of alternates, tried in order, for lines the source
// reports under either of two names.
function _rtCommon(t, keys){
  if(!t || !t.line || !t.periodsAll) return null;
  for(const d of t.periodsAll){
    const vals = [];
    let complete = true;
    for(const key of keys){
      const alts = Array.isArray(key) ? key : [key];
      let v = null;
      for(const k of alts){ const m = t.line[k]; if(m && m[d] != null){ v = m[d]; break; } }
      if(v == null){ complete = false; break; }
      vals.push(v);
    }
    if(complete) return { v: vals, date: d };
  }
  return null;
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
  const r = {};

  // Every ratio below reads its inputs at the newest period where all of them
  // exist together. Where that period differs between ratios it is recorded,
  // so the panel can say which one a figure describes.
  const on = (keys, fn) => {
    const c = _rtCommon(t, keys);
    if(!c) return null;
    const out = fn.apply(null, c.v);
    if(out != null && isFinite(out)) r._dates = r._dates || {};
    return out;
  };
  const at = (keys) => { const c = _rtCommon(t, keys); return c ? c.date : null; };
  const pctOf = (a, b) => { const q = _rtDiv(a, b); return q == null ? null : q * 100; };

  // Profitability
  r.grossMargin = on([['GrossProfit'], 'TotalRevenue'], (g, rev) => pctOf(g, rev));
  if(r.grossMargin == null)
    r.grossMargin = on(['TotalRevenue', 'CostOfRevenue'], (rev, c) => pctOf(rev - c, rev));
  r.opMargin  = on(['OperatingIncome', 'TotalRevenue'], (o, rev) => pctOf(o, rev));
  r.netMargin = on(['NetIncome', 'TotalRevenue'], (n, rev) => pctOf(n, rev));
  r.roe       = on(['NetIncome', 'StockholdersEquity'], (n, e) => pctOf(n, e));
  r.roa       = on(['NetIncome', 'TotalAssets'], (n, a) => pctOf(n, a));
  r.periodUsed = at(['NetIncome', 'TotalAssets']) || at(['NetIncome', 'TotalRevenue']);
  // ROCE: operating profit against capital actually tied up in the business.
  // Capital employed must be positive for the ratio to mean anything.
  r.roce = on([['EBIT', 'OperatingIncome'], 'TotalAssets', 'CurrentLiabilities'],
    (e, a, c) => { const cap = a - c; return cap > 0 ? pctOf(e, cap) : null; });
  // ROIC uses after-tax operating profit. The effective tax rate is trusted
  // only inside a sane band; outside it the ratio is withheld rather than
  // scaled by a nonsense rate.
  r.roic = on([['EBIT', 'OperatingIncome'], 'PretaxIncome', 'TaxProvision', 'InvestedCapital'],
    (e, pre, tax, cap) => {
      const rate = _rtDiv(tax, pre);
      return (rate != null && rate >= 0 && rate <= 0.6) ? pctOf(e * (1 - rate), cap) : null;
    });

  // Growth
  const revPair = _rtPair(t, 'TotalRevenue'), niPair = _rtPair(t, 'NetIncome');
  r.revGrowth = _rtGrowth(revPair);
  r.niGrowth  = _rtGrowth(niPair);
  r.niSpan    = _rtSpan(niPair);
  const epsSeries = _rtEpsSeries(t);
  const epsPair = _rtPairFrom(epsSeries, t && t.periodsAll);
  r.epsGrowth = _rtGrowth(epsPair);
  r.epsSpan   = _rtSpan(epsPair);

  // Leverage
  r.debtToEquity = on([['TotalDebt', 'LongTermDebt'], 'StockholdersEquity'], (d, e) => _rtDiv(d, e));
  r.netDebtEbitda = on([['TotalDebt', 'LongTermDebt'], 'CashAndCashEquivalents', 'EBITDA'],
    (d, c, e) => { const nd = d - c; return nd <= 0 ? 0 : _rtDiv(nd, e); });
  r.interestCover = on([['EBIT', 'OperatingIncome'], 'InterestExpense'],
    (e, i) => Math.abs(i) > RT_EPS ? _rtDiv(e, Math.abs(i)) : null);

  // Liquidity
  r.currentRatio = on(['CurrentAssets', 'CurrentLiabilities'], (a, l) => _rtDiv(a, l));
  r.quickRatio   = on(['CurrentAssets', 'Inventory', 'CurrentLiabilities'], (a, i, l) => _rtDiv(a - i, l));

  // Efficiency
  r.assetTurnover  = on(['TotalRevenue', 'TotalAssets'], (rev, a) => _rtDiv(rev, a));
  r.invTurnover    = on(['CostOfRevenue', 'Inventory'], (c, i) => _rtDiv(c, i));
  r.receivableDays = on(['AccountsReceivable', 'TotalRevenue'],
    (ar, rev) => { const q = _rtDiv(ar, rev); return q == null ? null : q * 365; });

  // Cash quality
  r.fcf = _rtVal(t, 'FreeCashFlow');
  if(r.fcf == null) r.fcf = on(['OperatingCashFlow', 'CapitalExpenditure'], (o, c) => o + c);
  r.fcfMargin = (r.fcf != null) ? on(['TotalRevenue'], (rev) => pctOf(r.fcf, rev)) : null;
  // Only meaningful against a profit; against a loss the ratio flips sign and
  // reads as if cash conversion were terrible or superb.
  r.cashConversion = on(['OperatingCashFlow', 'NetIncome'], (o, n) => n > 0 ? _rtDiv(o, n) : null);

  // Valuation. These need the market's price, not just the accounts.
  const p = (typeof price === 'number' && isFinite(price) && price > 0) ? price : null;
  const eq = _rtVal(t, 'StockholdersEquity'), rev = _rtVal(t, 'TotalRevenue');
  const shares = _rtVal(t, 'OrdinarySharesNumber');
  const netDebtV = on([['TotalDebt', 'LongTermDebt'], 'CashAndCashEquivalents'], (d, c) => d - c);
  const ebitdaV = _rtVal(t, 'EBITDA');
  let eps = null;
  if(epsSeries && t && t.periodsAll) for(const d of t.periodsAll){ if(epsSeries[d] != null){ eps = epsSeries[d]; break; } }
  // ── Is the share count believable? ──────────────────────────────────────
  // Every per-share figure rests on it, and a wrong one poisons all of them at
  // once while leaving the business ratios untouched. Cupid Ltd showed exactly
  // that: the feed reported 134 crore shares, which at the traded price implies
  // a market capitalisation of about 37,700 crore for a company with 451 crore
  // of equity and 351 crore of revenue. EPS came out at 0.79 and the P/E at
  // 277, while net margin and ROE were correct to the decimal because they
  // never divide by the share count.
  //
  // This is checkable without knowing anything about the company: the market
  // capitalisation the feed reports and the one implied by price times the
  // reported share count describe the same quantity, so they must agree. When
  // they disagree by a wide margin, one of the two is wrong and every figure
  // built on the share count is unreliable. That is a statement about the data,
  // not a judgement about the business.
  const sharesN = _rtVal(t, 'OrdinarySharesNumber');
  const feedCap = (f.mktCap != null && isFinite(f.mktCap) && f.mktCap > 0) ? f.mktCap : null;
  if(p != null && sharesN != null && sharesN > 0 && feedCap != null){
    const implied = p * sharesN;
    const factor = implied / feedCap;
    if(factor > 3 || factor < 1/3){
      r.shareCountSuspect = { impliedMcap: implied, feedMcap: feedCap,
                              factor: factor, shares: sharesN };
    }
  }

  // P/E and EPS must come from the same basis, or the pair the reader sees does
  // not tie: the report showed EPS 0.79 beside a P/E of 277.2 at a price of
  // ~280, and 0.79 x 277.2 is 219. The P/E was the feed's trailing figure while
  // the EPS was the latest annual statement - two different periods printed as
  // though they were one calculation. Whatever basis is used, price / EPS now
  // equals the P/E shown.
  const feedEps = (f.eps != null && isFinite(f.eps) && f.eps > 0) ? f.eps : null;
  const feedPe  = (f.pe  != null && isFinite(f.pe)  && f.pe  > 0) ? f.pe  : null;
  if(feedEps != null && feedPe != null){
    // Both from the feed, same trailing twelve months. Use the pair as given
    // unless they disagree with the price by more than rounding, which would
    // mean the feed itself is internally inconsistent.
    const implied = _rtDiv(p, feedEps);
    if(p == null || implied == null || Math.abs(implied - feedPe) / feedPe < 0.05){
      r.eps = feedEps; r.pe = feedPe; r.peBasis = 'trailing twelve months, from the data feed';
    } else {
      r.eps = feedEps; r.pe = implied;
      r.peBasis = 'price divided by the feed\u2019s trailing EPS (the feed\u2019s own P/E disagreed with its EPS)';
    }
  } else if(feedPe != null){
    // A P/E with no EPS beside it. With a price, the EPS it implies can be
    // derived and the two will tie. Without one, the P/E still stands on its
    // own - but the statement EPS is withheld rather than printed next to it,
    // because the two would come from different periods and would not tie.
    r.pe = feedPe;
    r.eps = (p != null) ? _rtDiv(p, feedPe) : null;
    r.peBasis = (p != null)
      ? 'trailing twelve months, EPS implied by the feed\u2019s P/E'
      : 'trailing twelve months, from the data feed';
  } else if(p != null && eps != null && eps > 0){
    // No feed valuation at all: compute both from the statements and the price.
    r.eps = eps; r.pe = _rtDiv(p, eps);
    r.peBasis = 'price divided by the latest reported EPS';
  } else {
    r.eps = eps; r.pe = null;
    r.peBasis = null;
  }
  r.pb  = (f.pb != null && isFinite(f.pb) && f.pb > 0) ? f.pb
        : ((p != null && eq != null && shares != null) ? _rtDiv(p, _rtDiv(eq, shares)) : null);
  r.ps  = (f.ps != null && isFinite(f.ps) && f.ps > 0) ? f.ps
        : ((f.mktCap != null && rev != null) ? _rtDiv(f.mktCap, rev) : null);
  r.earningsYield = r.pe != null ? _rtDiv(100, r.pe) : null;
  r.divYield = (f.divYield != null && isFinite(f.divYield)) ? f.divYield : null;
  // EV/EBITDA from the accounts when the feed does not carry it.
  const ev = (f.mktCap != null && netDebtV != null) ? f.mktCap + netDebtV : null;
  r.evEbitda = (f.evEbitda != null && isFinite(f.evEbitda) && f.evEbitda > 0) ? f.evEbitda
             : ((ev != null && ebitdaV != null && ebitdaV > 0) ? _rtDiv(ev, ebitdaV) : null);
  // PEG: P/E divided by the growth rate it is being paid for. Against flat or
  // shrinking earnings the ratio has no meaning at all - a negative PEG is not
  // "cheap" - so it is withheld rather than shown as a bargain.
  // An annual measure decides, whichever way it points. The earlier rule took
  // the first POSITIVE measure, which was meant to stop one weak quarter
  // blocking a healthy annual figure - but it also let one strong quarter
  // override a negative annual one, publishing a flattering PEG in green for a
  // company whose earnings actually shrank over the year. That error runs the
  // dangerous way: understating growth only withholds a ratio, while
  // overstating it calls a shrinking business cheap.
  //
  // So: annual EPS growth if reported, else annual net income growth. The
  // feed's earningsGrowth is one quarter against the same quarter a year back,
  // and is used only when no annual measure exists at all.
  const annualMeasures = [
    { label: 'annual EPS growth', v: r.epsGrowth, span: r.epsSpan, annual: true },
    { label: 'net income growth', v: r.niGrowth, span: r.niSpan, annual: true },
  ].filter(c => c.v != null);
  const feedMeasure = (f.earnGrowth != null && isFinite(f.earnGrowth))
    ? { label: 'the feed\u2019s earnings growth (one quarter)', v: f.earnGrowth, span: null, annual: false }
    : null;
  const pegOn = annualMeasures.length
    ? (annualMeasures[0].v > 0 ? annualMeasures[0] : null)
    : (feedMeasure && feedMeasure.v > 0 ? feedMeasure : null);
  r.peg = (r.pe != null && pegOn) ? _rtDiv(r.pe, pegOn.v) : null;
  r.pegBasis = r.peg != null ? pegOn.label : null;
  r.pegSpan  = r.peg != null ? pegOn.span : null;
  // Everything measured, so the panel can show its working rather than leaving
  // a dash the reader cannot argue with.
  const pegCandidates = annualMeasures.concat(feedMeasure ? [feedMeasure] : []);
  r.pegGrowths = pegCandidates.map(c => ({ label: c.label, value: c.v, span: c.span }));
  const deciding = annualMeasures.length ? annualMeasures[0] : feedMeasure;
  r.pegBlocked = !!(r.pe != null && deciding && !pegOn);
  r.pegBlockedOnAnnual = !!(r.pegBlocked && deciding.annual);
  r.pegBlockedBy = r.pegBlocked
    ? { label: deciding.label, value: deciding.v, span: deciding.span, annual: deciding.annual }
    : null;

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
// Banks are judged on different numbers. A return on assets of 1.4% is
// healthy for a lender and weak for a manufacturer; one threshold cannot serve
// both, and colouring a good bank red is a wrong answer, not a rough one.
const RT_BANDS_LENDER = {
  roa: { hi:true, good:1.5,  fair:1.0 },
  roe: { hi:true, good:15,   fair:10 },
};
function ratioBand(key, v, lender){
  const b = (lender && RT_BANDS_LENDER[key]) || RT_BANDS[key];
  if(!b || v == null || !isFinite(v)) return null;
  if(b.hi) return v >= b.good ? 'good' : v >= b.fair ? 'fair' : 'weak';
  return v <= b.good ? 'good' : v <= b.fair ? 'fair' : 'weak';
}

// Ratios that describe a manufacturer or retailer and say nothing useful about
// a lender: a bank holds no inventory, its "current ratio" is an artefact of
// how deposits are classified, and debt is its input, not its risk.
// Everything that divides by, or is priced against, the share count.
const RT_PER_SHARE = ['eps','pe','peg','pb','ps','earningsYield','evEbitda'];
const RT_LENDER_NA = ['currentRatio','quickRatio','invTurnover','debtToEquity','netDebtEbitda',
  'evEbitda','assetTurnover','fcfMargin','cashConversion','receivableDays'];
function isLender(fund){
  const s = ((fund && (fund.sector || fund.industry)) || '').toLowerCase();
  return /bank|financial|insur|nbfc|capital market|credit/.test(s);
}

// ── Display ────────────────────────────────────────────────────────────────
// Three markers, each a different statement, none of them a blank or a dash a
// reader has to decode:
//   n/r  the source did not report this line
//   n/a  the ratio does not describe this kind of business
//   n/m  it applies, but cannot be computed to anything meaningful
const RT_DASH = '<span class="rt-na" title="Not reported: the data source did not carry this line.">n/r</span>';
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
    ['EPS growth',        'epsGrowth',   _rtPct, 'Change in earnings per share, growth after any dilution.'],
  ]],
  ['⚖️ Leverage & solvency', [
    ['Debt / Equity',     'debtToEquity',  v => _rtRaw(v), 'Borrowings against shareholders’ funds. Above 1 means the business leans more on lenders than on owners.'],
    ['Net debt / EBITDA', 'netDebtEbitda', v => _rtX(v),   'Years of operating earnings it would take to clear debt net of cash. Above 3 is where lenders start to care.'],
    ['Interest coverage', 'interestCover', v => _rtX(v, 1),'How many times operating profit covers the interest bill. Under 2 is fragile.'],
  ]],
  ['💧 Liquidity', [
    ['Current ratio',     'currentRatio', v => _rtRaw(v), 'Short-term assets against short-term dues. Below 1 means near-term bills exceed near-term resources.'],
    ['Quick ratio',       'quickRatio',   v => _rtRaw(v), 'The same, excluding inventory, what could be paid without selling stock first.'],
  ]],
  ['⚙️ Efficiency', [
    ['Asset turnover',    'assetTurnover', v => _rtX(v),   'Revenue generated per rupee of assets.'],
    ['Inventory turnover','invTurnover',   v => _rtX(v, 1),'How many times inventory is sold and replaced in a period.'],
    ['Receivable days',   'receivableDays', _rtDays,       'Average days customers take to pay.'],
  ]],
  ['💵 Cash quality', [
    ['FCF margin',        'fcfMargin',     _rtPct,         'Free cash flow as a share of revenue, cash left after running and maintaining the business.'],
    ['Cash conversion',   'cashConversion', v => _rtX(v),  'Operating cash flow divided by net profit. Well under 1 means profits are not turning into cash.'],
  ]],
  ['🏷️ Valuation', [
    ['EPS',               'eps',           v => _rtRaw(v),    'Earnings per share: net profit divided by the shares outstanding, or the source\u2019s own diluted figure where it reports one.'],
    ['P/E',               'pe',            v => _rtRaw(v, 1), 'Price paid per rupee of annual earnings.'],
    ['PEG',               'peg',           v => _rtRaw(v),    'P/E divided by the earnings growth rate being paid for. Around 1 means growth and price are roughly in line; under 1 is the classic screen for growth at a reasonable price.'],
    ['P/B',               'pb',            v => _rtRaw(v),    'Price against book value, the accounting net worth per share.'],
    ['P/S',               'ps',            v => _rtRaw(v),    'Price against annual revenue. Useful where earnings are small or negative.'],
    ['EV / EBITDA',       'evEbitda',      v => _rtRaw(v, 1), 'Whole-company value (market cap plus net debt) against operating earnings. Comparable across different debt loads.'],
    ['Earnings yield',    'earningsYield', _rtPct,            'Earnings per rupee invested, the P/E inverted, so it can be read against a deposit rate.'],
    ['Dividend yield',    'divYield',      _rtPct,            'Annual dividend as a share of the current price.'],
  ]],
];

function ratiosHtml(t, fund, price){
  const r = computeRatios(t, fund, price);
  const lender = isLender(fund);
  const cell = (label, key, fmt, tip) => {
    const v = r[key];
    const na = lender && RT_LENDER_NA.indexOf(key) >= 0;
    const suspect = !!r.shareCountSuspect && RT_PER_SHARE.indexOf(key) >= 0;
    // A band is a verdict on a number. Where the number rests on a share count
    // that does not survive its own cross-check, there is nothing to judge.
    const band = (na || suspect) ? null : ratioBand(key, v, lender);
    const shown = na && v != null
      ? `<span class="rt-na" title="This ratio does not describe a lender's balance sheet.">n/a</span>`
      : fmt(v);
    // PEG's tooltip carries every growth rate that was measured. A withheld
    // ratio the reader cannot inspect is indistinguishable from a broken one.
    if(key === 'peg' && r.pegGrowths && r.pegGrowths.length){
      tip += ' Growth measured: ' + r.pegGrowths.map(g =>
        g.label + ' ' + g.value.toFixed(1) + '%' + (g.span ? ' (' + g.span + ')' : '')).join('; ') + '.';
    }
    let note = '', display = shown;
    if(suspect && v != null){
      note = `<div class="rt-note">share count unverified</div>`;
    }
    if(key === 'pe' && v != null && r.peBasis){
      note = `<div class="rt-note">${r.peBasis}</div>`;
    }
    if(key === 'peg'){
      if(v != null && r.pegBasis){
        note = `<div class="rt-note">vs ${r.pegBasis}${r.pegSpan ? ', ' + r.pegSpan : ''}</div>`;
      } else if(v == null && r.pegBlocked && r.pegBlockedBy){
        const b = r.pegBlockedBy;
        // The figure itself, not merely the fact that one exists. PEG divides
        // the P/E by a growth rate; with no positive growth there is no value
        // to print, so the cell carries "n/m" (not meaningful) and the growth
        // rate that made it so. That is distinct from "n/a", which means the
        // ratio does not describe this kind of business at all.
        const fig = (b.value < 0 ? '-' : '+') + Math.abs(b.value).toFixed(1) + '%';
        display = `<span class="rt-na" title="Not meaningful: PEG divides the P/E by the growth rate, and there is no positive growth to divide by.">n/m</span>`;
        note = `<div class="rt-note">growth ${fig} (${b.label}${b.span ? ', ' + b.span : ''})` +
               `${r.pegBlockedOnAnnual ? '' : ', one quarter only'}</div>`;
      }
    }
    return `<tr class="rt-row"><th scope="row" class="rt-lbl" title="${tip.replace(/"/g,'&quot;')}">${label}</th>
      <td class="rt-val ${band ? 'rt-'+band : ''}">${display}${note}</td></tr>`;
  };
  const groups = RT_GROUPS.map(([title, rows]) => `
    <div class="rt-card">
      <div class="rt-card-h">${title}</div>
      <table class="rt-table"><tbody>${rows.map(x => cell(x[0], x[1], x[2], x[3])).join('')}</tbody></table>
    </div>`).join('');
  const scWarn = r.shareCountSuspect ? (() => {
    const sc = r.shareCountSuspect;
    const cr = n => '₹' + (n/1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' Cr';
    return `<div class="rt-warn"><b>The per-share figures below are not trustworthy for this stock.</b>
      The data source reports ${(sc.shares/1e7).toFixed(2)} crore shares outstanding, which at the current
      price implies a market value of ${cr(sc.impliedMcap)} against the ${cr(sc.feedMcap)} the same source
      reports. Those describe the same quantity and disagree by about ${sc.factor > 1 ? sc.factor.toFixed(0) : (1/sc.factor).toFixed(0)}
      times, so the share count is wrong somewhere. EPS, P/E, PEG, P/B, P/S and the yields all divide by it
      and inherit the error, which is why they are shown without a rating.
      The ratios above them, margins, returns on capital, leverage and cash, never touch the share count
      and are unaffected.</div>`;
  })() : '';
  const lenderNote = lender
    ? `<div class="rt-warn">This looks like a bank or financial company. Liquidity, turnover and debt ratios are marked <b>n/a</b> because they describe manufacturers and retailers, not lenders, for a bank, deposits are raw material, not a liability to worry about. Judge it on ROE, net margin and growth instead.</div>`
    : '';
  return `<div class="rt-wrap">
    <div class="rt-h">📐 Key Ratios</div>
    ${scWarn}${lenderNote}
    <div class="rt-grid">${groups}</div>
    <div class="rt-foot">Computed in your browser from the reported statements above and the current price, nothing is sent anywhere.
      n/r means the source did not carry the inputs, so the ratio is not shown rather than estimated.
      Colours are broad rules of thumb across ordinary businesses; a capital-heavy company and an asset-light one are not judged on the same numbers.
      Hover any label for what it measures.</div>
  </div>`;
}

// ══════════ FINANCIAL STATEMENTS: BALANCE SHEET / P&L / CASH FLOW ══════════
// Ratios like P/E tell you what the market thinks. The statements tell you what
// the business actually did.
//
// These come from Yahoo through the owner Worker (both endpoints need the
// cookie+crumb handshake a browser cannot perform). There are two of them:
//
//   1. fundamentals-timeseries, the endpoint Yahoo's own site uses. It carries
//      the full line items and simply omits what it does not have.
//   2. quoteSummary history modules, the older endpoint. Yahoo has hollowed
//      these out: for many listings it returns literal zeros for cost of
//      revenue, gross profit, operating expenses and tax, drops the balance
//      sheet entirely, and leaves cash flow with nothing but net income. It is
//      kept only as a fallback for symbols the timeseries endpoint misses.
//
// Coverage is honest, not assumed. A missing line shows as n/r, never as
// zero, because "we do not have this" and "this is zero" are different claims
// about a company's accounts. On the fallback endpoint a line that reads zero
// in every period is treated as unreported, because that endpoint is known to
// zero-fill lines it no longer carries.

// Yahoo wraps numbers as { raw, fmt, longFmt }; sometimes the key is absent
// entirely, and sometimes present as an empty object.
function _stNum(o){
  if(o == null) return null;
  if(typeof o === 'number') return isFinite(o) ? o : null;
  if(typeof o === 'object' && 'raw' in o && isFinite(+o.raw)) return +o.raw;
  return null;
}
function _stDate(o){
  const raw = _stNum(o);
  if(raw == null) return null;
  const d = new Date(raw * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
}

// Field maps: [label, timeseriesKey, quoteSummaryKey]. Order is the order shown.
// The timeseries key doubles as the row's identity, so derived figures below
// look the same whichever endpoint supplied the data. A null quoteSummary key
// means the old endpoint never carried that line at all.
const ST_INCOME = [
  ['Revenue',            'TotalRevenue',     'totalRevenue'],
  ['Cost of revenue',    'CostOfRevenue',    'costOfRevenue'],
  ['Gross profit',       'GrossProfit',      'grossProfit'],
  ['Operating expenses', 'OperatingExpense', 'totalOperatingExpenses'],
  ['Operating income',   'OperatingIncome',  'operatingIncome'],
  ['Pre-tax income',     'PretaxIncome',     'incomeBeforeTax'],
  ['Tax',                'TaxProvision',     'incomeTaxExpense'],
  ['Net income',         'NetIncome',        'netIncome'],
];
const ST_BALANCE = [
  ['Cash',                'CashAndCashEquivalents',              'cash'],
  ['Short-term invest.',  'OtherShortTermInvestments',           'shortTermInvestments'],
  ['Total current assets','CurrentAssets',                       'totalCurrentAssets'],
  ['Total assets',        'TotalAssets',                         'totalAssets'],
  ['Total current liab.', 'CurrentLiabilities',                  'totalCurrentLiabilities'],
  ['Long-term debt',      'LongTermDebt',                        'longTermDebt'],
  ['Total liabilities',   'TotalLiabilitiesNetMinorityInterest', 'totalLiab'],
  ['Total equity',        'StockholdersEquity',                  'totalStockholderEquity'],
];
const ST_CASHFLOW = [
  ['Operating cash flow', 'OperatingCashFlow',   'totalCashFromOperatingActivities'],
  ['Capital expenditure', 'CapitalExpenditure',  'capitalExpenditures'],
  ['Investing cash flow', 'InvestingCashFlow',   'totalCashflowsFromInvestingActivities'],
  ['Financing cash flow', 'FinancingCashFlow',   'totalCashFromFinancingActivities'],
  ['Net change in cash',  'ChangesInCash',       'changeInCash'],
  ['Free cash flow',      'FreeCashFlow',        null],
];

// A table is only a statement if at least one cell carries a number.
function _stFinish(periods, rows){
  if(!periods.length) return null;
  if(!rows.some(r => r.values.some(v => v != null))) return null;
  return { periods, rows };
}

// ── fundamentals-timeseries ────────────────────────────────────────────────
// Response shape: timeseries.result[] where each entry has meta.type[0] naming
// the series and a same-named array of { asOfDate, reportedValue }. Padded
// entries come through as null and are skipped.
function _stTsSeries(json){
  const res = json && json.timeseries && Array.isArray(json.timeseries.result)
            ? json.timeseries.result : null;
  if(!res) return null;
  const out = {};
  for(const r of res){
    const type = r && r.meta && Array.isArray(r.meta.type) ? r.meta.type[0] : null;
    if(!type || !Array.isArray(r[type])) continue;
    const m = out[type] || (out[type] = {});
    for(const e of r[type]){
      if(!e || !e.asOfDate) continue;
      const v = _stNum(e.reportedValue);
      if(v != null) m[e.asOfDate] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}
function _stTsTable(series, fields, prefix){
  if(!series) return null;
  const dates = new Set();
  for(const f of fields){
    const m = series[prefix + f[1]];
    if(m) Object.keys(m).forEach(d => dates.add(d));
  }
  const periods = Array.from(dates).sort().reverse().slice(0, 5);   // newest first
  const rows = fields.map(([label, key]) => ({
    label, key,
    values: periods.map(d => {
      const m = series[prefix + key];
      return (m && m[d] != null) ? m[d] : null;
    }),
  }));
  return _stFinish(periods, rows);
}
// Every line the endpoint returned, keyed without the period prefix, plus the
// union of every date seen. The ratio engine reads this: it needs line items
// (EBIT, inventory, share count) that the three display tables do not show.
function _stTsLines(series, prefix){
  if(!series) return null;
  const out = {};
  for(const k of Object.keys(series)){
    if(k.indexOf(prefix) !== 0) continue;
    out[k.slice(prefix.length)] = series[k];
  }
  return out;
}
function _stPeriodsAll(line){
  const dates = new Set();
  for(const k of Object.keys(line || {})) Object.keys(line[k]).forEach(d => dates.add(d));
  return Array.from(dates).sort().reverse();
}
// The fallback endpoint has no extra lines to offer, so its line map is just
// what the display tables already hold - nothing is invented to fill the gap.
function _stLinesFromTables(o){
  const line = {};
  for(const k of ['income','balance','cashflow']){
    const t = o[k];
    if(!t) continue;
    for(const r of t.rows){
      const m = line[r.key] || (line[r.key] = {});
      t.periods.forEach((d, i) => { if(r.values[i] != null) m[d] = r.values[i]; });
    }
  }
  return line;
}

function _stTsParse(json, quarterly){
  const series = _stTsSeries(json);
  if(!series) return null;
  const pre = quarterly ? 'quarterly' : 'annual';
  const out = {
    source:   'timeseries',
    income:   _stTsTable(series, ST_INCOME,   pre),
    balance:  _stTsTable(series, ST_BALANCE,  pre),
    cashflow: _stTsTable(series, ST_CASHFLOW, pre),
  };
  if(!(out.income || out.balance || out.cashflow)) return null;
  out.line = _stTsLines(series, pre) || {};
  out.periodsAll = _stPeriodsAll(out.line);
  return out;
}

// ── quoteSummary history modules (fallback) ────────────────────────────────
function _stTable(list, fields){
  if(!Array.isArray(list) || !list.length) return null;
  const stmts = list.map(s => ({ date: _stDate(s.endDate), s }))
                    .filter(x => x.date)
                    .sort((a,b) => a.date < b.date ? 1 : -1)     // newest first
                    .slice(0, 5);
  if(!stmts.length) return null;
  const rows = fields.map(([label, key, qsKey]) => {
    let values = qsKey ? stmts.map(x => _stNum(x.s[qsKey])) : stmts.map(() => null);
    // This endpoint zero-fills lines it no longer carries. A line that reads
    // exactly zero in every single period is that artefact, not an account
    // balance, so it is reported as unknown rather than as a confident zero.
    if(values.length && values.every(v => v === 0)) values = values.map(() => null);
    return { label, key, values };
  });
  return _stFinish(stmts.map(x => x.date), rows);
}
function _stParse(json, quarterly){
  const q = quarterly ? 'Quarterly' : '';
  const res = json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
  if(!res) return null;
  const pick = (mod, key) => (res[mod] && Array.isArray(res[mod][key])) ? res[mod][key] : null;
  const out = {
    source:   'quoteSummary',
    income:   _stTable(pick('incomeStatementHistory'+q,   'incomeStatementHistory'),   ST_INCOME),
    balance:  _stTable(pick('balanceSheetHistory'+q,      'balanceSheetStatements'),   ST_BALANCE),
    cashflow: _stTable(pick('cashflowStatementHistory'+q, 'cashflowStatements'),       ST_CASHFLOW),
  };
  if(!(out.income || out.balance || out.cashflow)) return null;
  out.line = _stLinesFromTables(out);
  out.periodsAll = _stPeriodsAll(out.line);
  return out;
}

// How much of a parsed result is actually filled in. Used to decide whether the
// timeseries answer was thin enough to be worth trying the fallback.
function _stCells(t){
  if(!t) return 0;
  let n = 0;
  for(const k of ['income','balance','cashflow']){
    if(t[k]) for(const r of t[k].rows) for(const v of r.values) if(v != null) n++;
  }
  return n;
}

// ── Fetch + render ─────────────────────────────────────────────────────────
let _stCache = {};      // key: sym|period

async function _stOne(url){
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if(!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
  finally { clearTimeout(tid); }
}

async function _stFetch(sym, quarterly){
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if(!sp || !sym) return null;
  const key = sym + '|' + (quarterly ? 'q' : 'a');
  if(_stCache[key] !== undefined) return _stCache[key];
  const per = quarterly ? '&period=quarterly' : '';
  const enc = encodeURIComponent(sym);
  let out = null;
  try {
    const tsJson = await _stOne(`${sp}/?timeseries=${enc}${per}`);
    out = tsJson ? _stTsParse(tsJson, quarterly) : null;
    // Only reach for the hollowed-out endpoint when the good one came back
    // empty or near-empty, never to "top up" an answer that already stands.
    if(_stCells(out) < 4){
      const qsJson = await _stOne(`${sp}/?statements=${enc}${per}`);
      const alt = qsJson ? _stParse(qsJson, quarterly) : null;
      if(_stCells(alt) > _stCells(out)) out = alt;
    }
  } catch(e) { out = null; }
  _stCache[key] = out;
  return out;
}

function _stFmt(v, isIndia){
  if(v == null) return '<span class="rt-na" title="Not reported: the data source did not carry this line.">n/r</span>';   // absent, not zero
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  const unit = isIndia ? '₹' : '$';
  // Grouped, always. A bare 192566.78 is read wrong at a glance far too easily.
  const g = (n, dp) => _finGroup(n, dp, isIndia);
  if(isIndia){
    if(a >= 1e7)  return sign + unit + g(a/1e7, 2) + ' ' + _finUnit('Cr');
    if(a >= 1e5)  return sign + unit + g(a/1e5, 2) + ' ' + _finUnit('L');
  } else {
    if(a >= 1e9)  return sign + unit + g(a/1e9, 2) + _finUnit('B');
    if(a >= 1e6)  return sign + unit + g(a/1e6, 2) + _finUnit('M');
  }
  return sign + unit + g(a, 0);
}

const ST_TOTAL_ROWS = ['NetIncome', 'StockholdersEquity', 'FreeCashFlow'];

function _stTableHtml(t, title, isIndia){
  if(!t) return `<div style="margin-bottom:18px"><div class="fin-h">${title}</div>
    <div style="font-size:12.5px;color:var(--text3)">Not available for this stock from the data source.</div></div>`;
  const head = t.periods.map(p => `<th>${p}</th>`).join('');
  const body = t.rows.map(r => {
    const cls = ST_TOTAL_ROWS.indexOf(r.key) >= 0 ? ' class="fin-total"' : '';
    return `<tr${cls}><th scope="row">${r.label}</th>${
      r.values.map(v => `<td>${_stFmt(v, isIndia)}</td>`).join('')}</tr>`;
  }).join('');
  return `<div style="margin-bottom:18px">
    <div class="fin-h">${title}</div>
    <div class="fin-scroll"><table class="fin-table"><thead><tr><th>Line item</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}

let _stQuarterly = false;
function stTogglePeriod(){ _stQuarterly = !_stQuarterly; renderStatements(); }

async function renderStatements(){
  const el = document.getElementById('stmt-body');
  if(!el) return;
  const ar = (typeof analysisResult !== 'undefined') ? analysisResult : null;
  if(!ar || !ar.symbol){ el.innerHTML = `<div style="font-size:12.5px;color:var(--text3)">Analyse a stock first.</div>`; return; }
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if(!sp){
    el.innerHTML = `<div style="font-size:12.5px;color:var(--text3)">Financial statements come through the data proxy. Deploy the Worker in <code>proxy/README.md</code> and this fills in automatically.</div>`;
    return;
  }
  const isIndia = (typeof marketMode !== 'undefined') && marketMode === 'india';
  const sym = isIndia ? (ar.symbol + (ar.market === 'BSE' ? '.BO' : '.NS')) : ar.symbol;
  el.innerHTML = `<div style="font-size:12.5px;color:var(--text3)">Fetching ${_stQuarterly ? 'quarterly' : 'annual'} statements for ${sym}…</div>`;
  const t = await _stFetch(sym, _stQuarterly);
  const toggle = `<button onclick="stTogglePeriod()" class="btn btn-sec btn-sm" style="margin-bottom:12px">
      ${_stQuarterly ? '📅 Show annual' : '📆 Show quarterly'}</button>`;
  if(!t){
    el.innerHTML = toggle + `<div style="font-size:12.5px;color:var(--text3)">
      No ${_stQuarterly ? 'quarterly' : 'annual'} statements available for <b>${sym}</b>.
      Yahoo's statement history is often thin or absent for smaller Indian listings, that is a gap in the source, not an error here.</div>`;
    return;
  }
  const price = (ar && typeof ar.currentPrice === 'number') ? ar.currentPrice : null;
  const ratios = (typeof ratiosHtml === 'function') ? ratiosHtml(t, ar.fundamentals, price) : '';
  // The Insights panel reads exactly the ratios shown above - one computation,
  // so the narrative can never describe numbers the table does not display.
  let insights = '';
  if(typeof insightsHtml === 'function'){
    _insPayload = insightPayload(t, ar.fundamentals, price, sym);
    insights = `<div id="ins-body">${insightsHtml()}</div>`;
  }
  const fallbackNote = t.source === 'quoteSummary'
    ? ` Yahoo's main statement feed had nothing for this symbol, so these came from its older, thinner one, expect gaps.`
    : '';
  el.innerHTML = toggle + ratios
    + _stTableHtml(t.income,   '📊 Profit &amp; Loss', isIndia)
    + _stTableHtml(t.balance,  '🏛 Balance Sheet',    isIndia)
    + _stTableHtml(t.cashflow, '💵 Cash Flow',        isIndia)
    + `<div class="fin-legend"><b>Reading the short forms:</b>
        <abbr class="fin-abbr" title="Crore, 1,00,00,000, i.e. ten million">Cr</abbr> = crore (1,00,00,000) ·
        <abbr class="fin-abbr" title="Lakh, 1,00,000, i.e. one hundred thousand">L</abbr> = lakh (1,00,000) ·
        <abbr class="fin-abbr" title="Times, a multiple, not a percentage. 2× means twice.">×</abbr> = times (a multiple) ·
        <b>n/r</b> = not reported by the data source ·
        <b>n/a</b> = does not describe this kind of business ·
        <b>n/m</b> = applies, but cannot be computed to anything meaningful.
        Hover any underlined term.</div>`
    + insights
    + `<div style="font-size:11px;color:var(--text3);margin-top:6px;padding:8px 12px;background:var(--surface2);border-radius:8px">
        Reported figures from the data source, newest period first. n/r means the source did not carry that line, not that the value is zero.${fallbackNote}
        Statement data can lag the latest filing; check the company's own filing before relying on it.
      </div>`;
  // The reading runs on its own rather than waiting to be asked for. It costs
  // a one-off runtime download, so it is deliberately the last thing to start
  // and the tables are already on screen by the time it does.
  if(typeof insRunBuiltin === 'function') insRunBuiltin();
}

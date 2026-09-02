// ══════════ FINANCIAL STATEMENTS: BALANCE SHEET / P&L / CASH FLOW ══════════
// Ratios like P/E tell you what the market thinks. The statements tell you what
// the business actually did. These come from Yahoo's quoteSummary history
// modules through the owner Worker (the endpoint needs the cookie+crumb
// handshake a browser cannot perform).
//
// Coverage is honest, not assumed: Yahoo's statement history for smaller Indian
// listings is often partial or absent. Every field is rendered only when the
// data actually carries it - a missing line shows as a dash, never as zero,
// because "we do not have this" and "this is zero" are different claims about
// a company's accounts.

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

// Field maps: [label, yahooKey]. Order is the order shown.
const ST_INCOME = [
  ['Revenue',            'totalRevenue'],
  ['Cost of revenue',    'costOfRevenue'],
  ['Gross profit',       'grossProfit'],
  ['Operating expenses', 'totalOperatingExpenses'],
  ['Operating income',   'operatingIncome'],
  ['Pre-tax income',     'incomeBeforeTax'],
  ['Tax',                'incomeTaxExpense'],
  ['Net income',         'netIncome'],
];
const ST_BALANCE = [
  ['Cash',               'cash'],
  ['Short-term invest.', 'shortTermInvestments'],
  ['Total current assets','totalCurrentAssets'],
  ['Total assets',       'totalAssets'],
  ['Total current liab.','totalCurrentLiabilities'],
  ['Long-term debt',     'longTermDebt'],
  ['Total liabilities',  'totalLiab'],
  ['Total equity',       'totalStockholderEquity'],
];
const ST_CASHFLOW = [
  ['Operating cash flow','totalCashFromOperatingActivities'],
  ['Capital expenditure','capitalExpenditures'],
  ['Investing cash flow','totalCashflowsFromInvestingActivities'],
  ['Financing cash flow','totalCashFromFinancingActivities'],
  ['Net change in cash', 'changeInCash'],
  ['Net income',         'netIncome'],
];

// Turn one Yahoo module into { periods:[dates], rows:[{label, values:[]}] }.
// Returns null when the module carries no usable statement at all, so the UI
// can say "not available" instead of drawing an empty grid.
function _stTable(list, fields){
  if(!Array.isArray(list) || !list.length) return null;
  const stmts = list.map(s => ({ date: _stDate(s.endDate), s }))
                    .filter(x => x.date)
                    .sort((a,b) => a.date < b.date ? 1 : -1)     // newest first
                    .slice(0, 5);
  if(!stmts.length) return null;
  const rows = fields.map(([label, key]) => ({
    label, key,
    values: stmts.map(x => _stNum(x.s[key])),
  }));
  // A table where every cell is missing is not a statement.
  if(!rows.some(r => r.values.some(v => v != null))) return null;
  return { periods: stmts.map(x => x.date), rows };
}

// Parse a whole quoteSummary response into the three statements.
function _stParse(json, quarterly){
  const q = quarterly ? 'Quarterly' : '';
  const res = json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
  if(!res) return null;
  const pick = (mod, key) => (res[mod] && Array.isArray(res[mod][key])) ? res[mod][key] : null;
  const out = {
    income:   _stTable(pick('incomeStatementHistory'+q,   'incomeStatementHistory'),   ST_INCOME),
    balance:  _stTable(pick('balanceSheetHistory'+q,      'balanceSheetStatements'),   ST_BALANCE),
    cashflow: _stTable(pick('cashflowStatementHistory'+q, 'cashflowStatements'),       ST_CASHFLOW),
  };
  return (out.income || out.balance || out.cashflow) ? out : null;
}

// Derived figures the statements support and ratios alone do not.
function _stDerived(t){
  if(!t) return null;
  const first = (tab, key) => {
    if(!tab) return null;
    const r = tab.rows.find(x => x.key === key);
    return r ? r.values[0] : null;
  };
  const rev = first(t.income, 'totalRevenue');
  const ni  = first(t.income, 'netIncome');
  const ocf = first(t.cashflow, 'totalCashFromOperatingActivities');
  const capex = first(t.cashflow, 'capitalExpenditures');
  const eq  = first(t.balance, 'totalStockholderEquity');
  const debt = first(t.balance, 'longTermDebt');
  const out = {};
  if(rev != null && rev !== 0 && ni != null) out.netMargin = ni / rev * 100;
  if(eq  != null && eq  !== 0 && ni != null) out.roe = ni / eq * 100;
  if(eq  != null && eq  !== 0 && debt != null) out.debtToEquity = debt / eq;
  // capex comes back negative; free cash flow is OCF plus that negative number.
  if(ocf != null && capex != null) out.freeCashFlow = ocf + capex;
  // Earnings backed by cash, or by accounting? A ratio well under 1 is a flag.
  if(ni != null && ni > 0 && ocf != null) out.cashConversion = ocf / ni;
  return Object.keys(out).length ? out : null;
}

// ── Fetch + render ─────────────────────────────────────────────────────────
let _stCache = {};      // key: sym|period

async function _stFetch(sym, quarterly){
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if(!sp || !sym) return null;
  const key = sym + '|' + (quarterly ? 'q' : 'a');
  if(_stCache[key] !== undefined) return _stCache[key];
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000);
    let r;
    try {
      r = await fetch(`${sp}/?statements=${encodeURIComponent(sym)}${quarterly ? '&period=quarterly' : ''}`,
                      { signal: ctrl.signal });
    } finally { clearTimeout(tid); }
    if(!r.ok) { _stCache[key] = null; return null; }
    const parsed = _stParse(await r.json(), quarterly);
    _stCache[key] = parsed;
    return parsed;
  } catch(e) { _stCache[key] = null; return null; }
}

function _stFmt(v, isIndia){
  if(v == null) return '<span style="color:var(--text3)">—</span>';   // absent, not zero
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  const unit = isIndia ? '₹' : '$';
  if(isIndia){
    if(a >= 1e7)  return sign + unit + (a/1e7).toFixed(2) + ' Cr';
    if(a >= 1e5)  return sign + unit + (a/1e5).toFixed(2) + ' L';
  } else {
    if(a >= 1e9)  return sign + unit + (a/1e9).toFixed(2) + 'B';
    if(a >= 1e6)  return sign + unit + (a/1e6).toFixed(2) + 'M';
  }
  return sign + unit + a.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function _stTableHtml(t, title, isIndia){
  if(!t) return `<div style="margin-bottom:16px"><div style="font-size:12px;font-weight:800;margin-bottom:6px">${title}</div>
    <div style="font-size:12.5px;color:var(--text3)">Not available for this stock from the data source.</div></div>`;
  const head = t.periods.map(p => `<th class="r" style="white-space:nowrap">${p}</th>`).join('');
  const body = t.rows.map(r => `<tr><td class="tn">${r.label}</td>${
      r.values.map(v => `<td class="r tm">${_stFmt(v, isIndia)}</td>`).join('')}</tr>`).join('');
  return `<div style="margin-bottom:18px">
    <div style="font-size:12px;font-weight:800;margin-bottom:6px">${title}</div>
    <div class="ts"><table style="min-width:520px"><thead><tr><th>Line item</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
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
      Yahoo's statement history is often thin or absent for smaller Indian listings — that is a gap in the source, not an error here.</div>`;
    return;
  }
  const d = _stDerived(t);
  const chip = (lbl,val,tip) => `<span title="${tip||''}" style="cursor:help;font-size:11.5px;color:var(--text2);background:var(--surface2);border:1px solid var(--border);padding:4px 10px;border-radius:20px;margin:0 6px 6px 0;display:inline-block">${lbl}: <b>${val}</b></span>`;
  const derived = d ? `<div style="margin-bottom:14px">
      ${d.netMargin!=null?chip('Net margin', d.netMargin.toFixed(1)+'%','Net income as a share of revenue, from the latest period shown.'):''}
      ${d.roe!=null?chip('ROE', d.roe.toFixed(1)+'%','Net income against shareholders equity.'):''}
      ${d.debtToEquity!=null?chip('Debt/Equity', d.debtToEquity.toFixed(2),'Long-term debt against equity. Above ~1 means the business leans on borrowing.'):''}
      ${d.freeCashFlow!=null?chip('Free cash flow', _stFmt(d.freeCashFlow, isIndia),'Operating cash flow after capital expenditure - what is actually left over.'):''}
      ${d.cashConversion!=null?chip('Cash conversion', d.cashConversion.toFixed(2),'Operating cash flow divided by net income. Well below 1 means profits are not turning into cash.'):''}
    </div>` : '';
  el.innerHTML = toggle + derived
    + _stTableHtml(t.income,   '📊 Profit &amp; Loss', isIndia)
    + _stTableHtml(t.balance,  '🏛 Balance Sheet',    isIndia)
    + _stTableHtml(t.cashflow, '💵 Cash Flow',        isIndia)
    + `<div style="font-size:11px;color:var(--text3);margin-top:6px;padding:8px 12px;background:var(--surface2);border-radius:8px">
        Reported figures from the data source, newest period first. A dash means the source did not carry that line — not that the value is zero.
        Statement data can lag the latest filing; check the company's own filing before relying on it.
      </div>`;
}

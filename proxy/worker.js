/**
 * MyeeStockBuddy CORS proxy, Cloudflare Worker
 * ---------------------------------------------
 * The app is a static page on GitHub Pages. Browsers block it from reading
 * Yahoo Finance / Stooq directly because those hosts don't send an
 * `Access-Control-Allow-Origin` header. This Worker sits in the middle: your
 * browser calls the Worker (which DOES send that header), the Worker fetches
 * the upstream server-to-server (no CORS between servers), and relays the body
 * back. Result: keyless price data through a proxy you own, so it can't be
 * rate-limited or monetised out from under you the way public proxies are.
 *
 * Two routes:
 *   ?url=<encoded upstream URL>   generic proxy, allow-listed to Yahoo + Stooq
 *   ?fundamentals=SYM1,SYM2,...   Yahoo quote with the cookie+crumb handshake
 *                                 that its fundamentals endpoint requires
 *                                 (P/E, P/B, dividend yield, market cap, ...).
 *   ?quotesummary=SYM&modules=..  Yahoo quoteSummary with the handshake: sector,
 *                                 P/E, PEG, P/B, EV/EBITDA, dividend yield.
 *                                 Modules are validated, not passed through raw.
 *   ?timeseries=SYM&period=...    Balance sheet, P&L and cash flow history from
 *                                 Yahoo's fundamentals-timeseries endpoint,
 *                                 the one that still carries the full line
 *                                 items. period=quarterly, otherwise annual.
 *   ?statements=SYM&period=...    The older quoteSummary history modules. Kept
 *                                 as a fallback: Yahoo has hollowed these out
 *                                 (zero-filled lines, missing balance sheet),
 *                                 so the app only falls back to it when the
 *                                 timeseries route returns nothing.
 *
 * It is NOT an open proxy: only the two data hosts below are allowed on ?url=,
 * and the fundamentals route only ever talks to Yahoo.
 *
 * Deploy: see proxy/README.md. Free tier = 100,000 requests/day, no card.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Only these upstream hosts may be fetched by the generic ?url= route.
const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'stooq.com',
]);

// Exported so the test suite can exercise the allowlist logic directly.
export function isAllowedTarget(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;      // no http, no file, no data:
  return ALLOWED_HOSTS.has(u.hostname);
}

// Line items requested from fundamentals-timeseries. The endpoint takes an
// explicit type list; each entry is prefixed with `annual` or `quarterly`.
// Kept in sync with the field maps in src/js/statements.js.
const TS_FIELDS = [
  // Income statement
  'TotalRevenue', 'CostOfRevenue', 'GrossProfit', 'OperatingExpense',
  'OperatingIncome', 'PretaxIncome', 'TaxProvision', 'NetIncome',
  // Balance sheet
  'CashAndCashEquivalents', 'OtherShortTermInvestments', 'CurrentAssets',
  'TotalAssets', 'CurrentLiabilities', 'LongTermDebt',
  'TotalLiabilitiesNetMinorityInterest', 'StockholdersEquity',
  // Cash flow
  'OperatingCashFlow', 'CapitalExpenditure', 'InvestingCashFlow',
  'FinancingCashFlow', 'ChangesInCash', 'FreeCashFlow',
  // Not shown as statement rows, but the ratio engine needs them: ROCE and
  // interest cover want EBIT, the liquidity and turnover ratios want inventory
  // and receivables, and per-share figures want the share count.
  'EBIT', 'EBITDA', 'InterestExpense', 'Inventory', 'AccountsReceivable',
  'TotalDebt', 'InvestedCapital', 'DilutedEPS', 'OrdinarySharesNumber',
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const _text = (body, status) =>
  new Response(body, { status, headers: CORS_HEADERS });

// Relay an upstream response, adding CORS and preserving the content type.
function _relay(upstream) {
  const headers = new Headers(CORS_HEADERS);
  const ct = upstream.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);
  return new Response(upstream.body, { status: upstream.status, headers });
}

// Yahoo's quote/quoteSummary endpoints require a session cookie plus a matching
// "crumb" token. Fetch a cookie, then a crumb bound to it. Servers can do this;
// browsers can't (cross-site cookies), which is exactly why it lives here.
async function _yahooAuth() {
  const c = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
  let cookies = [];
  if (typeof c.headers.getSetCookie === 'function') cookies = c.headers.getSetCookie();
  else { const sc = c.headers.get('set-cookie'); if (sc) cookies = [sc]; }
  const cookie = cookies.map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
  const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/plain' },
  });
  const crumb = (await cr.text()).trim();
  return { cookie, crumb };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== 'GET')     return _text('Method Not Allowed', 405);

    const params = new URL(request.url).searchParams;

    // ── Fundamentals route: one Yahoo v7 quote call for many symbols ────────
    const fsyms = params.get('fundamentals');
    if (fsyms) {
      if (!/^[A-Za-z0-9.\-^,]{1,400}$/.test(fsyms)) return _text('Bad symbols', 400);
      try {
        const { cookie, crumb } = await _yahooAuth();
        const q = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(fsyms)}&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(q, { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'application/json' } });
        return _relay(r);
      } catch (e) {
        return _text('Fundamentals fetch failed: ' + (e && e.message), 502);
      }
    }

    // ── quoteSummary: the valuation figures, which also need the crumb ─────
    const qsym = params.get('quotesummary');
    if (qsym) {
      if (!/^[A-Za-z0-9.\-^]{1,20}$/.test(qsym)) return _text('Bad symbol', 400);
      const mods = (params.get('modules') || '').trim();
      // Module names only. Not a pass-through: anything else is refused rather
      // than forwarded to Yahoo on the caller's say-so.
      if (!/^[A-Za-z]{1,40}(,[A-Za-z]{1,40}){0,9}$/.test(mods)) return _text('Bad modules', 400);
      try {
        const { cookie, crumb } = await _yahooAuth();
        const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(qsym)}`
                + `?modules=${mods}&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(u, { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'application/json' } });
        return _relay(r);
      } catch (e) {
        return _text('quoteSummary fetch failed: ' + (e && e.message), 502);
      }
    }

    // ── Statements via fundamentals-timeseries (the route with real data) ──
    const tsym = params.get('timeseries');
    if (tsym) {
      if (!/^[A-Za-z0-9.\-^]{1,20}$/.test(tsym)) return _text('Bad symbol', 400);
      const pre = params.get('period') === 'quarterly' ? 'quarterly' : 'annual';
      const types = TS_FIELDS.map(f => pre + f).join(',');
      const p2 = Math.floor(Date.now() / 1000);
      const p1 = p2 - 10 * 365 * 24 * 3600;          // ten years back is plenty
      try {
        const { cookie, crumb } = await _yahooAuth();
        const sym = encodeURIComponent(tsym);
        const u = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}`
                + `?symbol=${sym}&type=${types}&period1=${p1}&period2=${p2}`
                + `&merge=false&padTimeSeries=true&lang=en-US&region=US&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(u, { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'application/json' } });
        return _relay(r);
      } catch (e) {
        return _text('Timeseries fetch failed: ' + (e && e.message), 502);
      }
    }

    // ── Statements via the older quoteSummary modules (fallback only) ───────
    const ssym = params.get('statements');
    if (ssym) {
      if (!/^[A-Za-z0-9.\-^]{1,20}$/.test(ssym)) return _text('Bad symbol', 400);
      const q = params.get('period') === 'quarterly' ? 'Quarterly' : '';
      const mods = `incomeStatementHistory${q},balanceSheetHistory${q},cashflowStatementHistory${q}`;
      try {
        const { cookie, crumb } = await _yahooAuth();
        const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ssym)}`
                + `?modules=${mods}&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(u, { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'application/json' } });
        return _relay(r);
      } catch (e) {
        return _text('Statements fetch failed: ' + (e && e.message), 502);
      }
    }

    // ── Generic proxy route (allow-listed) ──────────────────────────────────
    const target = params.get('url');
    if (!target) return _text('Missing ?url= parameter', 400);
    if (!isAllowedTarget(target)) return _text('Target host not allowed', 403);
    try {
      const upstream = await fetch(target, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/csv, */*' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      return _relay(upstream);
    } catch (e) {
      return _text('Upstream fetch failed: ' + (e && e.message), 502);
    }
  },
};

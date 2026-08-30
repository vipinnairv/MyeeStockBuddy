/**
 * MyeeStockBuddy CORS proxy — Cloudflare Worker
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

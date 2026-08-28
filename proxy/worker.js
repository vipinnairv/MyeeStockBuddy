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
 * It is NOT an open proxy: only the two data hosts below are allowed, so
 * nobody can abuse your Worker to fetch arbitrary URLs.
 *
 * Deploy: see proxy/README.md. Free tier = 100,000 requests/day, no card.
 *
 * Usage from the app:  https://<your-worker-url>/?url=<encoded upstream URL>
 */

// Only these upstream hosts may be fetched. Keep this tight.
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

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400, headers: CORS_HEADERS });
    }
    if (!isAllowedTarget(target)) {
      return new Response('Target host not allowed', { status: 403, headers: CORS_HEADERS });
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        // A desktop UA keeps Yahoo from serving a consent interstitial.
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/csv, */*',
        },
        // Cache upstream responses at the edge for a few minutes so repeat
        // fetches of the same symbol don't burn your daily request budget.
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + (e && e.message), {
        status: 502, headers: CORS_HEADERS,
      });
    }

    // Relay status + body, add CORS, preserve the upstream content type.
    const headers = new Headers(CORS_HEADERS);
    const ct = upstream.headers.get('content-type');
    if (ct) headers.set('Content-Type', ct);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

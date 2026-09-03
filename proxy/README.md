# MyeeStockBuddy data proxy (Cloudflare Worker)

A ~85-line Cloudflare Worker that lets the static app fetch Yahoo Finance and
Stooq **without any API key**. It adds the CORS header those hosts don't send, so the browser is allowed to read the response. Because the Worker is *yours*,
it can't be rate-limited or shut off the way the public CORS proxies were.

- **Free:** Cloudflare's free plan gives 100,000 requests/day. No credit card.
- **Safe:** it only proxies `query1/query2.finance.yahoo.com` and `stooq.com`
  (see `ALLOWED_HOSTS` in `worker.js`). It is not an open proxy.
- **Cached:** repeat fetches of the same symbol are served from Cloudflare's
  edge cache for 5 minutes, so you rarely touch the daily budget.

## Deploy in ~5 minutes

### Option A, Cloudflare dashboard (no tools to install)

1. Sign up / log in at <https://dash.cloudflare.com>.
2. Left sidebar → **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name, e.g. `myee-proxy`. Click **Deploy** (the placeholder code).
4. Click **Edit code**. Delete everything, paste the full contents of
   [`worker.js`](./worker.js), then **Deploy**.
5. Copy the Worker URL shown at the top, it looks like
   `https://myee-proxy.<your-subdomain>.workers.dev`.

### Option B, Wrangler CLI

```bash
npm i -g wrangler
wrangler login
cd proxy
wrangler deploy worker.js --name myee-proxy
```

## Connect it to the app

Once you have the Worker URL, plug it into the app one of two ways:

- **Test it instantly (this browser only):** open the app, press F12 →
  Console, and run
  ```js
  localStorage.setItem('self_proxy_url', 'https://myee-proxy.<your-subdomain>.workers.dev');
  ```
  Reload and fetch a stock. This overrides the built-in value for you only.

- **Turn it on for everyone:** set `SELF_PROXY_URL` in `index.html`
  (and `src/index.template.html`) to your Worker URL, rebuild
  (`node build.js`), and push. Every visitor then fetches through your Worker
  with no key and no setup. (Tell Claude the URL and it'll wire this in for you.)

## Updating the Worker (redeploy after each change here)

**If you deployed before the Financials tab existed, redeploy now.** The latest
`worker.js` adds a **timeseries route** that reads Yahoo's
`fundamentals-timeseries` endpoint, the one Yahoo's own site uses. The older
`quoteSummary` history modules it replaces have been hollowed out: for many
listings they return literal zeros for cost of revenue, gross profit, operating
expenses and tax, drop the balance sheet entirely, and leave cash flow with
nothing but net income. The old route is kept only as a fallback for symbols the
new one misses, and the app labels the tables when it has to use it.

If you deployed an earlier version still, re-paste `worker.js` and redeploy once
to get the **fundamentals route** too. It adds P/E, P/B, dividend yield and market cap
to the Portfolio Manager's valuation card, fetched automatically on
"Refresh All Prices". This route does Yahoo's cookie+crumb handshake (which its
fundamentals endpoint requires and a browser can't do), and only ever talks to
Yahoo. Yahoo's fundamentals are flakier than prices, so coverage may be partial.

## How the app calls it

```
GET https://<your-worker-url>/?url=<url-encoded upstream URL>
```
```
GET https://<your-worker-url>/?fundamentals=RELIANCE.NS,AAPL,TCS.NS
```
```
GET https://<your-worker-url>/?timeseries=RELIANCE.NS&period=quarterly
```
```
GET https://<your-worker-url>/?statements=RELIANCE.NS      # fallback only
```

e.g. `…workers.dev/?url=https%3A%2F%2Fquery2.finance.yahoo.com%2Fv8%2F…`
The Worker validates the host, fetches it, and returns the JSON/CSV with
`Access-Control-Allow-Origin: *`.

## Quick self-test

```bash
curl "https://myee-proxy.<your-subdomain>.workers.dev/?url=https%3A%2F%2Fquery2.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FRELIANCE.NS%3Frange%3D5d%26interval%3D1d"
```
A JSON body with `chart.result` means it works. A `403 Target host not allowed`
means the URL host isn't in `ALLOWED_HOSTS`.

// ══════════ CRYPTO SYMBOL RESOLUTION ══════════
// Holdings store a CoinGecko-style id ('bitcoin', 'ripple'); price feeds want
// an exchange ticker ('BTC', 'XRP'). The refresh used to just upper-case the id
// and append the currency, producing BITCOIN-INR / RIPPLE-INR - symbols that do
// not exist - so every crypto price silently failed to update while the toast
// still reported success for the equities.
//
// Ripple shows why truncation cannot work: its id is 'ripple' but its ticker is
// XRP. A real lookup is needed.

const COIN_TICKERS = {
  bitcoin:'BTC', ethereum:'ETH', tether:'USDT', binancecoin:'BNB', solana:'SOL',
  ripple:'XRP', 'usd-coin':'USDC', cardano:'ADA', dogecoin:'DOGE', tron:'TRX',
  'avalanche-2':'AVAX', avalanche:'AVAX', chainlink:'LINK', polkadot:'DOT',
  'matic-network':'MATIC', polygon:'MATIC', 'shiba-inu':'SHIB', litecoin:'LTC',
  'bitcoin-cash':'BCH', stellar:'XLM', uniswap:'UNI', cosmos:'ATOM',
  monero:'XMR', 'ethereum-classic':'ETC', filecoin:'FIL', aptos:'APT',
  arbitrum:'ARB', optimism:'OP', 'near-protocol':'NEAR', near:'NEAR',
  algorand:'ALGO', vechain:'VET', hedera:'HBAR', 'internet-computer':'ICP',
  maker:'MKR', aave:'AAVE', sui:'SUI', toncoin:'TON', pepe:'PEPE',
};

// Resolve one holding to an exchange ticker, or null when it cannot be known.
// Returning null is deliberate: fetching a made-up symbol wastes a request and
// produces a silent failure, which is exactly the bug this replaces.
function cryptoTicker(h, db){
  if(!h) return null;
  const explicit = (h.ticker || h.symbol || '').trim();
  if(explicit){                                   // user typed a ticker - trust it
    const base = explicit.toUpperCase().split('-')[0].trim();
    if(/^[A-Z0-9]{2,6}$/.test(base)) return base;
  }
  const id = String(h.coinId || '').trim().toLowerCase();
  if(id && COIN_TICKERS[id]) return COIN_TICKERS[id];

  // Fall back to the app's own coin list, matched on display name. Entries look
  // like ['XRP (Ripple)','XRP-USD',...] so a parenthetical alias also matches.
  const want = String(h.coin || '').trim().toLowerCase();
  if(want && Array.isArray(db)){
    for(const row of db){
      const name = String(row[0] || '').toLowerCase();
      const sym  = String(row[1] || '').toUpperCase().split('-')[0];
      if(!sym) continue;
      const alias = (name.match(/\(([^)]+)\)/) || [])[1];
      const bare  = name.replace(/\s*\([^)]*\)\s*/g,'').trim();
      if(name === want || bare === want || (alias && alias === want)) return sym;
    }
  }
  // Last resort: the id already IS a ticker (someone typed BTC, not bitcoin).
  if(/^[a-z0-9]{2,6}$/.test(id) && !/^[a-z]{7,}$/.test(id)) return id.toUpperCase();
  return null;
}

// Full market symbol for a quote feed, e.g. BTC-INR. Returns null when the
// ticker cannot be resolved.
function cryptoMarketSymbol(h, cur, db){
  const t = cryptoTicker(h, db);
  return t ? t + '-' + (cur || 'INR') : null;
}

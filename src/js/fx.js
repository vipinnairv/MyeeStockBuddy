// ══════════ USD/INR AUTO-REFRESH ══════════
// The rate was manual: a prompt() the user had to remember to update. Every US
// holding's rupee value, the portfolio total and the tax figures all scale by
// it, so a stale rate quietly skews the whole book. It now refreshes itself
// once a day through the owner Worker, while staying manually overridable.

const _FX_KEY  = 'usdinr_fetch';     // { d:'YYYY-MM-DD', v:Number, manual:bool }
const _FX_SYM  = 'USDINR=X';

function _fxLoad(){
  try { const o = JSON.parse(localStorage.getItem(_FX_KEY) || 'null');
        return (o && isFinite(+o.v) && +o.v > 0) ? o : null; } catch(e) { return null; }
}
function _fxSave(o){ try { localStorage.setItem(_FX_KEY, JSON.stringify(o)); } catch(e) {} }

// A rate is stale once the calendar day has moved on.
function _fxIsStale(rec, today){
  if(!rec || !rec.d) return true;
  return rec.d !== today;
}
// Sanity band. A bad parse or a wrong symbol could return something absurd
// (a share price, a percentage); silently adopting it would corrupt every US
// valuation. Outside this range we keep the existing rate.
function _fxPlausible(v){ return isFinite(+v) && +v >= 30 && +v <= 200; }

// Record a manual entry so the daily fetch does not immediately overwrite it
// on the same day.
function fxSetManual(v){
  if(!_fxPlausible(v)) return false;
  S.usdInr = +v;
  _fxSave({ d:new Date().toISOString().slice(0,10), v:+v, manual:true });
  return true;
}

async function fxRefresh(force){
  const today = new Date().toISOString().slice(0,10);
  const rec = _fxLoad();
  if(!force && rec && !_fxIsStale(rec, today)) return null;      // already done today
  const sp = (typeof _selfProxyUrl === 'function') ? _selfProxyUrl() : '';
  if(!sp) return null;                                           // no proxy, keep manual value
  let v = null;
  try {
    if(typeof _fetchLivePrice === 'function') v = await _fetchLivePrice(_FX_SYM, 'FX');
  } catch(e) {}
  if(!_fxPlausible(v)) return null;                              // refuse an implausible rate
  S.usdInr = +(+v).toFixed(4);
  _fxSave({ d:today, v:S.usdInr, manual:false });
  try { if(typeof save === 'function') save(); } catch(e) {}
  try {
    const el = document.getElementById('usd-hdr');
    if(el) el.textContent = '₹' + S.usdInr;
    if(typeof renderAll === 'function') renderAll();
  } catch(e) {}
  return S.usdInr;
}

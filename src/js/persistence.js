// ══════════ PORTFOLIO PERSISTENCE ══════════
// The portfolio is the one thing in this app that cannot be re-fetched. The
// old version wrote it and swallowed every error, so a full localStorage quota
// meant holdings silently stopped saving while the UI still said "saved".
// Now: caches are evicted to make room (never portfolio data), the write is
// read back to prove it landed, and a persistent banner appears if it did not.
const _PORTFOLIO_KEY='imp_data';
// Keys we are allowed to sacrifice for space. All are re-fetchable caches.
const _EVICTABLE=[ k => k.startsWith('ohlcv_'), k => k.startsWith('mfnav_') ];
function _isEvictable(k){ return _EVICTABLE.some(f=>f(k)); }
function _cacheEntryTs(k){
  try{ const o=JSON.parse(localStorage.getItem(k)); return (o&&(o.ts||o.t))||0; }catch(e){ return 0; }
}
// Drop the oldest re-fetchable cache entries. Returns how many were removed.
function _evictCaches(maxDrop){
  let dropped=0;
  try{
    const cands=Object.keys(localStorage).filter(_isEvictable)
      .map(k=>({k,ts:_cacheEntryTs(k)})).sort((a,b)=>a.ts-b.ts);
    for(const c of cands){
      if(dropped>=maxDrop) break;
      try{ localStorage.removeItem(c.k); dropped++; }catch(e){}
    }
  }catch(e){}
  return dropped;
}
function _saveFailedBanner(show,detail){
  let el=document.getElementById('save-fail-banner');
  if(!show){ if(el) el.remove(); return; }
  if(!el){
    el=document.createElement('div');
    el.id='save-fail-banner';
    el.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:5000;background:#B42318;color:#fff;'
      +'padding:12px 16px;font-size:13px;line-height:1.5;box-shadow:0 -4px 18px rgba(0,0,0,.3);'
      +'display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-family:inherit';
    document.body.appendChild(el);
  }
  el.innerHTML='<b>⚠ Your changes are NOT being saved.</b>'
    +'<span style="opacity:.92">'+(detail||'Browser storage is full or unavailable.')
    +' Download a backup now so you do not lose this data.</span>'
    +'<button onclick="exportJSON()" style="background:#fff;color:#B42318;border:none;font-weight:800;'
    +'padding:6px 13px;border-radius:7px;cursor:pointer;font-size:12px;font-family:inherit">⬇ Download backup</button>';
}
function saveLocal(){
  let payload;
  try{ payload=JSON.stringify(S); }
  catch(e){ _logErr(e,'saveLocal:serialise'); _saveFailedBanner(true,'The portfolio could not be serialised.'); return false; }
  // Attempt, then make room and retry. Portfolio data is never evicted.
  for(let attempt=0; attempt<3; attempt++){
    try{
      localStorage.setItem(_PORTFOLIO_KEY,payload);
      // Prove it actually landed - a silent truncation is still data loss.
      if(localStorage.getItem(_PORTFOLIO_KEY)===payload){ _saveFailedBanner(false); return true; }
    }catch(e){}
    if(_evictCaches(attempt===0?12:60)===0) break;   // nothing left to sacrifice
  }
  _logErr(new Error('localStorage full; portfolio not saved'),'saveLocal:quota');
  _saveFailedBanner(true,'Browser storage is full and could not be cleared.');
  try{ if(typeof toast==='function') toast('Could not save - download a backup!','err'); }catch(e){}
  return false;
}


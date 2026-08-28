/* ══ DIAGNOSTICS ══
   101 empty catch blocks used to swallow every failure, which made user reports
   impossible to act on. Errors now land in a bounded ring buffer that survives
   reload and can be copied straight out of Data Management. */
const _ERR_KEY='diag_errors', _ERR_MAX=40;
function _logErr(err, ctx){
  try{
    const e={ t:Date.now(), ctx:String(ctx||'').slice(0,80),
      // 300 chars cut the per-source fetch breakdown off mid-sentence, losing
      // the very entries that identify which source failed and why.
      msg:String((err&&(err.message||err))||'unknown').slice(0,900),
      where:String((err&&err.stack||'').split('\n')[1]||'').trim().slice(0,160) };
    let log=[]; try{ log=JSON.parse(localStorage.getItem(_ERR_KEY)||'[]'); }catch(_){}
    log.push(e); if(log.length>_ERR_MAX) log=log.slice(-_ERR_MAX);
    try{ localStorage.setItem(_ERR_KEY,JSON.stringify(log)); }catch(_){}
    if(typeof renderDiagnostics==='function' && document.getElementById('diag-list')) renderDiagnostics();
  }catch(_){}
}
window.addEventListener('error', e=>_logErr(e.error||e.message,'window'));
window.addEventListener('unhandledrejection', e=>_logErr(e.reason,'promise'));
function clearDiagnostics(){ try{ localStorage.removeItem(_ERR_KEY); }catch(e){} renderDiagnostics(); }
function copyDiagnostics(){
  let log=[]; try{ log=JSON.parse(localStorage.getItem(_ERR_KEY)||'[]'); }catch(e){}
  const txt=log.map(e=>new Date(e.t).toISOString()+'  ['+e.ctx+']  '+e.msg+(e.where?'  @ '+e.where:'')).join('\n')||'No errors recorded.';
  try{ navigator.clipboard.writeText(txt); toast('Diagnostics copied','ok'); }
  catch(e){ toast('Copy failed - select the text manually','err'); }
}
function renderDiagnostics(){
  const el=document.getElementById('diag-list'); if(!el) return;
  let log=[]; try{ log=JSON.parse(localStorage.getItem(_ERR_KEY)||'[]'); }catch(e){}
  if(!log.length){ el.innerHTML='<div style="font-size:12.5px;color:var(--T3)">No errors recorded. If something misbehaves, come back here - the details will be waiting.</div>'; return; }
  el.innerHTML=log.slice().reverse().map(e=>
    '<div style="border-bottom:1px solid var(--bd);padding:7px 0;font-size:12px">'
    +'<div style="color:var(--T3);font-size:10.5px">'+new Date(e.t).toLocaleString()+' · '+e.ctx+'</div>'
    +'<div style="color:var(--R);font-weight:600">'+e.msg.replace(/</g,'&lt;')+'</div>'
    +(e.where?'<div style="color:var(--T3);font-size:10.5px">'+e.where.replace(/</g,'&lt;')+'</div>':'')
    +'</div>').join('');
}


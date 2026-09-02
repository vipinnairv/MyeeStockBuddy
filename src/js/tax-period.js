// ══════════ TAX REPORTING PERIOD ══════════
// The report was locked to a hard-coded list of financial years with a stale
// default, and offered no way to look at an arbitrary window - a quarter, a
// month, or the run-up to a sale. One resolver now serves every consumer so the
// Taxation tab and the harvesting card can never disagree about the period.

// India's financial year runs 1 April to 31 March, so a date in Jan-Mar belongs
// to the FY that STARTED in the previous calendar year.
function currentFY(now){
  const d = now || new Date();
  const y = d.getFullYear();
  const startYear = (d.getMonth() >= 3) ? y : y - 1;      // month 3 = April
  return startYear + '-' + String((startYear + 1) % 100).padStart(2, '0');
}

// Financial years to offer: the current one plus the previous few.
function fyOptions(now, back){
  const cur = currentFY(now);
  const start = +cur.split('-')[0];
  const n = isFinite(+back) ? +back : 3;
  const out = [];
  for(let i = 0; i <= n; i++){
    const s = start - i;
    out.push({ value: s + '-' + String((s+1) % 100).padStart(2,'0'),
               label: `AY ${s+1}-${String((s+2) % 100).padStart(2,'0')} (FY ${s}-${String((s+1) % 100).padStart(2,'0')})` });
  }
  return out;
}

// Resolve whatever the UI has selected into a concrete window.
// Returns { start, end, label, custom, error } - error is set when a custom
// range is incomplete or inverted, so the caller can refuse to report numbers
// rather than computing over a nonsense window.
function taxPeriod(sel, fromStr, toStr){
  if(sel !== 'custom'){
    const fy = sel || currentFY();
    const y1 = +String(fy).split('-')[0];
    if(!isFinite(y1)) return { error: 'Unrecognised financial year.' };
    return {
      start: new Date(`${y1}-04-01T00:00:00`),
      end:   new Date(`${y1+1}-03-31T23:59:59.999`),
      label: `FY ${fy}`, custom: false,
    };
  }
  if(!fromStr || !toStr) return { error: 'Pick both a start and an end date.', custom: true };
  const a = new Date(`${fromStr}T00:00:00`), b = new Date(`${toStr}T23:59:59.999`);
  if(isNaN(a.getTime()) || isNaN(b.getTime())) return { error: 'Those dates could not be read.', custom: true };
  if(a > b) return { error: 'The start date is after the end date.', custom: true };
  return { start: a, end: b, label: `${fromStr} to ${toStr}`, custom: true };
}

// What the UI currently has selected, wherever it is read from.
function taxPeriodFromUI(){
  const sel  = document.getElementById('tax-fy')?.value || currentFY();
  const from = document.getElementById('tax-from')?.value || '';
  const to   = document.getElementById('tax-to')?.value || '';
  return taxPeriod(sel, from, to);
}

// Show or hide the custom date inputs.
function taxPeriodToggle(){
  const custom = document.getElementById('tax-fy')?.value === 'custom';
  const box = document.getElementById('tax-custom-range');
  if(box) box.style.display = custom ? 'inline-flex' : 'none';
  if(typeof renderTaxation === 'function') renderTaxation();
  if(typeof renderIfSold === 'function') { try { renderIfSold(); } catch(e) {} }
}

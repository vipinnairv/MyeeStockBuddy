// ══════════════════════ INSIGHTS ══════════════════════
// Two readings of the same numbers, and they are not equivalent.
//
//  Built-in, src/py/interpret.py, real CPython running in this tab through
//  Pyodide (WebAssembly). Free, deterministic, and nothing leaves the device.
//  The Python is unit-tested in tests/test_interpret.py, so what it says here
//  is what the test suite proved it says.
//
//  AI model, your own API key, your own account, your own bill. This one DOES
//  send the figures to the provider you pick, so it is opt-in per session and
//  says so before it sends anything. The key is kept in this browser's
//  localStorage and goes nowhere except that provider's API.

const AI_PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    cost: 'Has a genuinely free tier, the usual starting point.',
    model: 'gemini-2.0-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    steps: [
      'Open <b>aistudio.google.com/app/apikey</b> and sign in with a Google account.',
      'Click <b>Create API key</b>, then pick a Google Cloud project (or let it make one).',
      'Copy the key, it starts with <code>AIza</code>, and paste it below.',
      'The free tier is rate-limited per minute, not billed. No card needed to start.',
    ],
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    cost: 'Paid. Needs credit on the account; a reading of one stock costs a fraction of a cent.',
    model: 'claude-sonnet-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    steps: [
      'Open <b>console.anthropic.com</b> and sign in.',
      'Go to <b>Settings → API keys</b> and click <b>Create key</b>.',
      'Add credit under <b>Billing</b>, there is no free tier, so a key with no credit will fail.',
      'Copy the key, it starts with <code>sk-ant-</code>, and paste it below.',
    ],
  },
  openai: {
    label: 'OpenAI',
    cost: 'Paid. Needs credit on the account.',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    steps: [
      'Open <b>platform.openai.com/api-keys</b> and sign in.',
      'Click <b>Create new secret key</b> and copy it immediately, it is shown once.',
      'Add credit under <b>Billing</b>; a key on an account with no credit returns a quota error.',
      'The key starts with <code>sk-</code>.',
    ],
  },
};

const AI_KEY_PREFIX = 'ai_key_';
const AI_MODEL_PREFIX = 'ai_model_';
const AI_PROVIDER_KEY = 'ai_provider';

function _aiGet(k, dflt){ try { return localStorage.getItem(k) || dflt || ''; } catch(e){ return dflt || ''; } }
function _aiSet(k, v){ try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch(e){} }
function _aiProvider(){ const p = _aiGet(AI_PROVIDER_KEY, 'gemini'); return AI_PROVIDERS[p] ? p : 'gemini'; }

// Everything the API sees. Built explicitly rather than by serialising whatever
// happens to be in scope, so it is auditable: figures and identifiers only, no
// holdings, no portfolio, no key material.
function insightPayload(t, fund, price, symbol){
  const r = computeRatios(t, fund, price);
  const lender = isLender(fund);
  const bands = {};
  // Banded the same way the panel bands them, lender rules included, so the
  // written reading and the coloured table cannot disagree.
  for(const k of Object.keys(r)) { const b = ratioBand(k, r[k], lender); if(b) bands[k] = b; }
  return {
    symbol: symbol || null,
    sector: (fund && (fund.sector || fund.industry)) || null,
    lender: lender,
    depositRate: 7.0,
    ratios: r,
    bands: bands,
  };
}

// ── Built-in reading: Python via Pyodide ───────────────────────────────────
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
let _pyPromise = null;

async function _loadPyodide(onStatus){
  if(_pyPromise) return _pyPromise;
  _pyPromise = (async () => {
    if(typeof loadPyodide !== 'function'){
      if(onStatus) onStatus('Fetching the Python runtime (about 10 MB, once per visit)…');
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = PYODIDE_URL;
        s.onload = res;
        s.onerror = () => rej(new Error('could not fetch the Python runtime'));
        document.head.appendChild(s);
      });
    }
    if(onStatus) onStatus('Starting Python…');
    const py = await loadPyodide();
    py.runPython(PY_INTERPRET);
    return py;
  })();
  // A failed load must not poison every later attempt.
  _pyPromise.catch(() => { _pyPromise = null; });
  return _pyPromise;
}

async function runBuiltinInsight(payload, onStatus){
  const py = await _loadPyodide(onStatus);
  if(onStatus) onStatus('Reading the numbers…');
  const fn = py.globals.get('interpret_json');
  try {
    return JSON.parse(fn(JSON.stringify(payload)));
  } finally {
    if(fn && typeof fn.destroy === 'function') fn.destroy();
  }
}

// ── AI reading: the user's own key ─────────────────────────────────────────
function aiPrompt(payload){
  const lines = [];
  lines.push('You are explaining a company’s reported financials to a private investor with no finance background.');
  lines.push('');
  lines.push('Symbol: ' + (payload.symbol || 'unknown'));
  if(payload.sector) lines.push('Sector: ' + payload.sector);
  if(payload.lender) lines.push('This is a bank or financial company. Ratios built for manufacturers (current ratio, inventory turnover, debt/equity) do not describe it; do not judge it on those.');
  lines.push('');
  lines.push('Ratios actually reported (anything absent was not available, say so rather than guessing):');
  for(const k of Object.keys(payload.ratios)){
    const v = payload.ratios[k];
    if(v == null || typeof v === 'boolean') continue;
    lines.push('  ' + k + ': ' + (typeof v === 'number' ? v.toFixed(4) : v));
  }
  lines.push('');
  lines.push('Write at most 250 words. Rules:');
  lines.push('- Plain English. Explain any term you use.');
  lines.push('- Say what the numbers show, and what is missing. Never invent a figure not listed above.');
  lines.push('- Do NOT give buy, sell or hold advice, a price target, or a recommendation of any kind.');
  lines.push('- Lead with what stands out, good or bad. Be direct about weaknesses.');
  return lines.join('\n');
}

async function callAiProvider(provider, model, key, prompt){
  const cfg = AI_PROVIDERS[provider];
  if(!cfg) throw new Error('Unknown provider');
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 60000);
  try {
    let url, opts;
    if(provider === 'gemini'){
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      opts = { method:'POST', headers:{'Content-Type':'application/json'},
               body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] }), signal: ctrl.signal };
    } else if(provider === 'anthropic'){
      url = 'https://api.anthropic.com/v1/messages';
      opts = { method:'POST', headers:{
                 'Content-Type':'application/json', 'x-api-key': key,
                 'anthropic-version':'2023-06-01',
                 // Anthropic blocks browser calls unless this opt-in is present.
                 'anthropic-dangerous-direct-browser-access':'true' },
               body: JSON.stringify({ model, max_tokens: 700, messages:[{ role:'user', content: prompt }] }),
               signal: ctrl.signal };
    } else {
      url = 'https://api.openai.com/v1/chat/completions';
      opts = { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
               body: JSON.stringify({ model, max_tokens: 700, messages:[{ role:'user', content: prompt }] }),
               signal: ctrl.signal };
    }
    const r = await fetch(url, opts);
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch(e) {}
    if(!r.ok){
      // Relay the provider's own words: "insufficient quota" and "invalid key"
      // are different problems and the user can only fix the one they are told.
      const msg = (j && j.error && (j.error.message || j.error.status)) || txt.slice(0, 300) || ('HTTP ' + r.status);
      throw new Error(msg);
    }
    return aiExtractText(provider, j);
  } finally { clearTimeout(tid); }
}

function aiExtractText(provider, j){
  if(!j) return null;
  let out = null;
  if(provider === 'gemini'){
    const c = j.candidates && j.candidates[0];
    const parts = c && c.content && c.content.parts;
    if(Array.isArray(parts)) out = parts.map(p => p && p.text).filter(Boolean).join('');
  } else if(provider === 'anthropic'){
    if(Array.isArray(j.content)) out = j.content.map(p => p && p.type === 'text' ? p.text : '').filter(Boolean).join('');
  } else {
    const c = j.choices && j.choices[0];
    out = c && c.message && c.message.content;
  }
  return (out && out.trim()) ? out.trim() : null;
}

// The model's output is untrusted text. Escape first, then allow only the two
// bits of formatting it tends to use.
function aiRender(text){
  const esc = String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return esc.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .split(/\n{2,}/).map(p => `<p style="margin:0 0 9px">${p.replace(/\n/g,'<br>')}</p>`).join('');
}

// ── UI ─────────────────────────────────────────────────────────────────────
let _insPayload = null;          // set by the Financials tab on each render

function insightsHtml(){
  const pv = _aiProvider(), cfg = AI_PROVIDERS[pv];
  const key = _aiGet(AI_KEY_PREFIX + pv, '');
  const model = _aiGet(AI_MODEL_PREFIX + pv, cfg.model);
  const opts = Object.keys(AI_PROVIDERS).map(k =>
    `<option value="${k}"${k === pv ? ' selected' : ''}>${AI_PROVIDERS[k].label}</option>`).join('');
  const steps = cfg.steps.map(s => `<li style="margin-bottom:5px">${s}</li>`).join('');
  return `<div class="ins-wrap">
    <div class="rt-h">🧠 Insights</div>
    <div class="ins-tabs">
      <button class="ins-tab ins-tab-on" id="ins-tab-free" onclick="insSwitch('free')">Built-in reading · free</button>
      <button class="ins-tab" id="ins-tab-ai" onclick="insSwitch('ai')">AI model · your key</button>
    </div>

    <div id="ins-pane-free">
      <div class="ins-note">Runs <b>Python on your device</b>, the same <code>interpret.py</code> the test suite checks, reading the ratios above.
        Nothing is sent anywhere. The runtime is about 10 MB and is fetched once per visit, so the first run is the slow one.</div>
      <div id="ins-free-out" style="margin-top:12px"></div>
      <button class="btn btn-sec btn-sm" style="margin-top:10px" onclick="insRunBuiltin()">↻ Run again</button>
    </div>

    <div id="ins-pane-ai" style="display:none">
      <div class="ins-warn">⚠️ This one <b>sends the ratios above to ${cfg.label}</b>, figures and the ticker, never your holdings or portfolio.
        Your key is stored in this browser only and is sent to that provider and nowhere else. It is your account and your bill.</div>
      <div class="ins-row">
        <label class="ins-lbl">Provider</label>
        <select class="form-input" id="ins-provider" onchange="insProviderChange()" style="flex:1">${opts}</select>
      </div>
      <div class="ins-cost">${cfg.cost}</div>
      <div class="ins-row">
        <label class="ins-lbl">Model</label>
        <input class="form-input" id="ins-model" value="${model}" placeholder="${cfg.model}" style="flex:1">
      </div>
      <div class="ins-row">
        <label class="ins-lbl">API key</label>
        <input class="form-input" id="ins-key" type="password" value="${key}" placeholder="paste your key" style="flex:1" autocomplete="off">
        <button class="btn btn-sec btn-sm" onclick="insSaveKey()">Save</button>
        <button class="btn btn-sec btn-sm" onclick="insClearKey()">Clear</button>
      </div>
      <details class="ins-help">
        <summary>How do I get a ${cfg.label} key?</summary>
        <ol style="margin:9px 0 0 18px;font-size:12px;line-height:1.65;color:var(--text2)">${steps}</ol>
        <div style="margin-top:8px;font-size:12px"><a href="${cfg.keyUrl}" target="_blank" rel="noopener">Open the ${cfg.label} key page ↗</a></div>
      </details>
      <label class="ins-consent"><input type="checkbox" id="ins-consent"> I understand these figures will be sent to ${cfg.label}.</label>
      <button class="btn btn-sec btn-sm" onclick="insRunAi()">▶ Ask the model</button>
      <div id="ins-ai-out" style="margin-top:12px"></div>
    </div>
  </div>`;
}

function insSwitch(which){
  const f = document.getElementById('ins-pane-free'), a = document.getElementById('ins-pane-ai');
  const tf = document.getElementById('ins-tab-free'), ta = document.getElementById('ins-tab-ai');
  if(!f || !a) return;
  const free = which === 'free';
  f.style.display = free ? '' : 'none';
  a.style.display = free ? 'none' : '';
  if(tf) tf.className = 'ins-tab' + (free ? ' ins-tab-on' : '');
  if(ta) ta.className = 'ins-tab' + (free ? '' : ' ins-tab-on');
}
function insProviderChange(){
  const sel = document.getElementById('ins-provider');
  if(!sel) return;
  _aiSet(AI_PROVIDER_KEY, sel.value);
  const el = document.getElementById('ins-body');
  if(el){ el.innerHTML = insightsHtml(); insSwitch('ai'); }
}
function insSaveKey(){
  const pv = _aiProvider();
  const k = document.getElementById('ins-key'), m = document.getElementById('ins-model');
  if(k) _aiSet(AI_KEY_PREFIX + pv, k.value.trim());
  if(m) _aiSet(AI_MODEL_PREFIX + pv, m.value.trim());
  const out = document.getElementById('ins-ai-out');
  if(out) out.innerHTML = `<div class="ins-ok">Saved in this browser only.</div>`;
}
function insClearKey(){
  const pv = _aiProvider();
  _aiSet(AI_KEY_PREFIX + pv, '');
  const k = document.getElementById('ins-key');
  if(k) k.value = '';
  const out = document.getElementById('ins-ai-out');
  if(out) out.innerHTML = `<div class="ins-ok">Key removed from this browser.</div>`;
}

function _insToneIcon(t){ return t === 'good' ? '✅' : t === 'weak' ? '⚠️' : 'ℹ️'; }
function insFindingsHtml(res){
  if(!res) return '';
  const rows = (res.findings || []).map(f =>
    `<div class="ins-find ins-${f.tone}"><div class="ins-find-h">${_insToneIcon(f.tone)} ${f.label}</div>
      <div class="ins-find-t">${f.text}</div></div>`).join('');
  const cov = res.coverage
    ? `<div class="ins-cov">Read from <b>${res.coverage.available}</b> of ${res.coverage.tracked} ratios. The rest were not reported by the source, so nothing is claimed about them.</div>`
    : '';
  return `<div class="ins-sum">${res.summary || ''}</div>${rows}${cov}
    <div class="ins-foot">A description of what the reported numbers show, not advice, not a recommendation, and no substitute for the company's own filings.</div>`;
}

async function insRunBuiltin(){
  const out = document.getElementById('ins-free-out');
  if(!out) return;
  if(!_insPayload){ out.innerHTML = `<div class="ins-err">Analyse a stock first.</div>`; return; }
  const say = m => { out.innerHTML = `<div class="ins-busy">${m}</div>`; };
  say('Starting…');
  try {
    const res = await runBuiltinInsight(_insPayload, say);
    out.innerHTML = insFindingsHtml(res);
  } catch(e){
    out.innerHTML = `<div class="ins-err">The Python runtime could not start: ${String(e && e.message || e)}.
      It is fetched from a public CDN, so a blocked network or an offline device will stop it.
      The ratio tables above are unaffected, they are computed without it.</div>`;
  }
}

async function insRunAi(){
  const out = document.getElementById('ins-ai-out');
  if(!out) return;
  if(!_insPayload){ out.innerHTML = `<div class="ins-err">Analyse a stock first.</div>`; return; }
  const pv = _aiProvider(), cfg = AI_PROVIDERS[pv];
  const consent = document.getElementById('ins-consent');
  if(!consent || !consent.checked){
    out.innerHTML = `<div class="ins-err">Tick the box first. This step sends the figures off your device, so it does not happen without you saying so.</div>`;
    return;
  }
  const keyEl = document.getElementById('ins-key'), modelEl = document.getElementById('ins-model');
  const key = (keyEl && keyEl.value.trim()) || _aiGet(AI_KEY_PREFIX + pv, '');
  const model = (modelEl && modelEl.value.trim()) || _aiGet(AI_MODEL_PREFIX + pv, cfg.model);
  if(!key){ out.innerHTML = `<div class="ins-err">No ${cfg.label} key yet, see “How do I get a key?” above.</div>`; return; }
  out.innerHTML = `<div class="ins-busy">Asking ${cfg.label}…</div>`;
  try {
    const text = await callAiProvider(pv, model, key, aiPrompt(_insPayload));
    out.innerHTML = text
      ? `<div class="ins-ai-body">${aiRender(text)}</div>
         <div class="ins-foot">Written by ${cfg.label} (${model}) from the ratios above. A language model can be confidently wrong; check anything that matters against the filings. Not advice.</div>`
      : `<div class="ins-err">${cfg.label} replied, but with no text in it.</div>`;
  } catch(e){
    out.innerHTML = `<div class="ins-err">${cfg.label} refused the request: ${String(e && e.message || e).replace(/</g,'&lt;')}</div>`;
  }
}

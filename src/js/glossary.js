// ══════════ GLOSSARY POPOVERS ══════════
// Every piece of jargon the app shows becomes tappable, with a one-line plain
// definition, why it matters, and what a good/bad value looks like. Terms are
// wrapped by walking text nodes - never by regex over raw HTML, which would
// corrupt attributes and nested markup.
const GLOSSARY = {
  rsi:{n:'RSI (Relative Strength Index)',d:'A 0–100 meter of how hard price has been pushed recently.',w:'It tells you whether a move is <b>stretched</b>. It does not tell you direction on its own.',r:'Above 70 = overbought (rallies often pause). Below 30 = oversold (falls often bounce). 45–55 = no one in control.'},
  macd:{n:'MACD',d:'Compares a fast and a slow average of price to spot momentum turning.',w:'A <b>crossover</b> is an early hint that buyers or sellers are taking over — early, so it misfires often alone.',r:'Trust a crossover far more when the wider trend agrees with it.'},
  sideways:{n:'Sideways (No Trend)',d:'The stock is drifting up and down inside a range instead of heading clearly up or down.',w:'It is the market saying <b>nobody is in control</b>. Trend-following signals misfire most here, which is why the app holds its call rather than guessing.',r:'Measured by ADX below 20. Wait for a decisive close beyond the range, or for ADX above 25, before treating a signal as real.'},
  adx:{n:'ADX (Trend Strength)',d:'Measures how strong a trend is — not which way it points.',w:'It is the single best filter for <b>when to ignore other signals</b>. In a flat market most indicators misfire.',r:'Below 20 = no trend, signals unreliable. Above 25 = real trend. Above 40 = very strong.'},
  atr:{n:'ATR (Average True Range)',d:'How much the stock typically moves in a single day, in rupees or dollars.',w:'It sizes your <b>stop loss</b>. A stop tighter than one ATR gets hit by ordinary noise.',r:'Stops are commonly placed 1.5–3× ATR away from entry.'},
  supertrend:{n:'Supertrend',d:'A trailing line that sits below price in an uptrend and above it in a downtrend.',w:'A simple, visual <b>trend-following</b> line — it flips side when the trend changes.',r:'Price above the line favours the upside; a close through it is the usual signal to flip.'},
  mfi:{n:'MFI (Money Flow Index)',d:'Like RSI, but it also weighs volume — so it tracks money moving in and out.',w:'It shows whether a price move is backed by <b>real buying</b> or is thin and unconvincing.',r:'Above 80 = heavy inflow, watch for exhaustion. Below 20 = washed out.'},
  stochastic:{n:'Stochastic (%K / %D)',d:'Where today’s close sits inside the recent high–low range.',w:'It catches <b>short-term turns</b> earlier than RSI, at the cost of more false signals.',r:'Below 20 = oversold, above 80 = overbought. The %K crossing %D is the trigger.'},
  cci:{n:'CCI (Commodity Channel Index)',d:'How far price has strayed from its own average.',w:'Flags <b>unusual extremes</b> — moves far outside the normal range.',r:'Above +100 = unusually strong. Below −100 = unusually weak.'},
  obv:{n:'OBV (On-Balance Volume)',d:'Adds volume on up days and subtracts it on down days.',w:'When OBV rises but price does not, <b>accumulation</b> may be happening quietly.',r:'OBV should move with price. A divergence between them is the signal.'},
  bollinger:{n:'Bollinger Bands',d:'A band drawn two standard deviations either side of a moving average.',w:'Shows whether the stock is <b>calm or volatile</b>, and when it is at an extreme.',r:'Bands squeezing tight often precedes a big move — direction unknown.'},
  vcp:{n:'VCP (Volatility Contraction Pattern)',d:'A base where each pullback is shallower than the last, on falling volume.',w:'Popularised by O’Neil and Minervini as a <b>pre-breakout</b> setup: selling is drying up.',r:'The setup completes only on a close above the pivot, ideally on strong volume.'},
  cuphandle:{n:'Cup &amp; Handle',d:'A rounded bottom followed by a small drift down — like a teacup with a handle.',w:'A classic <b>continuation</b> shape: the stock digests gains before trying higher.',r:'The buy trigger is a close above the handle’s high, not the cup’s rim.'},
  symmetrical:{n:'Symmetrical Triangle',d:'Falling highs and rising lows squeezing price into a point.',w:'Shows <b>indecision compressing</b>. The breakout direction is not predictable in advance.',r:'Wait for the close outside the triangle — do not guess which way it breaks.'},
  ascending:{n:'Ascending Triangle',d:'A flat ceiling of resistance with rising lows pressing into it.',w:'Buyers keep paying more while sellers defend one price — usually a <b>bullish</b> shape.',r:'The trigger is a close above the flat ceiling.'},
  doublebottom:{n:'Double Bottom',d:'Two lows at roughly the same price with a bounce between them.',w:'Suggests a floor where buyers stepped in <b>twice</b>.',r:'Confirmed only when price closes above the middle peak (the neckline).'},
  headshoulders:{n:'Head &amp; Shoulders',d:'Three peaks — a higher middle one flanked by two lower ones.',w:'A classic <b>reversal</b> warning after an uptrend.',r:'Confirmed when price closes below the neckline joining the two troughs.'},
  gartley:{n:'Gartley',d:'A five-point (X-A-B-C-D) harmonic pattern based on Fibonacci ratios.',w:'Attempts to pinpoint where a pullback <b>exhausts</b> and reverses.',r:'Advanced and easy to over-fit — treat as one input, never the whole case.'},
  fibonacci:{n:'Fibonacci Levels',d:'Ratios (38.2%, 50%, 61.8%) marking common pullback depths.',w:'Widely watched, so they often become <b>self-fulfilling</b> support and resistance.',r:'The 50% and 61.8% retracements are where healthy pullbacks usually end.'},
  divergence:{n:'Divergence',d:'Price makes a new high or low, but the indicator does not follow.',w:'A warning that the move is running on <b>fumes</b>.',r:'Divergence signals timing poorly — treat it as a caution, not an entry.'},
  support:{n:'Support',d:'A price level where buyers have repeatedly stepped in.',w:'It is where falls tend to <b>stall</b> — a natural place to set a stop just below.',r:'The more times a level holds, the more meaningful a break of it becomes.'},
  resistance:{n:'Resistance',d:'A price level where sellers have repeatedly appeared.',w:'It is the ceiling a stock must clear before it can <b>run</b>.',r:'A close above resistance on strong volume is the classic breakout.'},
  breakout:{n:'Breakout',d:'Price closing decisively beyond a level it has respected for a while.',w:'It signals the old balance has <b>broken</b> and a new move may begin.',r:'Intraday pokes fail often — wait for the daily close, ideally on high volume.'},
  movingaverage:{n:'Moving Average',d:'The average closing price over a set number of days.',w:'It smooths noise so the underlying <b>trend</b> is visible.',r:'The 50-day tracks the medium trend; the 200-day defines the long-term trend.'},
  ema:{n:'EMA (Exponential Moving Average)',d:'A moving average that weights recent days more heavily.',w:'Reacts <b>faster</b> than a simple average, so it turns sooner.',r:'The 20-day EMA is a common short-term trend guide.'},
  riskreward:{n:'Risk : Reward',d:'How much you stand to gain versus how much you risk to your stop.',w:'The single most important number in a trade plan — it decides if a setup is <b>worth taking</b>.',r:'Below 1:1.5 is usually not worth it. You can be right under half the time and still profit at 1:3.'},
  stoploss:{n:'Stop Loss',d:'The price at which you accept the idea was wrong and exit.',w:'It caps the damage of any single mistake — the core of <b>survival</b>.',r:'Set it where the setup is invalidated, not at an amount you feel like losing.'},
  drawdown:{n:'Max Drawdown',d:'The largest peak-to-trough fall over the period.',w:'It is the <b>worst pain</b> you would have had to sit through.',r:'If the drawdown is more than you could stomach, the position is too large.'},
  volatility:{n:'Volatility',d:'How much returns swing around, annualised.',w:'A proxy for <b>risk</b> — higher means wider swings in both directions.',r:'Under 20% is calm; over 40% is jumpy and needs smaller position sizes.'},
  beta:{n:'Beta',d:'How much the stock moves relative to the wider market.',w:'Shows whether it will <b>amplify</b> or cushion market moves.',r:'Beta 1 = moves with the market. Above 1.3 = noticeably more volatile.'},
  cagr:{n:'CAGR',d:'The smoothed annual growth rate between a start and end value.',w:'Makes returns over <b>different periods</b> comparable.',r:'It ignores when money was added — for SIPs, XIRR is the honest measure.'},
  xirr:{n:'XIRR',d:'Annual return that accounts for the date and size of every instalment.',w:'The correct way to judge a <b>SIP</b>, where money went in over time.',r:'Use XIRR for SIPs; CAGR only for a single lump-sum investment.'},
  nav:{n:'NAV (Net Asset Value)',d:'The per-unit price of a mutual fund, published once daily.',w:'Your fund value = units × NAV. NAV level alone says <b>nothing</b> about whether a fund is cheap.',r:'Compare funds by returns and risk, never by a lower NAV.'},
  pe:{n:'P/E Ratio',d:'Share price divided by earnings per share.',w:'Roughly, the years of current profit you are paying for — a <b>valuation</b> gauge.',r:'Only meaningful against the same sector and the stock’s own history.'},
  peg:{n:'PEG Ratio',d:'The P/E divided by the earnings growth rate.',w:'Puts a high P/E in context — fast growth can <b>justify</b> it.',r:'Under 1 is often considered good value; over 2 is expensive for the growth.'},
  pb:{n:'P/B Ratio',d:'Share price divided by book value per share.',w:'Compares price to the <b>assets</b> behind it. Most useful for banks and financials.',r:'Under 1 can signal value — or a business in trouble. Check why.'},
  roe:{n:'ROE (Return on Equity)',d:'Profit generated per rupee of shareholder capital.',w:'A core measure of <b>business quality</b>.',r:'Consistently above 15% is strong; below 5% is weak.'},
  dvm:{n:'DVM Scores',d:'Durability, Valuation and Momentum, each scored 0–100.',w:'A quick three-way read: is it <b>sound</b>, is it <b>cheap</b>, is it <b>moving</b>?',r:'Strong momentum usually comes with weak valuation — that trade-off is normal.'},
};
const _G_PATTERNS=[
  ['Bollinger Bands?','bollinger'],['Cup (?:&amp;|&|and) Handle','cuphandle'],['Symmetrical Triangles?','symmetrical'],
  ['Ascending Triangles?','ascending'],['Double Bottoms?','doublebottom'],['Head (?:&amp;|&|and) Shoulders','headshoulders'],
  ['Head.and.Shoulders','headshoulders'],['Risk ?: ?Reward','riskreward'],['Stop ?loss','stoploss'],
  ['Max Drawdown','drawdown'],['Drawdown','drawdown'],['Moving Averages?','movingaverage'],
  ['\\d{2,3}-day averages?','movingaverage'],['Fibonacci','fibonacci'],['Divergence','divergence'],
  ['Supertrend','supertrend'],['Stochastic','stochastic'],['Volatility','volatility'],['Resistance','resistance'],
  ['Support','support'],['Breakout','breakout'],['Gartley','gartley'],['RSI','rsi'],['MACD','macd'],['ADX','adx'],
  ['ATR','atr'],['MFI','mfi'],['CCI','cci'],['OBV','obv'],['VCP','vcp'],['XIRR','xirr'],['CAGR','cagr'],
  ['NAV','nav'],['DVM','dvm'],['PEG','peg'],['ROE','roe'],['EMA','ema'],['Beta','beta'],
  ['P/E','pe'],['P/B','pb'],['Sideways(?: Range)?','sideways'],
];
const _G_RE=new RegExp('\\b(?:'+_G_PATTERNS.map(p=>p[0]).join('|')+')(?![\\w-])','g');
function _gKeyFor(txt){
  for(const [pat,key] of _G_PATTERNS){ if(new RegExp('^(?:'+pat+')$').test(txt)) return key; }
  return null;
}
// Wrap the FIRST occurrence of each term inside a container, so pages stay
// readable instead of turning into a field of dotted underlines.
function glossaryScan(root){
  try{
    const host=typeof root==='string'?document.getElementById(root):root;
    if(!host||!window.document.createTreeWalker) return;
    // Seed with terms already decorated here, so re-scanning after a re-render
    // or a mode toggle stays a no-op instead of creeping down the page.
    const seen=new Set();
    host.querySelectorAll('.g-term').forEach(n=>{ if(n.dataset&&n.dataset.g) seen.add(n.dataset.g); });
    const skip=/^(SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION|CANVAS|SVG)$/;
    const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT,{acceptNode(n){
      if(!n.nodeValue||n.nodeValue.length<2) return NodeFilter.FILTER_REJECT;
      let p=n.parentNode;
      while(p&&p!==host){
        if(p.nodeType===1){
          if(skip.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          if(p.classList&&p.classList.contains('g-term')) return NodeFilter.FILTER_REJECT;
          if(p.id==='g-pop') return NodeFilter.FILTER_REJECT;
        }
        p=p.parentNode;
      }
      return _G_RE.test(n.nodeValue)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
    }});
    const targets=[]; let node;
    while((node=walker.nextNode())) targets.push(node);
    for(const tn of targets){
      const txt=tn.nodeValue; _G_RE.lastIndex=0;
      let m, last=0; const frag=document.createDocumentFragment(); let hit=false;
      while((m=_G_RE.exec(txt))){
        const key=_gKeyFor(m[0]); if(!key||seen.has(key)||!GLOSSARY[key]) continue;
        seen.add(key); hit=true;
        if(m.index>last) frag.appendChild(document.createTextNode(txt.slice(last,m.index)));
        const s=document.createElement('span');
        s.className='g-term'; s.dataset.g=key; s.tabIndex=0; s.setAttribute('role','button');
        s.setAttribute('aria-label',m[0]+' — what this means');
        s.textContent=m[0];
        frag.appendChild(s); last=m.index+m[0].length;
      }
      if(!hit) continue;
      if(last<txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
      tn.parentNode.replaceChild(frag,tn);
    }
  }catch(e){/* decoration must never break a render */}
}
function glossaryHide(){ const p=document.getElementById('g-pop'); if(p) p.classList.remove('on'); }
function glossaryShow(el){
  const g=GLOSSARY[el.dataset.g], pop=document.getElementById('g-pop'); if(!g||!pop) return;
  document.getElementById('g-pop-t').innerHTML=g.n;
  document.getElementById('g-pop-d').innerHTML=g.d;
  document.getElementById('g-pop-w').innerHTML='<b>Why it matters:</b> '+g.w;
  document.getElementById('g-pop-r').innerHTML='<b>Rule of thumb:</b> '+g.r;
  pop.classList.add('on');
  const r=el.getBoundingClientRect(), pr=pop.getBoundingClientRect();
  let left=r.left, top=r.bottom+8;
  if(left+pr.width>window.innerWidth-10) left=Math.max(10,window.innerWidth-pr.width-10);
  if(top+pr.height>window.innerHeight-10) top=Math.max(10,r.top-pr.height-8);
  pop.style.left=left+'px'; pop.style.top=top+'px';
}
document.addEventListener('click',e=>{
  const term=e.target.closest&&e.target.closest('.g-term');
  if(term){ e.preventDefault(); e.stopPropagation(); glossaryShow(term); return; }
  if(!(e.target.closest&&e.target.closest('#g-pop'))) glossaryHide();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){ glossaryHide(); return; }
  if((e.key==='Enter'||e.key===' ')&&e.target.classList&&e.target.classList.contains('g-term')){
    e.preventDefault(); glossaryShow(e.target);
  }
});
window.addEventListener('resize',glossaryHide);
window.addEventListener('scroll',glossaryHide,true);


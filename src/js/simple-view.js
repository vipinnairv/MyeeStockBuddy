// ══════════ SIMPLE VIEW — plain-English analysis ══════════
// Turns the same numbers the Full view shows into sentences a non-trader can
// act on: the call, why, what to do, and what would falsify it. Deliberately
// pairs every simplification with its uncertainty - a confident-looking badge
// is more dangerous to a beginner than a wall of indicators.
function _svReadouts(s, price){
  const out=[], n=v=>parseFloat(v);
  const chip=(txt,col)=>({txt,col});
  const rsi=n(s.rsiV);
  if(isFinite(rsi)) out.push({ c: rsi>=70?chip('HOT','var(--red)'):rsi<=30?chip('COLD','var(--green)'):chip('NORMAL','var(--accent)'),
    t: `<b>Momentum (RSI ${rsi.toFixed(0)})</b> — ` + (rsi>=70
      ? 'buyers have pushed hard; this is the zone where rallies often pause or pull back.'
      : rsi<=30 ? 'sellers have pushed hard; this is where falls often stall and bounce.'
      : rsi>55 ? 'buyers are moderately in control, with room to run before it looks stretched.'
      : rsi<45 ? 'sellers have the upper hand, but it is not yet oversold.'
      : 'neither side is in control — momentum is balanced.') });
  const adx=n(s.adxV);
  if(isFinite(adx)) out.push({ c: adx>=25?chip('TRENDING','var(--green)'):chip('RANGING','var(--text3)'),
    t: `<b>Trend strength (ADX ${adx.toFixed(0)})</b> — ` + (adx>=40
      ? 'a very strong trend is running; moves in the trend direction tend to keep going.'
      : adx>=25 ? 'there is a real trend in place, so trend signals carry weight.'
      : 'the price is drifting sideways with no real trend. Breakout and trend signals misfire most often here.') });
  if(s.sma50v && s.sma200v) out.push({ c: (price>s.sma50v&&price>s.sma200v)?chip('ABOVE','var(--green)'):(price<s.sma50v&&price<s.sma200v)?chip('BELOW','var(--red)'):chip('MIXED','var(--accent)'),
    t: `<b>The bigger picture</b> — price is ` + (price>s.sma50v?'above':'below') + ' its 50-day average and '
      + (price>s.sma200v?'above':'below') + ' its 200-day average. '
      + ((price>s.sma50v&&price>s.sma200v)?'Both point up: this is an uptrend.'
        :(price<s.sma50v&&price<s.sma200v)?'Both point down: this is a downtrend.'
        :'They disagree — the trend is turning or unclear.') });
  if(s.macdCrossUp||s.macdCrossDown) out.push({ c: s.macdCrossUp?chip('TURNING UP','var(--green)'):chip('TURNING DOWN','var(--red)'),
    t: `<b>Momentum shift (MACD)</b> — momentum just crossed ${s.macdCrossUp?'upward, an early sign buyers are taking over':'downward, an early sign sellers are taking over'}. Early signals like this fail often on their own; they matter most when the trend agrees.` });
  if(s.stV!=null) out.push({ c: s.stV===1?chip('BUY SIDE','var(--green)'):chip('SELL SIDE','var(--red)'),
    t: `<b>Trend line (Supertrend)</b> — the trailing trend line sits at ${CUR()}${s.stLine} and currently favours the ${s.stV===1?'upside':'downside'}. A close through it is the usual signal to flip.` });
  const atr=n(s.atrV);
  if(isFinite(atr)&&price) out.push({ c: chip('SWING','var(--text3)'),
    t: `<b>Typical daily swing (ATR)</b> — this stock moves about ${CUR()}${atr.toFixed(2)} (${(atr/price*100).toFixed(1)}%) on an average day. Set stops wider than this, or normal noise will knock you out.` });
  return out;
}
function renderSimpleView(){
  const el=document.getElementById('simpleView');
  if(!el||!analysisResult) return;
  const ar=analysisResult, s=ar.signals, price=ar.currentPrice;
  const L=s.long||{}, v=s.isChop?'HOLD':s.verdict;
  // v stays the bare token so the comparisons below keep working; vLabel is
  // what the user reads, and names the sideways condition rather than hiding it.
  const vLabel=s.isChop?'HOLD (Sideways)':v;
  const conf=L.confidence!=null?L.confidence:0;
  const col=v==='BUY'?'var(--green)':v==='SELL'?'var(--red)':'var(--accent)';
  const confWord=conf>=60?'High':conf>=30?'Moderate':'Low';
  const plain=v==='BUY'?'The evidence leans towards buying'
            :v==='SELL'?'The evidence leans towards selling / staying out'
            :'The evidence does not favour either side right now';

  // ── Why: plain-English reasons, strongest first ──
  const R=[], up='var(--green)', dn='var(--red)', nu='var(--text3)';
  const rsi=parseFloat(s.rsiV), adx=parseFloat(s.adxV);
  if(s.sma50v&&s.sma200v){
    if(price>s.sma50v&&price>s.sma200v) R.push([up,'Price is above both its 50-day and 200-day averages — the longer-term trend is up.']);
    else if(price<s.sma50v&&price<s.sma200v) R.push([dn,'Price is below both its 50-day and 200-day averages — the longer-term trend is down.']);
    else R.push([nu,'Price sits between its 50-day and 200-day averages — the trend is changing or unclear.']);
  }
  if(isFinite(adx)) R.push(adx>=25?[adx>=25?up:nu,`The trend is genuine (ADX ${adx.toFixed(0)}), so trend signals here are worth trusting.`]
                                  :[nu,`There is no real trend (ADX ${adx.toFixed(0)}) — the stock is drifting sideways, where most signals misfire.`]);
  if(isFinite(rsi)) R.push(rsi>=70?[dn,`Momentum is stretched (RSI ${rsi.toFixed(0)}) — buyers have run hard and pullbacks are common from here.`]
                          :rsi<=30?[up,`Momentum is washed out (RSI ${rsi.toFixed(0)}) — sellers have run hard and bounces are common from here.`]
                          :rsi>55?[up,`Momentum favours buyers (RSI ${rsi.toFixed(0)}) without being overheated.`]
                          :rsi<45?[dn,`Momentum favours sellers (RSI ${rsi.toFixed(0)}).`]
                          :[nu,`Momentum is balanced (RSI ${rsi.toFixed(0)}) — neither side is in control.`]);
  if(s.macdCrossUp) R.push([up,'Momentum has just turned upward (MACD crossover) — an early sign buyers are stepping in.']);
  if(s.macdCrossDown) R.push([dn,'Momentum has just turned downward (MACD crossover) — an early sign sellers are stepping in.']);
  const reasons=R.slice(0,4).map(r=>`<div class="sv-reason"><span class="sv-dot" style="background:${r[0]}"></span><span>${r[1]}</span></div>`).join('');

  // ── Honest conflict / low-trust warning ──
  const total=s.bullCount+s.bearCount, split=Math.abs(s.bullCount-s.bearCount);
  let warn='';
  if(s.isChop) warn=`<div class="sv-warn"><b>⚠ Low-trust setup.</b> This stock is <b>moving sideways</b> - drifting with no clear up or down trend (ADX ${s.adxV}). This is where technical signals are least reliable, so the call is held at HOLD no matter what the individual indicators say. Waiting is a position.</div>`;
  else if(total&&split<=1) warn=`<div class="sv-warn"><b>⚠ The indicators disagree.</b> ${s.bullCount} point up and ${s.bearCount} point down — that is close to a coin flip, not a setup. A near-even split is a reason to wait, not to take a smaller position.</div>`;
  else if(conf<30) warn=`<div class="sv-warn"><b>⚠ Low confidence.</b> The evidence is thin here. Treat this as one input, not a decision.</div>`;

  // ── What would change this view ──
  let flip;
  if(v==='BUY') flip=`A daily close back below <b>${CUR()}${fmtNum(s.sma50v)}</b> (the 50-day average), or momentum slipping under RSI 45, would break this case. Your stop at <b>${CUR()}${L.sl}</b> is where the idea is simply wrong — exit there rather than hoping.`;
  else if(v==='SELL') flip=`A daily close back above <b>${CUR()}${fmtNum(s.sma50v)}</b> (the 50-day average), or momentum reclaiming RSI 55, would break this case and suggest the fall is over.`;
  else flip=`This turns into a real setup when the stock picks a direction: a close above <b>${CUR()}${s.resist}</b> with ADX rising past 25 would favour buying; a close below <b>${CUR()}${s.support}</b> would favour staying out.`;

  const doBox=(l,val,c)=>`<div class="sv-do-box"><div class="sv-do-lbl">${l}</div><div class="sv-do-val" style="color:${c||'var(--text)'}">${val}</div></div>`;
  const reads=_svReadouts(s,price).map(r=>`<div class="sv-read"><span class="sv-chip" style="background:${r.c.col}1a;color:${r.c.col}">${r.c.txt}</span><span>${r.t}</span></div>`).join('');

  el.innerHTML=`
    <div class="sv-card">
      <div class="sv-head">
        <div><div class="sv-call" style="color:${col}">${vLabel}</div><div class="sv-conf">${confWord} confidence · ${conf}%</div></div>
        <div style="flex:1;min-width:200px;font-size:14px;color:var(--text2);line-height:1.5">${plain} for <b>${ar.company}</b> at <b>${CUR()}${fmtNum(price)}</b>.</div>
      </div>
      ${warn}
      <div class="sv-sec"><div class="sv-h">Why</div>${reasons}</div>
      <div class="sv-sec"><div class="sv-h">What to do${v==='HOLD'?' if it triggers':''}</div>
        <div class="sv-do">
          ${doBox('Entry', CUR()+fmtNum(price))}
          ${doBox('Stop loss', CUR()+L.sl, 'var(--red)')}
          ${doBox('Target', CUR()+L.target, 'var(--green)')}
          ${doBox('Risk : Reward', L.rr==='N/A'?'—':'1 : '+L.rr, 'var(--accent)')}
        </div>
        <div style="font-size:12px;color:var(--text3);margin-top:9px;line-height:1.5">Risk only what you can lose to the stop. If the risk-to-reward is below 1:1.5, the trade is usually not worth taking.</div>
      </div>
      <div class="sv-sec"><div class="sv-h">What would change this view</div><div class="sv-flip">${flip}</div></div>
      <div class="sv-sec"><div class="sv-h">The indicators, in plain English</div>${reads}</div>
      <div class="sv-sec" style="background:var(--surface2)"><div style="font-size:11.5px;color:var(--text3);line-height:1.55">📋 This is an educational read of price history — not advice, and not a forecast. Technical signals fail regularly; position size and your stop matter more than being right. Switch to <b>🔬 Full technicals</b> for every indicator, pattern and backtest behind this summary.</div></div>
    </div>`;
  glossaryScan(el);
}
function setAnalysisMode(mode){
  const sec=document.getElementById('resultsSection'); if(!sec) return;
  const simple=mode!=='full';
  sec.classList.toggle('simple-on',simple);
  const b1=document.getElementById('svBtnSimple'), b2=document.getElementById('svBtnFull');
  if(b1) b1.classList.toggle('on',simple);
  if(b2) b2.classList.toggle('on',!simple);
  const h=document.getElementById('svModeHint');
  if(h) h.textContent=simple?'Plain-English summary. Switch to Full for every indicator and pattern.':'Every indicator, pattern, backtest and chart.';
  try{ localStorage.setItem('analysisMode',simple?'simple':'full'); }catch(e){}
  if(simple){ try{ renderSimpleView(); }catch(e){} }
}

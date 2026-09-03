// ══════════════════ COMBINED READ: TECHNICALS vs FUNDAMENTALS ══════════════
// Two analyses of the same company that answer different questions. Technicals
// describe what the price has been doing. Fundamentals describe what the
// business has been doing. Neither subsumes the other, and the interesting
// information is usually in whether they agree.
//
// This produces the report's opening verdict. It states a position and, more
// importantly, states what it cannot see: a reading built on one side alone is
// labelled as such rather than presented as a whole-company judgement.

const CR_BULL = 60, CR_BEAR = 40;          // technical score thresholds
const CR_FGOOD = 60, CR_FWEAK = 45;        // fundamental composite thresholds
const CR_MIN_CONF = 35;                    // below this the technical read is not usable

function _crBand(score, good, weak){
  if(score == null || !isFinite(score)) return null;
  return score >= good ? 'strong' : score < weak ? 'weak' : 'middling';
}

// Is the technical reading worth putting weight on?
//
// This is the correction for a report that contradicted itself. The analyser
// clamps the verdict to HOLD when ADX is below 20, on the stated grounds that
// trend indicators fire false signals in a range, and caps confidence at 25%.
// The raw score is left untouched. So a stock could show "HOLD" in the verdict
// box while the score of 12/100 drove the summary to announce that the price
// was falling: two conclusions from one dataset, side by side, disagreeing.
//
// A score built from indicators the analyser has just declared unreliable is
// not weak evidence, it is absent evidence. Treated as weak it drags the whole
// reading; treated as absent, the fundamentals carry it and the report says so.
function _crTechUsable(t){
  if(t == null) return false;
  if(t.isChop) return false;
  if(typeof t.confidence === 'number' && isFinite(t.confidence) && t.confidence < CR_MIN_CONF) return false;
  return true;
}

function _crWhyUnusable(t){
  if(t && t.isChop){
    return 'the trend is sideways (ADX below 20), where the trend indicators that '
         + 'make up the score fire false signals. The analyser holds the verdict at HOLD and '
         + 'caps confidence for exactly this reason, so the score is not evidence of direction '
         + 'here. It becomes usable again once ADX clears 20 to 25.';
  }
  return 'the indicators do not agree strongly enough to carry a direction '
       + '(confidence below ' + CR_MIN_CONF + '%). A score near the middle means the evidence '
       + 'is split, not that the answer is "hold".';
}

// tech: { verdict, score, confidence, isChop }
// fund: { composite, grade, coverage } or null
// ratios: the computeRatios output, or null
function combinedRead(tech, fund, ratios){
  const t = tech || {};
  const tScore = (typeof t.score === 'number' && isFinite(t.score)) ? t.score : null;
  const fScore = (fund && typeof fund.composite === 'number' && isFinite(fund.composite))
    ? fund.composite : null;
  const r = ratios || {};
  const limits = [];

  const techUsable = tScore != null && _crTechUsable(t);
  const tBand = techUsable ? _crBand(tScore, CR_BULL, CR_BEAR) : null;
  const fBand = _crBand(fScore, CR_FGOOD, CR_FWEAK);

  if(tScore != null && !techUsable){
    limits.push('The technical half is set aside for this reading: ' + _crWhyUnusable(t)
      + ' The score of ' + Math.round(tScore) + '/100 is still shown, but it is not what the '
      + 'conclusion above rests on.');
  }
  if(fund && fund.coverage != null && fund.coverage < 0.5){
    limits.push('The fundamental score rests on less than half the inputs it wants, because the '
      + 'data source did not carry the rest. Treat it as indicative rather than settled.');
  }
  if(r.pegBlocked){
    limits.push('PEG could not be computed: earnings were not growing over the period measured, '
      + 'and a price-to-growth ratio against flat or falling earnings has no meaning.');
  }

  // Neither side alone is a whole-company view, and the report says so.
  if(tScore == null && fScore == null){
    return { stance: 'No reading', tone: 'info', techUsable: false,
      headline: 'Neither analysis could be completed.',
      detail: 'Neither the technical indicators nor the fundamental figures were available, so this '
            + 'report has nothing to conclude from.',
      limits };
  }
  if(fScore == null){
    limits.unshift('This is a technical reading only. No fundamental data was available for this '
      + 'symbol, so nothing here speaks to what the business earns, owes or is worth. Price '
      + 'behaviour alone cannot tell you whether a company is sound.');
    return { stance: 'Technical only', tone: 'info', techUsable,
      headline: 'Price says ' + (t.verdict || 'nothing definite') + '; the business side is unknown.',
      detail: 'The technical score is ' + Math.round(tScore) + '/100. Without fundamentals there is '
            + 'no way to tell whether that price behaviour is supported by the accounts or running '
            + 'ahead of them, which is exactly the question that decides whether a trend holds.',
      limits };
  }
  if(tScore == null){
    limits.unshift('This is a fundamental reading only. The technical indicators could not be '
      + 'computed, so nothing here speaks to timing, trend or entry level.');
    return { stance: 'Fundamental only', tone: 'info', techUsable: false,
      headline: 'The business scores ' + (fund.grade || '-') + '; price behaviour is unknown.',
      detail: 'A sound business bought at the wrong moment still loses money for a long time, and '
            + 'this reading cannot say anything about the moment.',
      limits };
  }

  const fWord = fScore >= CR_FGOOD ? 'strong' : fScore < CR_FWEAK ? 'weak' : 'middling';
  const fPart = 'The business scores ' + Math.round(fScore) + '/100 (' + (fund.grade || '-') + '), '
              + 'which is ' + fWord + '.';

  // The technical side has nothing usable to say. The fundamentals carry the
  // reading on their own, and it is labelled that way rather than dressed up as
  // agreement or disagreement between two analyses.
  if(!techUsable){
    if(fBand === 'strong'){
      return { stance: 'Fundamentals lead; no usable trend signal', tone: 'info', techUsable: false,
        headline: 'The business looks sound. Price direction is genuinely unreadable right now.',
        detail: fPart + ' The technical side cannot be read at present, so this is a one-sided view: '
              + 'it says the accounts are in good order, and says nothing about whether now is the '
              + 'moment. Those are different questions and only one of them has an answer here.',
        limits };
    }
    if(fBand === 'weak'){
      return { stance: 'Fundamentals lead, and they are weak', tone: 'weak', techUsable: false,
        headline: 'The business figures are weak. Price direction is unreadable right now.',
        detail: fPart + ' With no usable trend signal there is nothing on the price side to set '
              + 'against that, so the weak accounts are the whole of what this report can tell you.',
        limits };
    }
    return { stance: 'No usable reading on either side', tone: 'info', techUsable: false,
      headline: 'Neither half is emphatic enough to conclude anything.',
      detail: fPart + ' The technical side cannot be read at present. Two inconclusive halves do '
            + 'not add up to a conclusion, and this report will not manufacture one.',
      limits };
  }

  const both = 'Technical ' + Math.round(tScore) + '/100, fundamental '
             + Math.round(fScore) + '/100 (' + (fund.grade || '-') + ').';

  if(tBand === 'strong' && fBand === 'strong'){
    return { stance: 'Aligned, constructive', tone: 'good', techUsable: true,
      headline: 'Both readings point the same way, and it is the constructive one.',
      detail: both + ' The price trend is firm and the accounts behind it are strong. This is the '
            + 'least ambiguous case, which is not the same as a safe one: agreement means the two '
            + 'analyses are not contradicting each other, not that the outcome is known.',
      limits };
  }
  if(tBand === 'weak' && fBand === 'weak'){
    return { stance: 'Aligned, negative', tone: 'weak', techUsable: true,
      headline: 'Both readings point the same way, and it is the negative one.',
      detail: both + ' Price structure is weak and the business figures are weak with it. When the '
            + 'two agree downward there is no second story to fall back on.',
      limits };
  }
  if(tBand === 'strong' && fBand === 'weak'){
    return { stance: 'Momentum ahead of the accounts', tone: 'watch', techUsable: true,
      headline: 'Price is rising while the business figures are not keeping up.',
      detail: both + ' A rising price on weak fundamentals is a momentum or story move rather than '
            + 'a value one. It can continue for a long time and it can end quickly, and the accounts '
            + 'give no support if it turns.',
      limits };
  }
  if(tBand === 'weak' && fBand === 'strong'){
    return { stance: 'Accounts ahead of the price', tone: 'watch', techUsable: true,
      headline: 'The business figures are strong while the price is falling.',
      detail: both + ' Either the market is pricing in something the reported numbers do not show '
            + 'yet, or this is the disagreement value buyers look for. The report cannot tell you '
            + 'which, because that depends on information outside the numbers.',
      limits };
  }
  return { stance: 'No clear agreement', tone: 'info', techUsable: true,
    headline: 'The two readings do not line up strongly either way.',
    detail: both + ' Neither analysis is emphatic and they do not reinforce each other. There is no '
          + 'strong conclusion here, and inventing one would be worse than saying so.',
    limits };
}

// ── Report sections ────────────────────────────────────────────────────────
const CR_TONE_COL = { good:'#0f9d58', weak:'#d93025', watch:'#e37400', info:'#5f6368' };

function _crEsc(v){
  return String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// The opening page. A reader who stops after this should still have the honest
// version: the position, and what the report could not see.
function repExecSummaryHtml(ar, comb, fund, cur){
  const col = CR_TONE_COL[comb.tone] || CR_TONE_COL.info;
  // Floats reach here straight from the price feed: 76.45 - 74.82 is
  // 1.6300000000000097 in binary floating point, and that is what printed.
  const num = (v, dp) => (v == null || !isFinite(v)) ? null : Number(v).toFixed(dp == null ? 2 : dp);
  const chgN = num(ar.priceChg), pctN = num(ar.pricePct);
  const chg = chgN == null ? '' : (ar.priceChg >= 0 ? '+' : '') + chgN;
  const pct = pctN == null ? '' : (ar.pricePct >= 0 ? '+' : '') + pctN + '%';
  const priceN = num(ar.currentPrice);
  const s = ar.signals || {};
  const box = (label, value, sub) =>
    `<td style="padding:9px 12px;border:1px solid #d8dde3;vertical-align:top">
       <div style="font-size:8.5pt;letter-spacing:.5px;text-transform:uppercase;color:#6b7280">${label}</div>
       <div style="font-size:14pt;font-weight:800;margin-top:2px">${value}</div>
       ${sub ? `<div style="font-size:8.5pt;color:#6b7280;margin-top:1px">${sub}</div>` : ''}
     </td>`;
  const limits = comb.limits && comb.limits.length
    ? `<div style="margin-top:10px;border-left:3px solid #9aa0a6;padding:8px 12px;background:#f6f7f9;break-inside:avoid">
         <div style="font-size:9pt;font-weight:800;margin-bottom:4px">What this report cannot tell you</div>
         <ul style="margin:0 0 0 16px;padding:0;font-size:9pt;line-height:1.55">
           ${comb.limits.map(l => `<li style="margin-bottom:3px">${_crEsc(l)}</li>`).join('')}
         </ul>
       </div>` : '';
  return `<h2>Executive Summary</h2>
  <div style="border:2px solid ${col};border-radius:6px;padding:12px 14px;margin-bottom:10px;break-inside:avoid">
    <div style="font-size:8.5pt;letter-spacing:1px;text-transform:uppercase;color:${col};font-weight:800">${_crEsc(comb.stance)}</div>
    <div style="font-size:13pt;font-weight:800;margin:3px 0 5px">${_crEsc(comb.headline)}</div>
    <div style="font-size:10pt;line-height:1.6">${_crEsc(comb.detail)}</div>
  </div>
  <table class="tbl" style="width:100%;border-collapse:collapse;margin-bottom:6px;break-inside:avoid"><tr>
    ${box('Price', cur + (priceN == null ? 'n/r' : priceN), chg && pct ? chg + ' (' + pct + ')' : '')}
    ${box('Technical verdict', _crEsc(s.isChop ? 'HOLD (Sideways)' : (s.verdict || '-')),
          (s.score == null ? '' : Math.round(s.score) + '/100')
          + (s.long && s.long.confidence != null ? ', ' + s.long.confidence + '% confidence' : '')
          + (comb.techUsable === false ? ' &mdash; not used' : ''))}
    ${box('Fundamental grade', _crEsc(fund && fund.grade ? fund.grade : 'n/r'),
          fund && fund.composite != null ? Math.round(fund.composite) + '/100' : 'not reported')}
    ${box('Combined', _crEsc(comb.stance), '')}
  </tr></table>
  ${limits}
  ${comb.techUsable === false && s.score != null ? `<p class="muted">
    The verdict reads HOLD while the score reads ${Math.round(s.score)}/100. They are not in
    conflict: the score counts trend indicators, and the analyser clamps the verdict to HOLD when
    those indicators are unreliable. Where they diverge like this, the clamp is the more honest
    of the two and the score is not treated as evidence of direction.</p>` : ''}
  <p class="muted">Technicals describe what the price has done. Fundamentals describe what the
  business has done. This report keeps them apart, then says whether they agree, because the
  disagreement is usually the informative part.</p>`;
}

// The fundamental half: the ratios that were computable, and the reading of
// them. Markers carry meaning rather than leaving a reader to guess at a blank.
function repFundamentalHtml(ratios, lender, interp, fund, groups){
  if(!ratios) {
    return `<h2>Fundamental Analysis</h2>
      <p class="muted">No financial statements were available for this symbol, so no ratios could be
      computed. That is a gap in the data source, not a finding about the company.</p>`;
  }
  const rows = [];
  for(const [title, items] of groups){
    const cells = items.map(([label, key, fmt]) => {
      const na = lender && RT_LENDER_NA.indexOf(key) >= 0;
      const v = ratios[key];
      const shown = na && v != null ? 'n/a' : (v == null ? 'n/r' : fmt(v).replace(/<[^>]+>/g, ''));
      return `<tr><td>${_crEsc(label)}</td><td style="text-align:right;font-weight:700">${shown}</td></tr>`;
    }).join('');
    rows.push(`<div style="break-inside:avoid;margin-bottom:8px">
      <div style="font-size:9.5pt;font-weight:800;margin-bottom:3px">${title}</div>
      <table class="tbl" style="width:100%;border-collapse:collapse">${cells}</table></div>`);
  }
  const lenderNote = lender
    ? `<p class="muted">This is a bank or financial company. Ratios built for manufacturers and
       retailers are marked <b>n/a</b>: for a lender, deposits are raw material rather than a
       liability to worry about, there is no inventory, and negative operating cash flow usually
       means the loan book grew.</p>` : '';
  const findings = (interp && interp.findings && interp.findings.length)
    ? `<h2>What the figures say</h2>
       <div style="border:1px solid #d8dde3;border-radius:5px;padding:9px 12px;margin-bottom:8px;font-weight:700;font-size:10pt">
         ${_crEsc(interp.summary)}</div>
       ${interp.findings.map(f => `
         <div style="break-inside:avoid;page-break-inside:avoid;border-left:3px solid ${CR_TONE_COL[f.tone] || CR_TONE_COL.info};
              padding:6px 11px;margin-bottom:6px;background:#fafbfc">
           <div style="font-weight:800;font-size:9.5pt">${_crEsc(f.label)}</div>
           <div style="font-size:9.5pt;line-height:1.55">${_crEsc(f.text)}</div>
         </div>`).join('')}` : '';
  const scoreNote = (fund && fund.composite != null)
    ? `<p class="muted">Composite score ${Math.round(fund.composite)}/100 (grade ${_crEsc(fund.grade)}),
       weighted across quality, valuation, growth and income. A pillar with no data is left out
       rather than scored as zero.</p>` : '';
  return `<h2>Fundamental Analysis</h2>
    ${lenderNote}
    <div style="columns:2;column-gap:14px">${rows.join('')}</div>
    ${scoreNote}
    <p class="muted"><b>n/r</b> not reported by the data source ·
      <b>n/a</b> does not describe this kind of business ·
      <b>n/m</b> applies, but cannot be computed to anything meaningful.
      Nothing is estimated to fill a gap.</p>
    ${findings}`;
}

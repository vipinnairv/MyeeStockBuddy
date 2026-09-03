"""Reads a set of computed ratios and says, in plain English, what they show.

Why this is Python and the rest of the app is not
------------------------------------------------
The ratios themselves are computed in JavaScript and arrive here already
worked out, along with the band (good / fair / weak) each one fell into. That
split is deliberate: thresholds live in exactly one place, so this file cannot
drift out of agreement with the numbers on screen. What Python does here is the
part it is actually better at, reading across the ratios, weighing them
against each other, and turning the result into sentences.

It runs in the browser through Pyodide (CPython compiled to WebAssembly), so
"no server" still holds: the figures never leave the machine. The same file is
imported directly by tests/test_interpret.py under normal CPython, which is
what makes the logic here verified rather than merely present.

Two rules govern every sentence produced:

  1. Nothing is said about a ratio that was not computed. A missing input
     yields silence, never a guess and never a reassuring absence.
  2. Nothing here is advice. Every finding describes what the reported numbers
     show. What to do about it is the reader's judgement, and the caller is
     expected to say so.
"""

import json

GOOD, FAIR, WEAK = "good", "fair", "weak"


def _f(x):
    """A finite float, or None. Guards against NaN and infinity arriving as JSON."""
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return v


def _pct(v, dp=1):
    return "{:.{dp}f}%".format(v, dp=dp)


def _x(v, dp=2):
    return "{:.{dp}f}x".format(v, dp=dp)


# Each entry: key, tone by band, and the sentence template. Only ratios worth
# narrating appear here - a list of every number would be a table, not a read.
def _profitability(r, b, lender, out):
    roce, roe, nm, gm = r.get("roce"), r.get("roe"), r.get("netMargin"), r.get("grossMargin")

    if roce is not None and not lender:
        band = b.get("roce")
        if band == GOOD:
            out.append((GOOD, "Returns on capital",
                        "ROCE of %s means the business earns well on the capital tied up in it. "
                        "This is the number that is hardest to flatter with borrowing, so a high "
                        "one is worth more than a high ROE." % _pct(roce)))
        elif band == FAIR:
            out.append(("info", "Returns on capital",
                        "ROCE of %s is moderate - the business earns its keep on the capital "
                        "employed without standing out." % _pct(roce)))
        elif band == WEAK:
            out.append((WEAK, "Returns on capital",
                        "ROCE of %s is low. The business is not generating much from the capital "
                        "tied up in it, which over time limits how fast it can grow without "
                        "raising more money." % _pct(roce)))

    if roe is not None:
        band = b.get("roe")
        if roce is not None and not lender and roe - roce > 10:
            out.append(("info", "ROE flattered by debt",
                        "ROE of %s sits well above ROCE of %s. That gap is usually borrowing: "
                        "debt lifts the return to shareholders while adding risk that ROE alone "
                        "does not show." % (_pct(roe), _pct(roce))))
        elif band == GOOD:
            out.append((GOOD, "Return on equity",
                        "ROE of %s is a strong return on shareholders' money." % _pct(roe)))
        elif band == WEAK:
            out.append((WEAK, "Return on equity",
                        "ROE of %s is a weak return on shareholders' money." % _pct(roe)))

    if nm is not None:
        band = b.get("netMargin")
        if band == GOOD:
            out.append((GOOD, "Margins",
                        "Net margin of %s means the business keeps a healthy share of every "
                        "rupee it sells." % _pct(nm)))
        elif band == WEAK:
            out.append((WEAK, "Margins",
                        "Net margin of %s is thin, so profit is sensitive to small moves in "
                        "costs or pricing." % _pct(nm)))
        if nm < 0:
            out.append((WEAK, "Loss-making",
                        "Net margin is negative: the business lost money over this period. "
                        "Several ratios below are withheld because they are meaningless "
                        "against a loss."))

    if gm is not None and nm is not None and gm > 0 and nm > 0 and gm - nm > 45:
        out.append(("info", "Costs below the gross line",
                    "Gross margin is %s but net margin is only %s. Most of what the business "
                    "earns on its product is spent before it reaches the bottom line - overheads, "
                    "interest or tax." % (_pct(gm), _pct(nm))))


def _growth(r, b, out):
    rev, ni, eps = r.get("revGrowth"), r.get("niGrowth"), r.get("epsGrowth")

    if rev is not None and ni is not None:
        if ni < rev - 10:
            out.append((WEAK, "Profit lagging sales",
                        "Revenue grew %s but net profit only %s. Sales are rising faster than "
                        "profits, which means margins are compressing - growth is being bought "
                        "rather than earned." % (_pct(rev), _pct(ni))))
        elif ni > rev + 10:
            out.append((GOOD, "Profit outpacing sales",
                        "Net profit grew %s against revenue growth of %s. The business is getting "
                        "more profitable as it grows, not just bigger." % (_pct(ni), _pct(rev))))

    if eps is not None and ni is not None and ni - eps > 5:
        out.append(("info", "Dilution",
                    "Net profit grew %s but earnings per share only %s. The share count rose, so "
                    "each existing share captured less of that growth than the headline suggests."
                    % (_pct(ni), _pct(eps))))

    if rev is not None and rev < 0:
        out.append((WEAK, "Shrinking",
                    "Revenue fell %s against the previous period. The business sold less, not "
                    "more." % _pct(abs(rev))))


def _solvency(r, b, lender, out):
    if lender:
        return
    de, cover, nde = r.get("debtToEquity"), r.get("interestCover"), r.get("netDebtEbitda")

    if de is not None:
        band = b.get("debtToEquity")
        if band == WEAK:
            out.append((WEAK, "Debt load",
                        "Debt of %s times equity means the business leans more on lenders than on "
                        "its owners. That magnifies both good years and bad ones." % _x(de)))
        elif band == GOOD:
            out.append((GOOD, "Debt load",
                        "Debt is %s times equity - a conservative balance sheet." % _x(de)))

    if cover is not None:
        if cover < 2:
            out.append((WEAK, "Interest burden",
                        "Operating profit covers the interest bill only %s. There is little room "
                        "for a bad year before interest becomes hard to service." % _x(cover, 1)))
        elif b.get("interestCover") == GOOD:
            out.append((GOOD, "Interest burden",
                        "Operating profit covers interest %s over - comfortable." % _x(cover, 1)))

    if nde is not None and nde <= 0:
        out.append((GOOD, "Net cash",
                    "The business holds more cash than debt."))
    elif nde is not None and b.get("netDebtEbitda") == WEAK:
        out.append((WEAK, "Debt against earnings",
                    "Net debt is %s years of operating earnings. Above about three, lenders and "
                    "rating agencies start to take notice." % _x(nde, 1)))


def _liquidity(r, b, lender, out):
    if lender:
        return
    cr, qr = r.get("currentRatio"), r.get("quickRatio")
    if cr is not None and cr < 1:
        out.append((WEAK, "Short-term cover",
                    "Current ratio of %s means short-term dues exceed short-term assets. The "
                    "business depends on new cash coming in to meet bills already due." % _x(cr)))
    elif cr is not None and qr is not None and cr >= 1.5 and qr < 1:
        out.append(("info", "Cover depends on inventory",
                    "Current ratio looks comfortable at %s, but stripping out inventory drops it "
                    "to %s. The cushion is stock that still has to be sold." % (_x(cr), _x(qr))))


def _cash(r, b, out):
    cc, fcfm = r.get("cashConversion"), r.get("fcfMargin")
    if cc is not None:
        if cc < 0.6:
            out.append((WEAK, "Profits not becoming cash",
                        "Only %s of net profit came through as operating cash. Reported profit is "
                        "running ahead of money actually collected - worth checking receivables "
                        "and inventory." % _x(cc)))
        elif cc >= 1:
            out.append((GOOD, "Profits backed by cash",
                        "Operating cash flow is %s of net profit, so the earnings are real cash "
                        "rather than accounting entries." % _x(cc)))
    if fcfm is not None and fcfm < 0:
        out.append((WEAK, "Cash consumed",
                    "Free cash flow is negative: after capital spending, the business used more "
                    "cash than it produced. That is normal while building capacity and a problem "
                    "when it is not."))
    elif fcfm is not None and b.get("fcfMargin") == GOOD:
        out.append((GOOD, "Cash generative",
                    "Free cash flow is %s of revenue - real money left after running and "
                    "maintaining the business." % _pct(fcfm)))


def _valuation(r, b, out, deposit_rate=7.0):
    pe, peg, ey, basis = r.get("pe"), r.get("peg"), r.get("earningsYield"), r.get("pegBasis")

    if peg is not None:
        if peg < 1:
            out.append((GOOD, "Price against growth",
                        "PEG of %s: the price is below what the growth rate alone would justify, "
                        "measured against %s." % ("{:.2f}".format(peg), basis or "reported growth")))
        elif peg > 2:
            out.append((WEAK, "Price against growth",
                        "PEG of %s: the price is well ahead of the growth being delivered. That "
                        "only works out if growth accelerates." % "{:.2f}".format(peg)))
    elif r.get("pegBlocked"):
        out.append(("info", "PEG not meaningful",
                    "Earnings are flat or shrinking, so PEG has no meaning here - dividing a "
                    "price by negative growth produces a number that looks cheap and is not."))

    if ey is not None:
        if ey < deposit_rate - 2:
            out.append(("info", "Against a deposit",
                        "The earnings yield is %s. A fixed deposit pays roughly %s with no "
                        "business risk, so the case for holding this rests on growth rather than "
                        "current earnings." % (_pct(ey), _pct(deposit_rate, 0))))
        elif ey > deposit_rate + 3:
            out.append((GOOD, "Against a deposit",
                        "The earnings yield is %s, comfortably above a deposit rate of about %s."
                        % (_pct(ey), _pct(deposit_rate, 0))))

    if pe is not None and pe > 60:
        out.append(("info", "High multiple",
                    "A P/E of %s prices in a great deal of future growth. It is not wrong on its "
                    "own, but it leaves little margin for disappointment."
                    % "{:.1f}".format(pe)))


# Ratios worth reporting coverage against. A read built on four numbers is a
# different thing from one built on twenty, and the reader should be told which.
_TRACKED = [
    "grossMargin", "opMargin", "netMargin", "roe", "roce", "roic", "roa",
    "revGrowth", "niGrowth", "epsGrowth", "debtToEquity", "netDebtEbitda",
    "interestCover", "currentRatio", "quickRatio", "assetTurnover",
    "invTurnover", "receivableDays", "fcfMargin", "cashConversion",
    "pe", "peg", "pb", "ps", "evEbitda", "earningsYield", "divYield",
]


def interpret(payload):
    """payload: {ratios, bands, lender, symbol, depositRate}. Returns a dict."""
    payload = payload or {}
    raw = payload.get("ratios") or {}
    ratios = {}
    for k in raw:
        v = _f(raw[k])
        if v is not None:
            ratios[k] = v
    # pegBasis is text and pegBlocked is a flag; neither survives the float pass.
    if raw.get("pegBasis"):
        ratios["pegBasis"] = raw["pegBasis"]
    ratios["pegBlocked"] = bool(raw.get("pegBlocked"))

    bands = payload.get("bands") or {}
    lender = bool(payload.get("lender"))
    deposit = _f(payload.get("depositRate"))
    if deposit is None:
        deposit = 7.0

    out = []
    _profitability(ratios, bands, lender, out)
    _growth(ratios, bands, out)
    _solvency(ratios, bands, lender, out)
    _liquidity(ratios, bands, lender, out)
    _cash(ratios, bands, out)
    _valuation(ratios, bands, out, deposit)

    findings = [{"tone": t, "label": l, "text": s} for (t, l, s) in out]
    have = [k for k in _TRACKED if k in ratios]
    coverage = {"available": len(have), "tracked": len(_TRACKED)}

    strengths = len([f for f in findings if f["tone"] == GOOD])
    concerns = len([f for f in findings if f["tone"] == WEAK])

    if not findings:
        summary = ("Not enough of the statements came through to say anything useful. "
                   "%d of %d ratios could be computed." % (coverage["available"], coverage["tracked"]))
    elif concerns == 0 and strengths:
        summary = ("The reported numbers read well: %d point%s in favour and nothing that stands "
                   "out as a concern, from %d of %d ratios."
                   % (strengths, "" if strengths == 1 else "s", coverage["available"], coverage["tracked"]))
    elif strengths == 0 and concerns:
        summary = ("The reported numbers read poorly: %d concern%s and nothing that stands out in "
                   "favour, from %d of %d ratios."
                   % (concerns, "" if concerns == 1 else "s", coverage["available"], coverage["tracked"]))
    else:
        summary = ("A mixed picture: %d point%s in favour, %d concern%s, from %d of %d ratios."
                   % (strengths, "" if strengths == 1 else "s",
                      concerns, "" if concerns == 1 else "s",
                      coverage["available"], coverage["tracked"]))

    if lender:
        summary += (" Ratios that describe manufacturers rather than lenders have been left out "
                    "of this reading.")

    return {"summary": summary, "findings": findings, "coverage": coverage,
            "strengths": strengths, "concerns": concerns}


def interpret_json(s):
    """String in, string out - the shape Pyodide passes across cleanly."""
    return json.dumps(interpret(json.loads(s)))

"""Tests for src/py/interpret.py, run under normal CPython.

The same file runs in the browser through Pyodide. Testing it here is what makes
the Python genuinely verified rather than a runtime that merely exists.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "py"))
import interpret  # noqa: E402


def run(ratios, bands=None, lender=False, deposit=7.0):
    return interpret.interpret({"ratios": ratios, "bands": bands or {},
                                "lender": lender, "depositRate": deposit})


def labels(res):
    return [f["label"] for f in res["findings"]]


def text_for(res, label):
    for f in res["findings"]:
        if f["label"] == label:
            return f["text"]
    return None


class Silence(unittest.TestCase):
    """A ratio that was not computed must produce no sentence at all."""

    def test_nothing_in_nothing_out(self):
        res = run({})
        self.assertEqual(res["findings"], [])
        self.assertIn("Not enough of the statements", res["summary"])

    def test_missing_ratio_is_never_narrated(self):
        res = run({"netMargin": 12}, {"netMargin": "good"})
        self.assertNotIn("Returns on capital", labels(res))
        self.assertNotIn("Debt load", labels(res))

    def test_nan_and_infinity_are_dropped_not_printed(self):
        res = run({"roce": float("nan"), "roe": float("inf"), "netMargin": 12},
                  {"roce": "good", "roe": "good", "netMargin": "good"})
        self.assertNotIn("Returns on capital", labels(res))
        self.assertNotIn("Return on equity", labels(res))
        self.assertIn("Margins", labels(res))

    def test_a_string_where_a_number_belongs_is_dropped(self):
        res = run({"roce": "lots"}, {"roce": "good"})
        self.assertEqual(res["findings"], [])

    def test_coverage_counts_only_what_was_computed(self):
        res = run({"roce": 20, "roe": 15})
        self.assertEqual(res["coverage"]["available"], 2)
        self.assertGreater(res["coverage"]["tracked"], 20)


class CrossRatioReading(unittest.TestCase):
    """The findings that a table of numbers cannot give you on its own."""

    def test_roe_far_above_roce_is_named_as_leverage(self):
        res = run({"roe": 35, "roce": 18}, {"roe": "good", "roce": "good"})
        self.assertIn("ROE flattered by debt", labels(res))
        # ...and it replaces the plain ROE praise rather than sitting beside it.
        self.assertNotIn("Return on equity", labels(res))

    def test_a_small_roe_roce_gap_is_not_called_leverage(self):
        res = run({"roe": 20, "roce": 18}, {"roe": "good", "roce": "good"})
        self.assertNotIn("ROE flattered by debt", labels(res))

    def test_profit_lagging_sales_is_flagged_as_margin_compression(self):
        res = run({"revGrowth": 25, "niGrowth": 5})
        self.assertIn("Profit lagging sales", labels(res))
        self.assertIn("margins are compressing", text_for(res, "Profit lagging sales"))

    def test_profit_outpacing_sales_is_flagged_the_other_way(self):
        res = run({"revGrowth": 5, "niGrowth": 25})
        self.assertIn("Profit outpacing sales", labels(res))

    def test_similar_growth_rates_produce_neither(self):
        res = run({"revGrowth": 12, "niGrowth": 10})
        self.assertNotIn("Profit lagging sales", labels(res))
        self.assertNotIn("Profit outpacing sales", labels(res))

    def test_dilution_is_caught_when_eps_lags_net_profit(self):
        res = run({"niGrowth": 30, "epsGrowth": 12})
        self.assertIn("Dilution", labels(res))

    def test_no_dilution_finding_when_eps_keeps_up(self):
        res = run({"niGrowth": 30, "epsGrowth": 29})
        self.assertNotIn("Dilution", labels(res))

    def test_comfortable_current_ratio_resting_on_inventory_is_called_out(self):
        res = run({"currentRatio": 2.0, "quickRatio": 0.8})
        self.assertIn("Cover depends on inventory", labels(res))

    def test_wide_gross_to_net_gap_is_explained(self):
        res = run({"grossMargin": 60, "netMargin": 5})
        self.assertIn("Costs below the gross line", labels(res))


class NeverAdvice(unittest.TestCase):
    """Findings describe what the numbers show. They do not tell anyone to act."""

    FORBIDDEN = ["you should", "we recommend", "buy ", "sell ", "must buy",
                 "strong buy", "avoid this", "invest in"]

    def _all_text(self, res):
        return " ".join([res["summary"]] + [f["text"] for f in res["findings"]]).lower()

    def test_no_finding_issues_an_instruction(self):
        # Drive every branch at once and check the whole output.
        wide = {"roce": 25, "roe": 40, "netMargin": -5, "grossMargin": 60,
                "revGrowth": -10, "niGrowth": 5, "epsGrowth": 1,
                "debtToEquity": 3, "interestCover": 1.2, "netDebtEbitda": 5,
                "currentRatio": 0.8, "quickRatio": 0.5,
                "cashConversion": 0.3, "fcfMargin": -8,
                "pe": 80, "peg": 3, "earningsYield": 1.2}
        bands = {"roce": "good", "roe": "good", "netMargin": "weak",
                 "debtToEquity": "weak", "interestCover": "weak",
                 "netDebtEbitda": "weak", "fcfMargin": "weak"}
        body = self._all_text(run(wide, bands))
        for phrase in self.FORBIDDEN:
            self.assertNotIn(phrase, body, "advice-like phrase: %r" % phrase)

    def test_a_negative_peg_is_never_called_cheap(self):
        res = run({"pegBlocked": True, "pe": 20})
        self.assertIn("PEG not meaningful", labels(res))
        self.assertIn("looks cheap and is not", text_for(res, "PEG not meaningful"))


class Lenders(unittest.TestCase):
    """Ratios that describe manufacturers say nothing true about a bank."""

    BANKY = {"debtToEquity": 8, "currentRatio": 0.4, "quickRatio": 0.3,
             "netDebtEbitda": 12, "roce": 3}
    BANDS = {"debtToEquity": "weak", "netDebtEbitda": "weak", "roce": "weak"}

    def test_a_lender_is_not_scolded_for_its_balance_sheet(self):
        res = run(self.BANKY, self.BANDS, lender=True)
        for gone in ["Debt load", "Short-term cover", "Debt against earnings",
                     "Returns on capital"]:
            self.assertNotIn(gone, labels(res))

    def test_and_the_omission_is_stated_rather_than_silent(self):
        res = run(self.BANKY, self.BANDS, lender=True)
        self.assertIn("rather than lenders have been left out", res["summary"])

    def test_the_same_numbers_do_produce_findings_for_a_manufacturer(self):
        res = run(self.BANKY, self.BANDS, lender=False)
        self.assertIn("Debt load", labels(res))
        self.assertIn("Short-term cover", labels(res))

    def test_profitability_still_reads_for_a_lender(self):
        res = run({"netMargin": 25, "roe": 18}, {"netMargin": "good", "roe": "good"}, lender=True)
        self.assertIn("Margins", labels(res))


class Summary(unittest.TestCase):
    def test_all_positive_reads_as_such(self):
        res = run({"roce": 25, "netMargin": 20}, {"roce": "good", "netMargin": "good"})
        self.assertEqual(res["concerns"], 0)
        self.assertIn("read well", res["summary"])

    def test_all_negative_reads_as_such(self):
        res = run({"cashConversion": 0.2, "fcfMargin": -5}, {"fcfMargin": "weak"})
        self.assertEqual(res["strengths"], 0)
        self.assertIn("read poorly", res["summary"])

    def test_mixed_is_called_mixed(self):
        res = run({"roce": 25, "cashConversion": 0.2}, {"roce": "good"})
        self.assertIn("mixed picture", res["summary"])

    def test_singular_and_plural_agree(self):
        one = run({"cashConversion": 0.2})
        self.assertIn("1 concern and", one["summary"])
        self.assertNotIn("1 concerns", one["summary"])


class JsonBridge(unittest.TestCase):
    """The exact call shape Pyodide uses: string in, string out."""

    def test_round_trip(self):
        out = interpret.interpret_json(json.dumps(
            {"ratios": {"roce": 22}, "bands": {"roce": "good"}}))
        parsed = json.loads(out)
        self.assertIn("Returns on capital", [f["label"] for f in parsed["findings"]])

    def test_empty_payload_does_not_raise(self):
        self.assertIn("summary", json.loads(interpret.interpret_json("{}")))

    def test_null_payload_does_not_raise(self):
        self.assertIn("summary", json.loads(interpret.interpret_json("null")))


if __name__ == "__main__":
    unittest.main(verbosity=2)

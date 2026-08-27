# Working on MiyeeStock Buddy

`index.html` is the whole app — one self-contained file you can open from disk
or host anywhere. That portability is deliberate and is not going away.

What has changed is that `index.html` no longer has to be the only place the
source lives. Cleanly separable blocks now live in `src/js/` and are stitched
back in by a build step.

## Commands

```bash
node build.js          # rebuild index.html from src/
node build.js --check  # verify index.html matches src/ (CI runs this)
node tests/run.js      # run the unit tests
npm install            # optional: adds jsdom so the DOM tests run instead of skipping
```

## The rule

**Never hand-edit a region of `index.html` that came from `src/`.** Those
regions are marked in `src/index.template.html` with `// @include js/<file>.js`.
Edit the file in `src/js/`, then run `node build.js`.

Everything else in `index.html` is still edited directly — the migration is
incremental by design. `node build.js --check` fails loudly if the two drift
apart, and that check is part of both the test suite and CI, so drift cannot be
merged silently.

The build is **byte-exact**: rebuilding an unmodified tree reproduces
`index.html` with no diff whatsoever. That property is what makes moving more
code into `src/` safe — if an extraction changes a single byte, the build fails.

## Tests

`tests/run.js` pulls pure functions straight out of `index.html` and exercises
them, so the tests always run against what actually ships. Covered today:

- **XIRR** — lump sums, monthly SIPs, losses, degenerate inputs
- **RSI / EMA** — warm-up, bounds, one shared implementation
- **Momentum engine** — entries, the grace period, whipsaw resistance
- **DVM scores** — trend/valuation behaviour, fundamental vs technical source
- **Trend vs Trading Range** — including the real chart that was misclassified
- **Historical NAV lookup** — weekends, holidays, gaps, out-of-range dates
- **Portfolio persistence** — quota pressure, cache eviction, loud failure
- **Glossary decoration** — markup safety and idempotency (needs jsdom)
- **Build integrity** — `index.html` matches `src/`

When fixing a bug, add the failing case first. Several tests here exist because
a mutation check showed the original assertion passed for the wrong reason.

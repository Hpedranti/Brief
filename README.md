# Brief

A two-minute, phone-first news reader: world news through a US lens, an Economy tab, and running
Storylines. The site in `docs/` is static (GitHub Pages). Once a day a GitHub Action runs
`job/build-brief.mjs` (Node 24, no packages). It reads RSS feeds, FRED data and Kalshi Fed odds,
asks Claude for the day's brief as schema-checked JSON, and commits `docs/data/*.json`.
`CONTRACT.md` is the spec.

## Going live (three steps)

1. Create the GitHub repo **Hpedranti/Brief** (public) and push this folder to `main`.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: `ANTHROPIC_API_KEY`.
   Optional: add a *variable* `BRIEF_MODEL` (for example `claude-sonnet-5`) to override the default `claude-opus-5`.
3. **Settings → Pages**: deploy from branch `main`, folder `/docs`.

The job runs daily at 13:00 UTC (6 am Pacific in summer, 5 am in winter). To run it right away, open
**Actions → brief → Run workflow**.

## Running locally

```
node job/build-brief.mjs --fixture    # offline: job/fixtures/** in, writes docs/data (fictional content)
node job/build-brief.mjs --dry-run    # live feeds + FRED + Kalshi, prints the payload; no Claude call, no writes
node job/build-brief.mjs --validate   # checks docs/data/*.json against the schema; exit 1 on failure
node job/build-brief.mjs              # real run; needs ANTHROPIC_API_KEY
```

Environment overrides: `BRIEF_MODEL`, `BRIEF_NOW` (ISO time, for testing), and
`BRIEF_FIXTURE_RESPONSE` (an alternate canned model response for `--fixture`).

If anything fails (the model refuses, output gets cut off, or the output fails schema validation), the job
exits non-zero and leaves yesterday's files as they were.

## Editing feeds

`job/feeds.json` is a list of `{ "outlet", "url", "kind" }`, where `kind` is `world`, `us`, `econ` or `dc`.
Only use publishers' own RSS or Atom feeds. Run `--dry-run` afterwards and check that the new feed shows `ok`.
A dead feed is logged and skipped, so it never stops the run. As of 2026-09-27, the WSJ feeds
(feeds.a.dj.com) were removed because they have not updated since January 2025. Reuters and AP have
no public RSS feeds.

## Cost

Each run makes one Claude call: about 15–20K input tokens and 3–6K output tokens. On `claude-opus-5`
($5/M input, $25/M output) that is roughly $0.15–0.25 a day, or about $5–8 a month. On `claude-sonnet-5`
($2/$10) it costs about 40% of that. Each run logs its token usage and estimated cost.

## Yearly check: FOMC dates

The job reads the meeting calendar from federalreserve.gov. If that page can't be parsed, it falls back
to the hardcoded 2026 list (`FOMC_HARDCODED` in `job/build-brief.mjs`). **Every December, add the
next year's meeting dates** to that list. The dry-run log shows whether the live calendar matches it.

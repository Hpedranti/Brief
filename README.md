# Brief

A phone-first news feed you can doomscroll: full-screen swipe cards, refreshed three times a day by
Claude and ordered on your phone by your 👍/👎 votes, plus Economy and Threads tabs. The site in
`docs/` is static (GitHub Pages). A GitHub Action runs `job/build-brief.mjs` (Node 24, no packages)
at 13:00, 19:00 and 01:00 UTC. Each run is a **drop**: it reads RSS/Atom feeds, FRED data and
Kalshi Fed odds, asks Claude for 35–50 schema-checked cards, and commits `docs/data/*.json`.
`CONTRACT.md` is the spec.

Claude never sees your votes. Ranking happens on the phone (`docs/rank.js`), and your taste lives in
the browser's localStorage (`docs/taste.js`). Use Settings → Export to back it up.

## Going live (three steps)

1. Create the GitHub repo **Hpedranti/Brief** (public) and push this folder to `main`.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: `ANTHROPIC_API_KEY`.
   Optional *variables*: `BRIEF_MODEL` (default `claude-opus-5-5`) and `BRIEF_EFFORT` (default `medium`).
3. **Settings → Pages**: deploy from branch `main`, folder `/docs`.

The committed `docs/data/feed.json` is sample data (`"sample": true`). The first real drop ignores it
and starts a fresh pool and fresh storylines. To run a drop right away, open
**Actions → brief → Run workflow**. A second run in the same UTC hour is skipped without calling Claude,
because drop ids are `YYYY-MM-DDTHH`.

## Running locally

```
node job/build-brief.mjs --fixture    # offline: two canned fictional drops from job/fixtures/** → docs/data
node job/build-brief.mjs --dry-run    # live feeds + FRED + Kalshi, prints per-feed status; no Claude call, no writes
node job/build-brief.mjs --dry-run --print   # … and print the full payload
node job/build-brief.mjs --validate   # checks docs/data/*.json against the v2 shape; exit 1 on failure
node job/build-brief.mjs              # real run; needs ANTHROPIC_API_KEY
node --test job/test-rank.mjs         # ranking, taste storage, pool merge and card checks
```

`--fixture` overwrites `docs/data`. To get the committed sample data back, run
`git checkout -- docs/data` and delete any new `docs/data/history/*.json` files.

Environment overrides: `BRIEF_MODEL`, `BRIEF_EFFORT`, `BRIEF_NOW` (an ISO time, for testing), and
`BRIEF_FIXTURE_RESPONSE` (one alternate canned model response for `--fixture`).

## What a drop does

- Feed window: entries since the previous drop minus 2 h, at most 36 h back. Duplicates are removed by
  URL and by near-identical title. At most 300 entries go to the model (spread evenly across outlets),
  with summaries cut to 300 characters.
- The model gets the last 72 h of card headlines and ids, so it does not repeat them. It returns
  `{ cards[], economy{}, storylines[] }`. The job assigns card ids (`<drop>-c01`…) and checks each card.
  A card is dropped, with a log line, if its topic is not in `job/topics.json`, its source URL was not
  in the input, its `follows` id is not in the pool, or it repeats a pool headline without `follows`.
  If fewer than 20 cards survive, the run fails.
- Writes `feed.json` (rolling pool: 72 h, at most 250 cards, oldest drop first out), `economy.json`,
  `storylines.json`, `topics.json` (a copy of `job/topics.json`), and `history/<drop>.json` (kept 14 days).
  It also deletes the retired `docs/data/brief.json`.

If anything fails (the model refuses, output gets cut off, the economy or storylines fail validation, or
too few cards survive), the job exits non-zero and leaves the previous files as they were.

## Editing feeds

`job/feeds.json` is a list of `{ "outlet", "url", "kind" }`, where `kind` is `world`, `us`, `econ`, `dc`,
`tech`, `science`, `business` or `defense`. Only use publishers' own RSS or Atom feeds. Run `--dry-run`
afterwards: it lists any feed that failed or had no entries in the window. A dead feed is logged and
skipped, so it never stops the run. As of 2026-09-27, the WSJ feeds (feeds.a.dj.com) were removed
because they had not updated since January 2025. Reuters and AP have no public RSS feeds.

## Cost

Each drop makes one Claude call: about 35K input tokens (300 articles plus recent headlines) and
15–25K output tokens, including thinking. On `claude-opus-5-5` ($4/M input, $20/M output) that is
roughly $0.45–0.65 a drop, or about $40–60 a month at three drops a day. Each run logs its token usage
and estimated cost. The first real runs' logs replace this estimate. Set a monthly spend limit in the
Anthropic console as a backstop.

## Yearly check: FOMC dates

The job reads the meeting calendar from federalreserve.gov. If that page can't be parsed, it falls back
to the hardcoded 2026 list (`FOMC_HARDCODED` in `job/build-brief.mjs`). **Every December, add the
next year's meeting dates** to that list. The dry-run log shows whether the live calendar matches it.

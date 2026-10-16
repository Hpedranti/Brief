# Brief v2 — contract

A phone-first news feed you can doomscroll. Full-screen swipe cards, refreshed three times a day by
Claude, and reordered on your phone by your 👍/👎 votes. Economy and Threads stay as side tabs.
Zero build step, zero npm packages. Static site + one scheduled job. (v1 contract: see git history,
commit c48db43.)

## What changes from v1

| | v1 | v2 |
|---|---|---|
| Main screen | Today tab, 3–5 items | **Feed**: full-screen vertical swipe cards, ~40–50 new per drop |
| Refresh | 1×/day | **3×/day** ("drops") |
| Personal | none | **👍/👎 votes stored in localStorage; the phone ranks the feed** |
| Claude sees votes | n/a | **Never.** Claude writes and tags cards; the phone does the personal ranking |
| Washington tab | separate | folded into the feed (topic `us-politics`, `courts`, …) |
| Economy, Threads | tabs | unchanged tabs (Economy refreshed each drop) |

## Repo layout

```
docs/                         # the PWA, served as-is by GitHub Pages (main, /docs)
  index.html
  app.js                      # shell: tabs, data loading, rendering (vanilla ES modules)
  feed.js                     # swipe feed UI: cards, rail buttons, detail sheet, dwell tracking
  rank.js                     # PURE ranking + taste-update functions (no DOM), importable by Node tests
  taste.js                    # localStorage state (load/save/migrate/export/import)
  styles.css
  sw.js                       # shell cache + last data for offline
  manifest.webmanifest, icons
  data/feed.json              # rolling card pool — written by the job
  data/economy.json           # Economy tab — written by the job
  data/storylines.json        # Threads tab — written by the job
  data/history/YYYY-MM-DDTHH.json   # copy of each drop's new cards (kept 14 days)
job/
  build-brief.mjs             # Node 24, ZERO dependencies
  brief.schema.json           # model output schema (also used by --validate)
  topics.json                 # the fixed topic vocabulary (shared by job prompt + schema + app)
  feeds.json
  fixtures/
  test-rank.mjs               # node --test style checks for docs/rank.js (built-in node:test only)
.github/workflows/brief.yml   # 3 crons + workflow_dispatch
```

`docs/data/brief.json` is retired. The job deletes it on the first v2 run.

## Runtime rules (unchanged from v1)

- The laptop is never a server. The job runs in GitHub Actions; the site is static.
- Never overwrite a data file with anything that fails validation. Any failure → exit non-zero, leave
  the previous files untouched.
- Every fetch has a timeout (10 s) and fails soft.
- No third-party JS/CSS at all (v2 uses the system font). No analytics, no tracking, no cookies.
- **No publisher images** (they would be third-party requests that leak reads to publishers). Cards
  are typographic. See open question 1.

## Schedule

Cron at **13:00, 19:00, 01:00 UTC** = 6 am / noon / 6 pm Pacific in summer (5/11/5 in winter).
Each run is one **drop**. `concurrency: brief-job` stays, so runs never overlap.

## Feeds

v1 has 13 feeds, which is too few for ~45 good cards per drop. v2 widens `feeds.json` with
publishers' own RSS/Atom only, adding at least: tech (The Verge, Ars Technica, TechCrunch),
robotics/AI (IEEE Spectrum, The Robot Report), science (Nature News, Science), business
(Bloomberg/FT if a public feed works, else skip), defense (Defense One, Breaking Defense), and
space (SpaceNews). Each new feed must show `ok` in `--dry-run` before it's committed. `kind` gets the
new values `tech`, `science`, `business`, `defense`.

Window per drop: entries published since the previous drop minus 2 h (overlap), max 36 h. Dedupe by
URL + near-identical title. Cap **300** entries sent to the model, summary ≤ 300 chars each.

## Topics (`job/topics.json`)

A fixed vocabulary of ~30 slugs, so votes on Monday still mean something on Friday. Starting list
(editable later; renaming a slug resets its learned weight):

```
geopolitics, war-conflict, europe, china, middle-east, asia, latin-america, africa,
us-politics, courts, elections, policy-regulation,
economy, fed-rates, markets, jobs-labor, trade, energy, climate,
ai, robotics, chips, big-tech, startups-vc, cybersecurity, space, science, health,
defense, autos-transport, crime-justice, culture-sports
```

## docs/data/feed.json

```jsonc
{
  "version": 2,
  "updated_at": "2026-10-16T13:04:12Z",
  "drops": [ { "id": "2026-10-16T13", "at": "2026-10-16T13:04:12Z", "model": "claude-opus-5-5", "count": 46 } ],
  "cards": [
    {
      "id": "2026-10-16T13-c07",            // `<drop id>-c<nn>`, stable forever
      "drop": "2026-10-16T13",
      "headline": "≤ 80 chars, plain, no clickbait",
      "summary": "≤ 45 words. What happened.",
      "why_it_matters": "≤ 30 words. Why a US reader should care.",
      "region": "Europe | Middle East | Asia | Americas | Africa | US | Global",
      "topics": ["fed-rates", "markets"],    // 1–3, from topics.json only
      "entities": ["Federal Reserve", "Jerome Powell"],   // 0–4 proper nouns, canonical spelling
      "importance": 4,                       // 1–5, Claude's editorial weight for a general reader
      "follows": "2026-10-15T19-c03",        // id of an earlier card this develops, or null
      "storyline_id": "sl-fed-path",         // or null
      "published_at": "2026-10-16T11:40:00Z",// earliest source time
      "sources": [{ "outlet": "NPR", "title": "…", "url": "https://…" }]   // 1–3
    }
  ]
}
```

- Pool = cards from the **last 72 h**, max **250** cards (oldest drop dropped first).
- Each drop adds **35–50** cards. Claude gets the last 72 h of headlines + ids so it does not repeat a
  story. A real development on an old story becomes a new card with `follows` set.
- Variety rule in the prompt: no more than 6 cards in one drop share a primary topic; at least 8
  topics represented per drop when the news allows it.

## docs/data/economy.json

Same shape as v1 `brief.json.economy` (`read`, `indicators`, `fed`, `week_ahead`) plus
`version: 2`, `updated_at`. Econ news no longer has its own `items`; it lives in the feed.

## docs/data/storylines.json

Unchanged from v1. Updated every drop. Cards link to storylines through `storyline_id`.

## Client state (localStorage key `brief.taste.v2`)

```jsonc
{
  "votes":   { "2026-10-16T13-c07": 1 },          // 1 = 👍, -1 = 👎; one per card, tap again to clear
  "weights": { "topic": { "robotics": 3.2 }, "entity": { "Nvidia": 1.5 } },   // learned
  "seen":    { "2026-10-16T13-c07": 1760620000 }, // unix seconds a card was ≥ 60% on screen for ≥ 1 s
  "dwell":   { "2026-10-16T13-c07": 7.4 },        // seconds on screen, latest visit
  "last_open": "2026-10-16T16:12:00Z",
  "tab": "feed"
}
```

- Pruned on load: entries for card ids no longer in `feed.json` are removed from `seen`/`dwell`
  (votes are kept 30 days for stats, then dropped). Weights live forever.
- **Settings → Your taste**: top liked/disliked topics and entities, "Reset taste", and
  **Export / Import** (a JSON file). Safari can clear storage for a site that's only used in a
  browser tab, so the app tells you to add it to the Home Screen, and export is the backup.
- v1 state (`brief.state.v1`) is ignored and deleted.

## Ranking (`docs/rank.js`, pure functions, unit-tested in Node)

On every vote:

- 👍: each card topic weight += 1.0, each entity weight += 0.6
- 👎: each card topic weight −= 1.0, each entity −= 0.6, and the card is hidden for good
- Clearing a vote reverses exactly what it added.
- Implicit: on leaving a card, dwell ≥ 8 s → topics += 0.25; dwell < 1.2 s → topics −= 0.1
  (once per card).
- Weights clamp to [−6, +6].

Score for an unseen card:

```
score = 1.0 * importance
      + mean(topic weights of its topics)       // unknown topic = 0
      + 0.5 * max(entity weights of its entities, 0 if none)
      - 0.08 * age_hours                         // freshness
      + 1.5 if it `follows` a card you 👍'd
```

Feed order when the app opens (or a new drop arrives):

1. Unseen cards, highest score first, with these rules:
   - **Exploration:** every 6th slot is the highest-importance unseen card whose topics all have
     weight ≤ 0, so the feed never turns into a bubble.
   - No two adjacent cards share a primary topic when another choice is within 1.0 of the score.
2. A **"You're caught up"** card (counts what's new since `last_open`, shows when the next drop lands).
3. Seen cards, newest first, dimmed, so the scroll keeps going.
4. 👎 cards never appear.

The order is computed once per open and is **not reshuffled mid-scroll**. Votes change weights
straight away but only affect the order next time. If a new drop lands while the app is open, a
"N new stories ↑" pill appears and reorders only when you tap it.

## Feed UI

- Each card fills the viewport (`100dvh`, CSS `scroll-snap-type: y mandatory`); swipe up = next.
  Native scroll only, no JS gesture library, 60 fps on iPhone Safari (animate opacity/transform only).
- Card layout, top to bottom: region · topic chip · age ("2h") · NEW dot; headline (big, Archivo
  800+); summary; "Why it matters" block; sources row (outlet names).
- Right rail (thumb side): 👍, 👎, ↗ (opens the first source in a new tab), ⋯ (detail sheet with all
  sources, the storyline link and "Why am I seeing this?": the topic/entity weights that scored it).
- **Double-tap a card = 👍** with a small spring burst animation in the accent color. Haptic `navigator.vibrate` if
  available.
- A 👎 card fades out and the feed snaps to the next card.
- Top overlay: wordmark + tabs **Feed · Economy · Threads** + ⚙ (Settings). It fades while scrolling and
  returns on a pause or a tap.
- Progress hint: thin bar on the right edge showing position in the unseen stack.
- Economy and Threads tabs keep their v1 content, restyled to match.

## Design language: simple, Apple-inspired, fun to scroll

Harrison's brief (2026-10-15): "a simple Apple-inspired design language that is fun to doomscroll."
This replaces v1's Dartfrog look.

- **Type does the work.** System font stack (`-apple-system, BlinkMacSystemFont, "SF Pro", …`), which
  is SF Pro on his iPhone and needs no download. **This drops the Google Fonts dependency.**
  Big bold headlines (Large Title scale, ~34 px, weight 700, tight tracking), calm 17 px body text,
  small caps-style eyebrow (region · topic · age) in secondary gray.
- **Restraint.** One accent color (to be picked in the variant round; iOS system blue is the baseline),
  system grays for everything else, generous margins (20 px), no borders or dividers where spacing
  works.
- **Light and dark follow the phone.** Both are first-class; Apple's semantic colors (label,
  secondaryLabel, systemBackground, secondarySystemBackground) are the model.
- **Materials.** The top bar, rail and sheets use translucent blur (`backdrop-filter`) like iOS
  chrome, but content is never covered by heavy panels.
- **Motion with springs.** Spring curves on vote buttons, the double-tap heart burst, sheet open/close,
  and the "N new" pill. Transform + opacity only; respect `prefers-reduced-motion`.
- **Icons** in an SF Symbols style: inline SVG, 1.5–2 px rounded strokes, filled state when active.
- **Sheets, not pages.** Detail, Settings and "Why am I seeing this?" open as iOS-style bottom
  sheets with a grabber, swipe down to close.
- **Fun comes from feel, not decoration.** Satisfying snap, instant vote feedback, haptics, a
  satisfying "You're caught up" moment, and each card's background gets a soft per-topic tint so the
  scroll has rhythm.
- **Variant round first.** Before the full build, 4 worktree agents each build the feed screen in a
  different Apple-inspired direction against fixture data (for example: News-style editorial,
  Weather-style per-topic gradients, Photos/Memories-style bold, Notes-style minimal). They're served
  on a live launcher Harrison can open on his iPhone over the LAN. He picks one or mixes them, and
  then the full build uses that direction.

## Claude call

Same raw-HTTPS rules as v1 (no SDK, structured outputs via `output_config.format`, check
`stop_reason`, log `usage` + estimated cost every run). Changes:

- Default model `claude-opus-5-5` (`BRIEF_MODEL` var still overrides).
- `max_tokens` 32000 (a drop's JSON is ~15–20K tokens).
- Model output = `{ cards[], economy{}, storylines[] }`. The job assigns `id`, `drop`, and checks:
  every topic ∈ topics.json, every source URL was in the input, `follows` points at a real card.
  Bad cards are dropped with a log line (not the whole run) unless fewer than 20 survive → fail.
- Card ids are assigned by the job, not the model.

**Cost:** expected ~$0.50–1.00 per drop on Opus, so roughly $45–90 a month at 3 drops a day,
within the $200 credit. The first runs' logged usage replaces this estimate. Harrison sets a monthly
spend limit in the Anthropic console as a backstop.

## Modes (unchanged names)

- `--fixture` (no network; canned response with ~40 fictional cards over two drops so ranking and
  pool-rollover are exercised), `--dry-run`, `--validate`, real run.
- `node --test job/test-rank.mjs`: ranking rules above, including vote reversal, clamp, exploration
  slot, adjacency rule, 👎 hidden, no reshuffle.

## Verification before anything ships

- `--fixture` + `--validate` + `node --test` green.
- Edge headless screenshots at iPhone size (390×844) in `qa/v2/`: first card, mid-scroll, after 👍,
  after 👎, caught-up card, detail sheet, Economy, Threads, Settings/taste, light + dark.
- A seeded-taste run showing the order actually changes (screenshot of top 5 before and after
  voting on robotics).
- One real `workflow_dispatch` run on GitHub after Harrison adds the API key. Push only with his OK.

## Open questions for Harrison

1. **Images:** typographic cards only (private, consistent), or allow publisher thumbnails from RSS
   (more scroll-y, but every image load pings the publisher)?
2. Topic list above: anything to add or cut?
3. Double-tap = 👍: keep or drop?

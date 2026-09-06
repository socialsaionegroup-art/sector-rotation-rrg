# Sector Rotation — RRG

A Relative Rotation Graph for NSE sectoral indices, in the style of the
StockMojo sector-rotation page. Runs entirely on your own machine.

## Run it

Double-click **`Start RRG.bat`**.

That downloads fresh prices (if the last download is more than 6 hours old),
starts a small local web server, and opens the chart in your browser.
Press `Ctrl+C` in the black window to stop it.

From a terminal, the same thing:

```
python serve.py                 # fetch if stale, serve, open browser
python serve.py --no-fetch      # serve whatever data is already on disk
python serve.py --fetch         # force a fresh download first
python serve.py --port 9000
python fetch_data.py --verbose  # download only, showing every symbol tried
```

Requirements: **Python 3.8+ and an internet connection.** Nothing to `pip install` —
the fetcher uses only the standard library.

> Open the page through `serve.py`, not by double-clicking `index.html`.
> Browsers block a `file://` page from reading `data/prices.json`.

## Reading it on your phone

`serve.py` only listens on this PC, so nothing else on the network can reach it.
To get the chart on a phone, publish it as a static site — the whole app is four
files and a JSON, with no server logic behind it:

```
python publish.py --setup    # one-time: the GitHub Pages steps, ~5 minutes
python publish.py            # every time after: fetch fresh prices and push
```

`publish.py` refreshes the prices, copies `index.html`, `app.js`, `styles.css`
and `data/prices.json` into `docs/`, commits and pushes. GitHub Pages serves
`docs/` at `https://<you>.github.io/<repo>/`. Bookmark that on the phone and add
it to the home screen — it behaves like an app, and the PC can be switched off.

### Keeping it current without touching the PC

The repo ships `.github/workflows/refresh-prices.yml`. Once it's on GitHub, the
fetch runs **on GitHub's machines** every weekday at 16:35 IST — about an hour
after the close — and republishes the site. Your PC is not involved and can stay
off. Check it's enabled once under the repository's **Actions** tab.

One setting to change first, or the very first run fails with "permission
denied": **Settings → Actions → General → Workflow permissions → Read and write
permissions**. New repos hand Actions a read-only token, and the job needs to
commit the refreshed prices back.

To refresh on demand *from your phone*: **Actions → Refresh prices → Run
workflow**. The site updates a minute or so later. That button is the answer to
"I'm not at my PC and I want today's data".

Each run leaves a summary on the Actions page: the last bar date, anything found
by symbol search, anything lagging, anything with no source — so you can audit
the data from the phone too, without opening the JSON.

The runner skips NSE entirely (`--no-nse`), because NSE blocks datacentre IPs
outright; Yahoo plus the symbol search does the work there. It retries three
times before giving up, and a failed run publishes nothing rather than
overwriting good data with bad.

One quirk of GitHub's free tier worth knowing: scheduled workflows are paused
after 60 days of no repository activity. The daily commit normally counts as
activity, but if the market is shut for a long stretch you may get an email
asking you to re-enable it — one click.

Two things follow from it being static rather than live:

- The site shows whatever prices were current the last time you ran
  `publish.py`. The header always states the last bar date, so it can't mislead
  you about that — but it will not move on its own.
- **Refresh data** is hidden on the hosted version, because that button calls
  back into `serve.py`, which isn't there. Locally it still works.

A GitHub Pages site is public. That's fine here — the repo holds public market
prices and this code, nothing personal — but don't add anything private to the
folder once it's a repo.

The layout adapts to a phone: the legend becomes a single column under the
chart, axis titles drop away on very narrow screens, and tapping a sector's dot
opens its readout (a finger gets a wider hit area than a cursor).

## Using the chart

| Control | What it does |
|---|---|
| Benchmark | What everything is measured against — Nifty 50, Bank Nifty, FinNifty, Midcap or Sensex |
| Daily / Weekly | Weekly is slower and cleaner; daily reacts sooner and whipsaws more |
| Tail length | How many past periods of each sector's path to draw |
| Scrubber / ▶ | Step or animate through history to watch the rotation happen |
| Click a sector | In the legend or the table — hides/shows it |
| Table headers | Click to sort |

Keyboard: `←` `→` step one period, `space` plays/pauses.

**The four quadrants.** Sectors travel clockwise around the centre:

```
        RS-Momentum
             ▲
  IMPROVING  │  LEADING          Improving → Leading → Weakening
   (turning  │  (strong and       → Lagging → Improving …
     up)     │   still rising)
─────────────┼─────────────►  RS-Ratio
   LAGGING   │  WEAKENING
   (weak and │  (still strong,
    falling) │   losing steam)
```

Money tends to arrive in a sector while it is still in **Improving** and to
leave while it is still in **Weakening** — the top-left and bottom-right
quadrants are where the changes of leadership actually show up.

## How the numbers are built

Everything is derived in the browser from daily closes, so switching benchmark,
timeframe or tail length is instant. For each sector:

1. **Relative strength** — `log(sector / benchmark)`. Logs so a 10% gain and a
   10% loss are the same size in opposite directions.
2. **Trend deviation** — that series minus its own long exponential average
   (100 days, or 26 weeks). This is the part that says whether a sector is
   currently above or below its own established relationship with the benchmark.
   The long window is what lets a sector that has led for months *stay* on the
   right-hand side instead of being normalised back to the middle.
3. **RS-Ratio** = `100 + deviation / spread`, where *spread* is how widely all
   the sectors are dispersed around the benchmark on that date, smoothed over
   time. Dividing by a live dispersion measure is what makes a reading of 101
   mean the same thing in a calm market and a violent one.
4. **Momentum** — the gap between a fast and a slow average of RS-Ratio, lightly
   smoothed. This is the *rate of change* of relative strength.
5. **RS-Momentum** = `100 + momentum / spread`, scaled the same way.

Both axes are therefore centred on 100 = "in line with the benchmark", and are
in units of cross-sectional spread, so distance from the centre is comparable
between sectors and across time.

The `Δ` columns in the table are the one-period change in each coordinate, and
**Heading** is the compass direction the sector is currently travelling in —
NE means strengthening and accelerating, SW means weakening and decelerating.
**Rel. perf** is the plain, un-normalised return of the sector minus the
benchmark's over the tail window, as a sanity check on the maths.

## Where the prices come from

Two sources, tried in this order for each index:

1. **NSE India** (`nseindia.com` historical index API) — the actual published
   index. Authoritative, and currently the only place most Nifty sectoral
   indices are still updated daily. It needs the browser-style cookies the
   fetcher sets up automatically, and in practice an Indian connection.
2. **Yahoo Finance** — index symbols where they still work, otherwise the
   matching ETF.

3. **Yahoo symbol search** — if everything configured for an index is dead or
   stale, the fetcher asks Yahoo which symbols actually exist for that name,
   tries them, and keeps the first current one. Anything found this way is
   printed under **FOUND BY SEARCH** at the end of the run — glance at that list
   once and pin the right ticker in `universe.json`, because a search can pick
   a plausible wrong instrument and nothing downstream would notice.

NSE blocks non-browser clients fairly aggressively; if it answers 503 twice the
fetcher gives up on it for the rest of the run rather than retrying 27 times.

Every candidate is downloaded and the **freshest** one wins. That matters:
Yahoo still serves several `^CNX…` index symbols that quietly stopped updating
in July 2026 — they return a full history that simply ends. Picking the first
symbol that "works" would silently hand you a dead series.

The chart defends against the same thing from the other side: a series whose
last bar is more than ten days behind the newest one in the file is **excluded**
and named in a banner, and a gap of more than five bars is never forward-filled.
A stale price held flat against a benchmark that keeps moving looks exactly like
steady out-performance, which would drag that sector into the Leading quadrant
and quietly corrupt the whole picture.

```
python fetch_data.py --verbose   # show every source and symbol tried
python fetch_data.py --no-nse    # Yahoo only
python fetch_data.py --no-yahoo  # NSE only
```

## Indices rebuilt from their constituents

Yahoo stopped updating several `^CNX…` index symbols in July 2026, and never
carried the newer ones at all. It does still serve the individual NSE stocks,
so those indices are rebuilt from their members. Anything rebuilt this way is
marked with a **~** in the chart, the legend and the table, and listed as a
**proxy** in the sources panel. It is not the published index and the app never
pretends otherwise.

The interesting problem is the weights. Real Nifty indices are free-float
market-cap weighted with capping rules, and the free-float factors aren't public
here. Two cases:

**The index has past data** (Realty, Energy, Media, PSE, Commodities, Services).
Then the weights don't need to be looked up — they can be *fitted*. The fetcher
solves for the non-negative weights that best reproduce the index's own past
daily returns, then carries them forward and splices the result onto the real
history at the point the feed died. Every value before that date is the genuine
index; only the tail is synthetic.

Two useful properties fall out of fitting rather than guessing:

- A member that was never really in the index gets a weight of ~0, so an
  imperfect constituent list largely corrects itself. You can list generously.
- The fit is measurable. The **correlation** shown against each proxy is how
  well those weights reproduce the index over the period where both exist.
  On test data: a correct member list scores ~1.00; missing 15% of the index
  weight scores 0.99 and drifts ~0.2% over six weeks; missing half the index
  scores 0.90 and drifts ~0.6%. So a bad list announces itself instead of
  quietly lying. **Treat anything below ~0.95 as a constituent list that needs
  fixing.**

**The index has no past data at all** (Consumer Durables, Defence, Chemicals,
Capital Markets). There is nothing to fit against, so those use equal weights
and are labelled *unverified*. They show the sector's broad direction, but an
equal-weight basket genuinely differs from a cap-weighted index, and no number
in the app can tell you by how much. Weigh them accordingly.

Nifty Smallcap 100 is deliberately not rebuilt — 100 members is a list nobody
will maintain correctly. It looks for a Smallcap 250 ETF instead, which is a
different index; if none is found it stays excluded.

Constituent lists live in `universe.json` under `constituents`. They go stale as
indices rebalance — when a correlation starts drifting down, that's the signal
to update the list.

## Changing what's tracked

Edit **`universe.json`** and re-run. Each entry has an `nse` index name (the
primary source) and a list of Yahoo `symbols` as fallbacks. Set
`"benchmark": true` to make an entry selectable as the benchmark, `"sector": true`
to plot it. Individual stocks work the same way:
`{ "id": "TCS", "name": "TCS", "short": "TCS", "sector": true, "symbols": ["TCS.NS"] }`.

If a sector prints **MISS**, neither source served it — add an alternative
symbol (usually the matching ETF, e.g. `ITBEES.NS`). If it prints under
**STALE**, the source is answering but no longer updating.

## Files

```
index.html        the page
app.js            RRG maths + canvas chart + table
styles.css        light/dark theme
universe.json     which indices to track  ← edit this
fetch_data.py     downloads daily closes  → data/prices.json
serve.py          fetch + local server + opens browser
Start RRG.bat     double-click launcher (Windows)
publish.py        fetch + push to GitHub Pages, for phone access
.github/workflows/refresh-prices.yml   daily auto-refresh, runs on GitHub
docs/             the generated static site (created by publish.py)
data/prices.json  cached prices (regenerated, safe to delete)
```

Prices come from the public Yahoo Finance chart endpoint. Educational tool —
not investment advice.

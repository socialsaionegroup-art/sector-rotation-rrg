"""
Downloads daily closing prices for every instrument in universe.json and
writes data/prices.json.

Two sources, tried in this order per instrument:
  1. NSE India (www.nseindia.com historical index API) - the actual index,
     authoritative, and currently the only place most Nifty sectoral indices
     are still published. Needs an Indian connection in practice.
  2. Yahoo Finance chart API - index symbols where they still work, else the
     matching ETF. Every candidate is tried and the FRESHEST one wins, because
     Yahoo keeps serving several NSE index symbols that stopped updating.

Pure standard library - no pip install needed. Python 3.8+.

Usage:
    python fetch_data.py               # normal refresh
    python fetch_data.py --verbose     # show every source and symbol tried
    python fetch_data.py --no-nse      # Yahoo only
    python fetch_data.py --no-yahoo    # NSE only
"""

import gzip
import io
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.cookiejar import CookieJar

HERE = os.path.dirname(os.path.abspath(__file__))
UNIVERSE_PATH = os.path.join(HERE, "universe.json")
OUT_DIR = os.path.join(HERE, "data")
OUT_PATH = os.path.join(OUT_DIR, "prices.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv
USE_NSE = "--no-nse" not in sys.argv
USE_YAHOO = "--no-yahoo" not in sys.argv

# how far behind the freshest series a source may be before we call it stale
STALE_TOLERANCE_DAYS = 7
MIN_BARS = 120


def log(m):
    print(m, flush=True)


def vlog(m):
    if VERBOSE:
        print("      " + m, flush=True)


# --------------------------------------------------------------- transport
_CTX = ssl.create_default_context()
_JAR = CookieJar()
_OPENER = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(_JAR),
    urllib.request.HTTPSHandler(context=_CTX),
)


BROWSER_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Connection": "keep-alive",
}


def get(url, headers=None, timeout=30):
    h = dict(BROWSER_HEADERS)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with _OPENER.open(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    return raw


def get_json(url, headers=None, timeout=30):
    return json.loads(get(url, headers, timeout).decode("utf-8", "replace"))


# ------------------------------------------------------------ source: NSE
_NSE_READY = [False]
NSE_HOME = "https://www.nseindia.com"


NAV_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}
API_HEADERS = {
    "Accept": "*/*", "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    "Referer": NSE_HOME + "/reports-indices-historical-index-data",
}


def nse_warmup(force=False):
    """NSE only answers its API once a real browsing session has set cookies."""
    if _NSE_READY[0] and not force:
        return True
    if force:
        _JAR.clear()
    for page in ("/", "/market-data/live-market-indices",
                 "/reports-indices-historical-index-data"):
        try:
            get(NSE_HOME + page, dict(NAV_HEADERS,
                **({"Referer": NSE_HOME + "/"} if page != "/" else {})))
            time.sleep(0.6)
        except Exception as e:  # noqa: BLE001
            vlog("NSE warmup %s -> %s %s" % (page, type(e).__name__, str(e)[:40]))
    ok = len(_JAR) > 0
    _NSE_READY[0] = ok
    if not ok:
        vlog("NSE set no cookies - the site is refusing this client")
    return ok


def _nse_records(payload):
    """The API has shipped a few different shapes; find the record list."""
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("indexCloseOnlineRecords", "data"):
        v = payload.get(key)
        if isinstance(v, list):
            return v
        if isinstance(v, dict):
            inner = v.get("indexCloseOnlineRecords")
            if isinstance(inner, list):
                return inner
    return []


_DATE_KEYS = ("EOD_TIMESTAMP", "TIMESTAMP", "HistoricalDate", "mTIMESTAMP", "CH_TIMESTAMP")
_CLOSE_KEYS = ("EOD_CLOSE_INDEX_VAL", "CLOSE", "closePrice", "CH_CLOSING_INDEX_VAL", "last")


def _parse_date(s):
    for f in ("%d-%b-%Y", "%d %b %Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(str(s).strip(), f).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


_NSE_STRIKES = [0]


def fetch_nse(index_name, days):
    if _NSE_STRIKES[0] >= 2:
        return None, "disabled after repeated blocks"
    if not nse_warmup():
        _NSE_STRIKES[0] += 1
        return None, "no cookies"

    end = datetime.now()
    start = end - timedelta(days=days)
    rows = {}
    cursor = start
    err = None

    while cursor < end:
        chunk_end = min(cursor + timedelta(days=360), end)
        url = (NSE_HOME + "/api/historical/indicesHistory?indexType="
               + urllib.parse.quote(index_name)
               + "&from=" + cursor.strftime("%d-%m-%Y")
               + "&to=" + chunk_end.strftime("%d-%m-%Y"))
        payload = None
        for attempt in (0, 1):
            try:
                payload = get_json(url, API_HEADERS)
                break
            except urllib.error.HTTPError as e:
                err = "HTTP %s" % e.code
                if e.code in (401, 403, 503) and attempt == 0:
                    vlog("NSE %s - re-warming cookies" % err)
                    time.sleep(1.2)
                    nse_warmup(force=True)
                    continue
                break
            except Exception as e:  # noqa: BLE001
                err = type(e).__name__ + " " + str(e)[:50]
                break

        if payload is None:
            vlog("NSE chunk failed (%s): %s" % (cursor.strftime("%Y-%m"), err))
            if err in ("HTTP 401", "HTTP 403", "HTTP 503"):
                _NSE_STRIKES[0] += 1
                return None, err + " (NSE is blocking this client)"
            cursor = chunk_end + timedelta(days=1)
            time.sleep(0.5)
            continue

        for rec in _nse_records(payload):
            if not isinstance(rec, dict):
                continue
            d = c = None
            for k in _DATE_KEYS:
                if rec.get(k):
                    d = _parse_date(rec[k])
                    if d:
                        break
            for k in _CLOSE_KEYS:
                if rec.get(k) not in (None, ""):
                    try:
                        c = float(str(rec[k]).replace(",", ""))
                    except ValueError:
                        c = None
                    if c:
                        break
            if d and c:
                rows[d] = round(c, 4)

        cursor = chunk_end + timedelta(days=1)
        time.sleep(0.45)

    if len(rows) < MIN_BARS:
        return None, (err or "only %d bars" % len(rows))
    dates = sorted(rows)
    return (dates, [rows[d] for d in dates]), None


# --------------------------------------------------------- source: Yahoo
YHOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]


def fetch_yahoo(symbol, days):
    period2 = int(time.time()) + 86400
    period1 = period2 - int(days * 86400 * 1.05) - 86400
    qs = ("?period1=%d&period2=%d&interval=1d&includePrePost=false&events=div%%2Csplit"
          % (period1, period2))
    path = "/v8/finance/chart/" + urllib.parse.quote(symbol, safe="")

    err = None
    for host in YHOSTS:
        try:
            payload = get_json("https://" + host + path + qs)
        except Exception as e:  # noqa: BLE001
            err = type(e).__name__ + " " + str(e)[:60]
            continue

        chart = (payload or {}).get("chart") or {}
        if chart.get("error"):
            err = str(chart["error"])[:70]
            continue
        res = (chart.get("result") or [None])[0]
        if not res:
            err = "empty result"
            continue

        stamps = res.get("timestamp") or []
        ind = res.get("indicators") or {}
        quote = (ind.get("quote") or [{}])[0]
        adj = (ind.get("adjclose") or [{}])
        adjc = adj[0].get("adjclose") if adj and isinstance(adj[0], dict) else None
        vals = adjc if (adjc and len(adjc) == len(stamps)) else (quote.get("close") or [])

        rows = {}
        for ts, v in zip(stamps, vals):
            if v is None:
                continue
            d = datetime.fromtimestamp(ts, tz=timezone.utc) + timedelta(hours=5, minutes=30)
            rows[d.strftime("%Y-%m-%d")] = round(float(v), 4)

        if len(rows) < MIN_BARS:
            err = "only %d bars" % len(rows)
            continue
        dates = sorted(rows)
        return (dates, [rows[d] for d in dates]), None

    return None, err


# ------------------------------------------------- source discovery (Yahoo)
_SEARCH_CACHE = {}
_GOOD_EXCH = ("NSI", "BSE", "BOM")          # NSE / BSE listings
_GOOD_TYPE = ("ETF", "INDEX", "MUTUALFUND", "EQUITY")


def yahoo_search(query, limit=8):
    """Ask Yahoo which symbols actually exist for this name.

    This is what stops the universe from rotting: rather than hard-coding
    tickers I have guessed, the fetcher looks up real ones whenever the
    configured symbols are dead or stale.
    """
    if query in _SEARCH_CACHE:
        return _SEARCH_CACHE[query]
    url = ("https://query2.finance.yahoo.com/v1/finance/search?q="
           + urllib.parse.quote(query)
           + "&quotesCount=%d&newsCount=0&region=IN&lang=en-IN" % limit)
    out = []
    try:
        payload = get_json(url)
        for q in (payload or {}).get("quotes", []):
            sym = q.get("symbol")
            if not sym:
                continue
            if q.get("exchange") not in _GOOD_EXCH:
                continue
            if q.get("quoteType") not in _GOOD_TYPE:
                continue
            rank = _GOOD_TYPE.index(q.get("quoteType"))
            out.append((rank, sym, q.get("shortname") or q.get("longname") or ""))
        out.sort(key=lambda r: r[0])          # index/ETF ahead of single stocks
        out = [(s, n) for _, s, n in out]
    except Exception as e:  # noqa: BLE001
        vlog("search failed for %r: %s" % (query, type(e).__name__))
    _SEARCH_CACHE[query] = out
    return out


def freshness_cutoff(days_back=10):
    return (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")



# ------------------------------ source: rebuild an index from its members
#
# Yahoo stopped updating several ^CNX... index symbols in July 2026 but still
# serves the individual NSE stocks. So an index can be rebuilt from its
# constituents. The problem is the weights: real Nifty indices are free-float
# market-cap weighted with capping rules, and the free-float factors are not
# public here.
#
# For an index that HAS history (the frozen ones) we don't need them. Fit the
# weights against the index's own past daily returns by non-negative least
# squares, then carry those weights forward. Two things fall out of that:
# members that were never really in the index get ~zero weight, so an
# imperfect member list is self-correcting; and the fit quality is measurable,
# so a bad reconstruction announces itself instead of quietly lying.
#
# For an index with NO history there is nothing to fit against. Those fall
# back to equal weights and are flagged as unverified.


def nnls(X, y, iters=300):
    """min ||Xw - y||^2 subject to w >= 0, by coordinate descent."""
    n = len(X[0])
    XtX = [[0.0] * n for _ in range(n)]
    Xty = [0.0] * n
    for row, yv in zip(X, y):
        for a in range(n):
            ra = row[a]
            if ra:
                Xty[a] += ra * yv
                for b in range(a, n):
                    if row[b]:
                        XtX[a][b] += ra * row[b]
    for a in range(n):
        for b in range(a):
            XtX[a][b] = XtX[b][a]

    w = [0.0] * n
    for _ in range(iters):
        delta = 0.0
        for i in range(n):
            d = XtX[i][i]
            if d <= 1e-15:
                w[i] = 0.0
                continue
            acc = Xty[i]
            row = XtX[i]
            for j in range(n):
                if j != i and w[j]:
                    acc -= row[j] * w[j]
            new = max(0.0, acc / d)
            delta = max(delta, abs(new - w[i]))
            w[i] = new
        if delta < 1e-12:
            break
    return w


def _returns_matrix(members, dates):
    """Per-date fractional returns for each member; None where unknown."""
    rets = {}
    for sym, px in members.items():
        col = [None] * len(dates)
        prev = None
        for i, d in enumerate(dates):
            v = px.get(d)
            if v is not None and prev is not None and prev > 0:
                col[i] = v / prev - 1.0
            if v is not None:
                prev = v
        rets[sym] = col
    return rets


def build_composite(tickers, days, anchor=None, label=""):
    """anchor: (dates, closes) of the real index, if we have any of it."""
    members = {}
    for t in tickers:
        got, err = fetch_yahoo(t, days)
        if got:
            members[t] = dict(zip(got[0], got[1]))
            vlog("  member %-16s %d bars to %s" % (t, len(got[0]), got[0][-1]))
        else:
            vlog("  member %-16s unavailable (%s)" % (t, err))
        time.sleep(0.12)

    if len(members) < 3:
        return None, "only %d members downloaded" % len(members)

    all_dates = set()
    for px in members.values():
        all_dates |= set(px)
    dates = sorted(all_dates)
    if len(dates) < 250:
        return None, "only %d dates across members" % len(dates)

    syms = sorted(members)
    rets = _returns_matrix(members, dates)

    weights = None
    fit = None
    if anchor:
        a_px = dict(zip(anchor[0], anchor[1]))
        rows, ys, idxs = [], [], []
        prev = None
        for i, d in enumerate(dates):
            v = a_px.get(d)
            if v is not None and prev is not None and prev > 0:
                row = [rets[s][i] for s in syms]
                if sum(1 for x in row if x is not None) >= max(3, len(syms) * 0.6):
                    rows.append([x if x is not None else 0.0 for x in row])
                    ys.append(v / prev - 1.0)
                    idxs.append(i)
            if v is not None:
                prev = v

        if len(rows) >= 200:
            w = nnls(rows, ys)
            tot = sum(w)
            if tot > 1e-9:
                weights = {s: wi / tot for s, wi in zip(syms, w)}
                # how well do those weights reproduce the index we DO have?
                pred = [sum(r[j] * w[j] for j in range(len(syms))) for r in rows]
                n = len(ys)
                my, mp = sum(ys) / n, sum(pred) / n
                cov = sum((a - my) * (b - mp) for a, b in zip(ys, pred))
                va = sum((a - my) ** 2 for a in ys)
                vb = sum((b - mp) ** 2 for b in pred)
                corr = cov / ((va * vb) ** 0.5) if va > 0 and vb > 0 else 0.0
                resid = sum((a - b) ** 2 for a, b in zip(ys, pred)) / n
                fit = {"days": n, "corr": round(corr, 4),
                       "tracking_error_bps_per_day": round((resid ** 0.5) * 1e4, 1),
                       "top": sorted(((round(v, 4), s) for s, v in weights.items()
                                      if v > 0.01), reverse=True)[:6]}

    if weights is None:
        weights = {s: 1.0 / len(syms) for s in syms}

    def composite_return(i):
        num = den = 0.0
        for s in syms:
            r = rets[s][i]
            if r is None:
                continue
            wv = weights[s]
            num += wv * r
            den += wv
        return (num / den) if den > 1e-9 else None

    # Splice: keep every real index value we have, synthesise only the tail.
    if anchor:
        a_dates, a_closes = anchor
        out_d, out_c = list(a_dates), list(a_closes)
        last = a_dates[-1]
        level = a_closes[-1]
        for i, d in enumerate(dates):
            if d <= last:
                continue
            r = composite_return(i)
            if r is None:
                continue
            level *= (1.0 + r)
            out_d.append(d)
            out_c.append(round(level, 4))
        if len(out_d) == len(a_dates):
            return None, "no member data after the index went stale"
        return (out_d, out_c), {"mode": "spliced", "from": last,
                                "added": len(out_d) - len(a_dates),
                                "members": len(syms), "fit": fit}

    level = 1000.0
    out_d, out_c = [], []
    for i, d in enumerate(dates):
        r = composite_return(i) if i else 0.0
        if r is None:
            continue
        level *= (1.0 + r)
        out_d.append(d)
        out_c.append(round(level, 4))
    if len(out_d) < 250:
        return None, "composite only %d bars" % len(out_d)
    return (out_d, out_c), {"mode": "equal-weight", "members": len(syms), "fit": None}


# ------------------------------------------------------------------ main
def main():
    with open(UNIVERSE_PATH, "r", encoding="utf-8") as f:
        universe = json.load(f)

    days = int(universe.get("history_days", 1200))
    instruments = [i for i in universe["instruments"] if not str(i["id"]).startswith("_")]

    out = {
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": "NSE India historical index API, with Yahoo Finance as fallback",
        "series": {}, "meta": [], "failed": [], "stale": [], "discovered": [],
        "reconstructed": {},
    }

    composites = {}
    log("Fetching %d instruments (~%d days).  NSE=%s  Yahoo=%s\n"
        % (len(instruments), days, "on" if USE_NSE else "off", "on" if USE_YAHOO else "off"))

    for inst in instruments:
        cands = []   # (dates, closes, source_label)

        if USE_NSE and inst.get("nse"):
            vlog("NSE  %s" % inst["nse"])
            got, err = fetch_nse(inst["nse"], days)
            if got:
                cands.append((got[0], got[1], "NSE:" + inst["nse"]))
            else:
                vlog("  -> %s" % err)

        if USE_YAHOO:
            # try every candidate; a symbol that returns data but stopped
            # updating must not win over one that is current
            for sym in inst.get("symbols", []):
                vlog("YF   %s" % sym)
                got, err = fetch_yahoo(sym, days)
                if got:
                    cands.append((got[0], got[1], sym))
                    vlog("  -> ok, last %s" % got[0][-1])
                else:
                    vlog("  -> %s" % err)
                time.sleep(0.2)

        # if nothing configured is current, go and find something that is
        fresh = freshness_cutoff()
        if USE_YAHOO and not any(c[0][-1] >= fresh for c in cands):
            queries = inst.get("search") or [inst["name"], inst["name"] + " ETF"]
            if isinstance(queries, str):
                queries = [queries]
            tried = set(inst.get("symbols", []))
            log("       ...configured sources are stale, searching for a live one")
            for q in queries:
                for sym, label in yahoo_search(q):
                    if sym in tried:
                        continue
                    tried.add(sym)
                    vlog("YF?  %-18s %s" % (sym, label[:44]))
                    got, err = fetch_yahoo(sym, days)
                    if got:
                        cands.append((got[0], got[1], sym))
                        vlog("  -> ok, last %s" % got[0][-1])
                        if got[0][-1] >= fresh:
                            break
                    else:
                        vlog("  -> %s" % err)
                    time.sleep(0.2)
                if any(c[0][-1] >= fresh for c in cands):
                    break

        # ---- last resort: rebuild the index from its constituent stocks
        fresh = freshness_cutoff()
        best_now = max((c[0][-1] for c in cands), default="")
        if inst.get("constituents") and best_now < fresh:
            anchor = None
            if cands:
                cands.sort(key=lambda c: (c[0][-1], len(c[0])), reverse=True)
                anchor = (cands[0][0], cands[0][1])
                log("       ...rebuilding from %d constituents, splicing onto the real"
                    " index after %s" % (len(inst["constituents"]), anchor[0][-1]))
            else:
                log("       ...no index feed at all; building an equal-weight"
                    " basket of %d constituents" % len(inst["constituents"]))
            built, info = build_composite(inst["constituents"], days, anchor, inst["name"])
            if built:
                cands = [(built[0], built[1], "composite")]
                composites[inst["id"]] = info
                if info.get("fit"):
                    f = info["fit"]
                    log("       fit vs the real index: corr %.3f over %d days,"
                        " tracking error %.1f bps/day"
                        % (f["corr"], f["days"], f["tracking_error_bps_per_day"]))
                    vlog("top weights: " + ", ".join("%s %.1f%%" % (sym, w * 100)
                                                     for w, sym in f["top"]))
            else:
                log("       ...reconstruction failed: %s" % info)

        if not cands:
            out["failed"].append({"id": inst["id"], "name": inst["name"],
                                  "tried": ([inst["nse"]] if inst.get("nse") else [])
                                           + inst.get("symbols", [])})
            log("  MISS %-24s nothing available" % inst["name"])
            continue

        # freshest wins; ties broken by more history
        cands.sort(key=lambda c: (c[0][-1], len(c[0])), reverse=True)
        dates, closes, src = cands[0]

        out["series"][inst["id"]] = {"dates": dates, "closes": closes}
        entry = {
            "id": inst["id"], "name": inst["name"], "short": inst.get("short", inst["id"]),
            "sector": bool(inst.get("sector", True)), "benchmark": bool(inst.get("benchmark", False)),
            "symbol": src, "bars": len(closes), "last_date": dates[-1], "last_close": closes[-1],
        }
        if src == "composite":
            info = composites[inst["id"]]
            entry["reconstructed"] = info["mode"]
            entry["members"] = info["members"]
            entry["symbol"] = "rebuilt from %d stocks" % info["members"]
            if info.get("fit"):
                entry["fit_corr"] = info["fit"]["corr"]
                entry["spliced_from"] = info.get("from")
            out["reconstructed"][inst["id"]] = info
        out["meta"].append(entry)
        if (src not in inst.get("symbols", []) and not src.startswith("NSE:")
                and src != "composite"):
            out["discovered"].append({"id": inst["id"], "name": inst["name"], "symbol": src})
        others = ", ".join("%s→%s" % (c[2], c[0][-1]) for c in cands[1:])
        log("  OK   %-24s %-22s %5d bars  last %s%s"
            % (inst["name"], src, len(closes), dates[-1], ("   [also " + others + "]") if others else ""))

    if not out["series"]:
        log("\nNothing downloaded. Check the internet connection and retry.")
        return 1

    # ---- flag anything that has quietly stopped updating
    newest = max(m["last_date"] for m in out["meta"])
    cutoff = (datetime.strptime(newest, "%Y-%m-%d") - timedelta(days=STALE_TOLERANCE_DAYS)).strftime("%Y-%m-%d")
    for m in out["meta"]:
        if m["last_date"] < cutoff:
            m["stale"] = True
            out["stale"].append({"id": m["id"], "name": m["name"],
                                 "symbol": m["symbol"], "last_date": m["last_date"]})

    os.makedirs(OUT_DIR, exist_ok=True)
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, OUT_PATH)

    log("\nWrote %s  (%d instruments, %.0f KB, newest bar %s)"
        % (OUT_PATH, len(out["series"]), os.path.getsize(OUT_PATH) / 1024.0, newest))
    if out["failed"]:
        log("Unavailable : %s" % ", ".join(f["name"] for f in out["failed"]))
    if out["discovered"]:
        log("FOUND BY SEARCH — not in universe.json, please eyeball these once:")
        for d in out["discovered"]:
            log("   %-24s %s" % (d["name"], d["symbol"]))
        log("   If one looks wrong, put the right symbol in universe.json.")
    if out["reconstructed"]:
        log("REBUILT FROM CONSTITUENTS — these are proxies, not the published index:")
        for iid, info in out["reconstructed"].items():
            nm = next(m["name"] for m in out["meta"] if m["id"] == iid)
            if info.get("fit"):
                log("   %-24s %d members, spliced after %s, corr %.3f with the real index"
                    % (nm, info["members"], info.get("from"), info["fit"]["corr"]))
            else:
                log("   %-24s %d members, equal-weight, NO history to check against"
                    % (nm, info["members"]))
    if out["stale"]:
        log("STALE (last update shown) — these are excluded from the chart:")
        for s in out["stale"]:
            log("   %-24s %-22s %s" % (s["name"], s["symbol"], s["last_date"]))
        log("   Fix by adding a working symbol to universe.json, or run with NSE enabled.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

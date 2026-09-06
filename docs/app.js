/* =====================================================================
   Sector Rotation RRG
   ---------------------------------------------------------------------
   Data in  : data/prices.json  { series: { ID: {dates[], closes[]} }, meta[] }
   Data out : an RRG — RS-Ratio (x) vs RS-Momentum (y), both centred on 100.

   The maths, from first principles:
     1. Relative strength      RS  = 100 * sector / benchmark
     2. De-trend it            R1  = 100 * RS / EMA(RS, w)
        (how far RS sits above/below its own recent average — this removes
         the arbitrary level of the ratio and leaves the deviation)
     3. Normalise              RS-Ratio = 100 + z(R1, over Z periods)
        (z-score puts every sector on one comparable scale around 100)
     4. Momentum of that       M1  = 100 * RS-Ratio / EMA(RS-Ratio, w)
     5. Normalise              RS-Momentum = 100 + z(M1, over Z periods)

   Momentum is the rate of change of relative strength, which is why
   sectors trace a clockwise loop: momentum turns before strength does.
   ===================================================================== */

const PARAMS = {
  daily:  { long: 100, short: 12, z: 250, label: 'day'  },
  weekly: { long: 26,  short: 5,  z: 104, label: 'week' }
};

const PALETTE = [
  '#4da3ff','#2fbf71','#e8b93a','#e05561','#a78bfa','#22c9c9','#f0883e',
  '#f472b6','#84cc16','#38bdf8','#fb7185','#c084fc','#14b8a6','#facc15',
  '#60a5fa','#34d399','#fca5a5','#818cf8','#fbbf24','#4ade80','#f87171',
  '#a3e635','#67e8f9'
];

const QUADS = {
  lead: { name:'Leading',   cls:'lead', v:'--lead' },
  weak: { name:'Weakening', cls:'weak', v:'--weak' },
  lag:  { name:'Lagging',   cls:'lag',  v:'--lag'  },
  imp:  { name:'Improving', cls:'imp',  v:'--imp'  }
};

const S = {
  raw: null,
  meta: [],
  colors: {},
  hidden: new Set(),
  benchmark: 'NIFTY50',
  timeframe: 'daily',
  tail: 8,
  idx: 0,            // index into the current timeline
  timeline: [],      // array of date strings
  points: {},        // id -> [{d, ratio, mom}]
  playing: false,
  playTimer: null,
  sort: { key:'ratio', dir:-1 },
  hover: null
};

/* ---------------------------------------------------------------- utils */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmt = (n, d=2) => (n === null || n === undefined || !isFinite(n)) ? '—' : n.toFixed(d);

function ema(arr, n) {
  const k = 2 / (n + 1), out = new Array(arr.length).fill(null);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === null || !isFinite(v)) { out[i] = prev; continue; }
    prev = (prev === null) ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** rolling z-score with a `n`-period window */
function rollingZ(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0, sum2 = 0, count = 0;
  const buf = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === null || !isFinite(v)) { out[i] = null; continue; }
    buf.push(v); sum += v; sum2 += v * v; count++;
    if (count > n) { const old = buf.shift(); sum -= old; sum2 -= old * old; count--; }
    if (count < Math.max(8, Math.round(n * 0.4))) continue;
    const mean = sum / count;
    const varr = Math.max(sum2 / count - mean * mean, 1e-12);
    out[i] = (v - mean) / Math.sqrt(varr);
  }
  return out;
}

/** Cross-sectional dispersion at each date, smoothed over time so the axes
 *  don't breathe from one bar to the next. Returns an array of scale factors. */
function dispersion(map, ids, n, smooth) {
  const raw = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (const id of ids) {
      const v = map[id][i];
      if (v === null || !isFinite(v)) continue;
      s += v * v; c++;
    }
    if (c >= 2) raw[i] = Math.sqrt(s / c);   // RMS around the benchmark (0), not around the mean
  }
  const sm = ema(raw, Math.max(5, Math.round(smooth / 3)));
  // a floor stops a dead-flat stretch from blowing the scale up
  const seen = sm.filter(v => v && isFinite(v));
  const floor = seen.length ? Math.max(1e-9, median(seen) * 0.25) : 1e-9;
  return sm.map(v => (v && isFinite(v)) ? Math.max(v, floor) : null);
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A series we rebuilt from constituent stocks rather than read from a feed.
 *  Marked everywhere it appears — it is a proxy, and the chart should never
 *  let it pass as the published index. */
function isProxy(id) {
  const m = S.meta.find(x => x.id === id);
  return !!(m && m.reconstructed);
}
const proxyMark = id => isProxy(id) ? '~' : '';

function quadrantOf(ratio, mom) {
  if (ratio >= 100) return mom >= 100 ? 'lead' : 'weak';
  return mom >= 100 ? 'imp' : 'lag';
}

/* headings: 0deg = east, measured counter-clockwise in maths, but we report
   compass-style bearing so "clockwise rotation" reads naturally. */
function heading(dx, dy) {
  if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return null;
  let deg = Math.atan2(dy, dx) * 180 / Math.PI;   // -180..180, y up
  deg = (90 - deg + 360) % 360;                   // compass bearing, 0 = north
  return deg;
}
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
const compass = deg => deg === null ? '—' : COMPASS[Math.round(deg / 45) % 8];

/* ------------------------------------------------------- data pipeline */

/** Align a series onto the benchmark's trading calendar.
 *  Holidays and the odd missing print are forward-filled, but only for a few
 *  bars. A series that has quietly stopped updating must NOT be carried
 *  forward as a flat line — against a moving benchmark that reads as steady
 *  out-performance and drags the whole sector into the Leading quadrant. */
const MAX_FILL = 5;

function alignedCloses(id, benchDates) {
  const s = S.raw.series[id];
  if (!s) return null;
  const map = new Map();
  for (let i = 0; i < s.dates.length; i++) map.set(s.dates[i], s.closes[i]);
  const out = new Array(benchDates.length).fill(null);
  let last = null, held = 0, seen = 0;
  for (let i = 0; i < benchDates.length; i++) {
    const v = map.get(benchDates[i]);
    if (v !== undefined) { last = v; held = 0; seen++; }
    else if (last !== null && held < MAX_FILL) held++;
    else { last = null; }
    out[i] = last;
  }
  return seen > 60 ? out : null;
}

/** Series whose last bar is well behind the freshest one in the file. */
function staleIds() {
  const newest = S.meta.reduce((a, m) => m.last_date > a ? m.last_date : a, '');
  const cut = new Date(new Date(newest + 'T00:00:00Z') - 10 * 864e5)
    .toISOString().slice(0, 10);
  return new Set(S.meta.filter(m => m.last_date < cut).map(m => m.id));
}

/** Collapse a daily calendar to weekly (last trading day of each ISO week). */
function toWeekly(dates, seriesMap) {
  const keep = [];
  for (let i = 0; i < dates.length; i++) {
    const isLast = (i === dates.length - 1) || weekKey(dates[i]) !== weekKey(dates[i + 1]);
    if (isLast) keep.push(i);
  }
  const wDates = keep.map(i => dates[i]);
  const out = {};
  for (const id in seriesMap) out[id] = keep.map(i => seriesMap[id][i]);
  return { dates: wDates, series: out };
}
function weekKey(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;          // Mon = 0
  t.setUTCDate(t.getUTCDate() - day + 3);       // Thursday of that week
  return t.getUTCFullYear() + '-' + Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

/** Recompute every sector's RRG track for the current benchmark & timeframe. */
function compute() {
  const bench = S.raw.series[S.benchmark];
  if (!bench) return;

  const benchDates = bench.dates;
  const stale = staleIds();
  S.stale = stale;
  const ids = S.meta.map(m => m.id)
    .filter(id => id !== S.benchmark && S.raw.series[id] && !stale.has(id));

  const aligned = {};
  aligned[S.benchmark] = bench.closes.slice();
  for (const id of ids) {
    const a = alignedCloses(id, benchDates);
    if (a) aligned[id] = a;
  }

  let dates = benchDates, series = aligned;
  if (S.timeframe === 'weekly') {
    const w = toWeekly(benchDates, aligned);
    dates = w.dates; series = w.series;
  }

  const P = PARAMS[S.timeframe];
  const b = series[S.benchmark];
  const ids2 = Object.keys(series).filter(id => id !== S.benchmark);
  const N = dates.length;

  // --- step 1-2: trend deviation of each sector's relative strength
  const dev = {};
  for (const id of ids2) {
    const sec = series[id];
    const lrs = sec.map((v, i) => (v > 0 && b[i] > 0) ? Math.log(v / b[i]) : null);
    const base = ema(lrs, P.long);          // long window: a persistent
    dev[id] = lrs.map((v, i) =>             // out-performer stays right of 100
      (v === null || base[i] === null || i < P.long) ? null : v - base[i]);
  }

  // --- step 3: scale by how widely the sectors are dispersed, so the axes
  //     mean the same thing on a quiet market day and a violent one
  const sRatio = dispersion(dev, ids2, N, P.long);
  const ratio = {};
  for (const id of ids2) {
    ratio[id] = dev[id].map((v, i) => (v === null || !sRatio[i]) ? null : 100 + v / sRatio[i]);
  }

  // --- step 4-5: momentum = short-run change in RS-Ratio, scaled the same way
  const mdev = {};
  for (const id of ids2) {
    const fast = ema(ratio[id], Math.max(2, Math.round(P.short / 3)));
    const slow = ema(ratio[id], P.short);
    mdev[id] = ema(
      ratio[id].map((v, i) => (v === null || slow[i] === null) ? null : fast[i] - slow[i]),
      Math.max(2, Math.round(P.short / 4))
    );
  }
  const sMom = dispersion(mdev, ids2, N, P.long);

  const points = {};
  for (const id of ids2) {
    const sec = series[id];
    const track = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      const r = ratio[id][i], md = mdev[id][i];
      if (r === null || md === null || !sMom[i]) continue;
      track[i] = { d: dates[i], ratio: r, mom: 100 + md / sMom[i], px: sec[i], bx: b[i] };
    }
    points[id] = track;
  }

  S.timeline = dates;
  S.points = points;

  // first index where at least half the sectors have valid values
  let start = 0;
  const list = Object.values(points);
  for (let i = 0; i < dates.length; i++) {
    const ok = list.filter(t => t[i]).length;
    if (ok >= Math.max(2, list.length * 0.5)) { start = i; break; }
  }
  S.firstValid = start;
}

/* ----------------------------------------------------------- rendering */
const cv = $('#rrg');
const ctx = cv.getContext('2d');
let VIEW = null;

function visibleIds() {
  return S.meta
    .filter(m => m.sector && m.id !== S.benchmark && S.points[m.id] && !S.hidden.has(m.id))
    .map(m => m.id);
}

function tailSlice(id) {
  const track = S.points[id];
  if (!track) return [];
  const out = [];
  for (let i = Math.max(0, S.idx - S.tail + 1); i <= S.idx; i++) {
    if (track[i]) out.push(track[i]);
  }
  return out;
}

function draw() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const ids = visibleIds();
  const pad = W > 460 ? { l: 54, r: 18, t: 18, b: 38 } : { l: 38, r: 10, t: 14, b: 24 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;

  // ---- scale: symmetric around 100, framed on what's on screen
  let ext = 1.2;
  for (const id of ids) {
    for (const p of tailSlice(id)) {
      ext = Math.max(ext, Math.abs(p.ratio - 100), Math.abs(p.mom - 100));
    }
  }
  ext *= 1.16;
  const x0 = 100 - ext, x1 = 100 + ext, y0 = 100 - ext, y1 = 100 + ext;
  const X = v => pad.l + (v - x0) / (x1 - x0) * pw;
  const Y = v => pad.t + (1 - (v - y0) / (y1 - y0)) * ph;
  VIEW = { X, Y, pad, pw, ph, ext };

  const cx = X(100), cy = Y(100);
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const fillA = light ? 0.055 : 0.05;

  // ---- quadrant washes
  const paint = (x, y, w, h, c) => { ctx.globalAlpha = fillA; ctx.fillStyle = c; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; };
  paint(cx, pad.t, pad.l + pw - cx, cy - pad.t, css('--lead'));
  paint(pad.l, pad.t, cx - pad.l, cy - pad.t, css('--imp'));
  paint(pad.l, cy, cx - pad.l, pad.t + ph - cy, css('--lag'));
  paint(cx, cy, pad.l + pw - cx, pad.t + ph - cy, css('--weak'));

  // ---- grid
  ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = css('--dim');
  const step = niceStep(ext);
  ctx.setLineDash([3, 4]);
  for (let v = 100 - Math.floor(ext / step) * step; v <= 100 + ext; v += step) {
    if (Math.abs(v - 100) < 1e-9) continue;
    const px = X(v), py = Y(v);
    if (px > pad.l && px < pad.l + pw) {
      ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, pad.t + ph); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(v.toFixed(step < 1 ? 1 : 0), px, pad.t + ph + 7);
    }
    if (py > pad.t && py < pad.t + ph) {
      ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(pad.l + pw, py); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(v.toFixed(step < 1 ? 1 : 0), pad.l - 9, py);
    }
  }
  ctx.setLineDash([]);

  // ---- centre cross
  ctx.strokeStyle = light ? '#c3ccd8' : '#3a4757'; ctx.lineWidth = 1.25;
  ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, pad.t + ph);
  ctx.moveTo(pad.l, cy); ctx.lineTo(pad.l + pw, cy); ctx.stroke();

  // ---- quadrant captions
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.globalAlpha = .8;
  const cap = (txt, x, y, ta, tb, c) => { ctx.fillStyle = c; ctx.textAlign = ta; ctx.textBaseline = tb; ctx.fillText(txt, x, y); };
  cap('LEADING',   pad.l + pw - 10, pad.t + 8,       'right', 'top',    css('--lead'));
  cap('IMPROVING', pad.l + 10,      pad.t + 8,       'left',  'top',    css('--imp'));
  cap('LAGGING',   pad.l + 10,      pad.t + ph - 8,  'left',  'bottom', css('--lag'));
  cap('WEAKENING', pad.l + pw - 10, pad.t + ph - 8,  'right', 'bottom', css('--weak'));
  ctx.globalAlpha = 1;

  // ---- axis titles
  ctx.fillStyle = css('--dim');
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  if (W > 460) {
    ctx.save(); ctx.translate(13, pad.t + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('RS-Momentum', 0, 0); ctx.restore();
    ctx.textBaseline = 'bottom';
    ctx.fillText('RS-Ratio', pad.l + pw / 2, H - 2);
  }

  // ---- tails
  const hoverId = S.hover && S.hover.id;
  const labels = [];
  for (const id of ids) {
    const pts = tailSlice(id);
    if (!pts.length) continue;
    const c = S.colors[id];
    const dim = hoverId && hoverId !== id;
    const n = pts.length;

    for (let i = 1; i < n; i++) {
      const a = pts[i - 1], b2 = pts[i];
      ctx.globalAlpha = (dim ? 0.10 : 1) * (0.18 + 0.82 * (i / (n - 1 || 1)));
      ctx.strokeStyle = c;
      ctx.lineWidth = 1 + 1.6 * (i / (n - 1 || 1));
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(X(a.ratio), Y(a.mom)); ctx.lineTo(X(b2.ratio), Y(b2.mom)); ctx.stroke();
    }
    for (let i = 0; i < n - 1; i++) {
      ctx.globalAlpha = (dim ? 0.10 : 1) * (0.18 + 0.7 * (i / (n - 1 || 1)));
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(X(pts[i].ratio), Y(pts[i].mom), 2, 0, 7); ctx.fill();
    }

    // head
    const h = pts[n - 1];
    const hx = X(h.ratio), hy = Y(h.mom);
    ctx.globalAlpha = dim ? 0.18 : 1;
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(hx, hy, hoverId === id ? 7 : 5.5, 0, 7); ctx.fill();
    ctx.strokeStyle = css('--panel'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(hx, hy, hoverId === id ? 7 : 5.5, 0, 7); ctx.stroke();

    const m = S.meta.find(x => x.id === id);
    labels.push({ text: proxyMark(id) + m.short, x: hx, y: hy, c, dim });
    ctx.globalAlpha = 1;
  }

  // ---- labels, nudged apart so a crowded centre stays readable
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  labels.sort((a, b) => a.y - b.y);
  const placed = [];
  for (const L of labels) {
    const w = ctx.measureText(L.text).width;
    let lx = L.x + 10, ly = L.y, flip = false;
    if (lx + w > pad.l + pw) { lx = L.x - 10 - w; flip = true; }
    let guard = 0;
    while (guard++ < 60 && placed.some(p =>
      Math.abs(p.ly - ly) < 12 && lx < p.lx + p.w + 6 && p.lx < lx + w + 6)) {
      ly += 12;
    }
    if (ly > pad.t + ph - 4) ly = L.y;
    placed.push({ lx, ly, w });

    ctx.globalAlpha = L.dim ? 0.18 : 1;
    if (Math.abs(ly - L.y) > 3) {
      ctx.strokeStyle = L.c; ctx.globalAlpha *= 0.4; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L.x + (flip ? -6 : 6), L.y);
      ctx.lineTo(flip ? lx + w + 2 : lx - 2, ly);
      ctx.stroke();
      ctx.globalAlpha = L.dim ? 0.18 : 1;
    }
    ctx.fillStyle = L.c; ctx.textAlign = 'left';
    ctx.fillText(L.text, lx, ly);
    ctx.globalAlpha = 1;
  }

  // ---- date watermark
  ctx.globalAlpha = .5;
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = css('--dim'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(S.timeline[S.idx] || '', pad.l + pw / 2, pad.t + 6);
  ctx.globalAlpha = 1;
}

function niceStep(ext) {
  const target = ext / 3;
  const pows = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10];
  let best = pows[0];
  for (const p of pows) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  return best;
}

/* ------------------------------------------------------------- legend */
function renderLegend() {
  const el = $('#legend');
  el.innerHTML = '';
  for (const m of S.meta) {
    if (!m.sector || m.id === S.benchmark || !S.points[m.id]) continue;
    const p = S.points[m.id][S.idx];
    const q = p ? quadrantOf(p.ratio, p.mom) : null;
    const row = document.createElement('div');
    row.className = 'lg' + (S.hidden.has(m.id) ? ' off' : '');
    row.innerHTML =
      `<span class="sw" style="background:${S.colors[m.id]}"></span>` +
      `<span class="nm" title="${m.name} · ${m.symbol}${m.reconstructed
          ? ' · proxy rebuilt from ' + m.members + ' stocks'
            + (m.fit_corr ? ', correlation ' + m.fit_corr + ' with the real index' : '')
          : ''}">${m.name}${m.reconstructed ? '<i class="px">~</i>' : ''}</span>` +
      (q ? `<span class="q" style="color:var(${QUADS[q].v})">${QUADS[q].name.slice(0,4).toUpperCase()}</span>` : '');
    row.onclick = () => { S.hidden.has(m.id) ? S.hidden.delete(m.id) : S.hidden.add(m.id); renderAll(); };
    row.onmouseenter = () => { S.hover = { id: m.id }; draw(); };
    row.onmouseleave = () => { S.hover = null; draw(); };
    el.appendChild(row);
  }
}

/* -------------------------------------------------------------- table */
function rowsData() {
  const out = [];
  for (const m of S.meta) {
    if (!m.sector || m.id === S.benchmark || !S.points[m.id]) continue;
    const tr = S.points[m.id];
    const p = tr[S.idx];
    if (!p) continue;
    let prev = null;
    for (let i = S.idx - 1; i >= 0 && i >= S.idx - 5; i--) { if (tr[i]) { prev = tr[i]; break; } }
    const dr = prev ? p.ratio - prev.ratio : null;
    const dm = prev ? p.mom - prev.mom : null;

    // relative performance of the sector vs the benchmark over the tail window
    let rel = null;
    let back = null;
    for (let i = S.idx; i >= 0; i--) { if (tr[i]) { if (back === null) back = i; } }
    const startIdx = Math.max(0, S.idx - S.tail + 1);
    let sp = null;
    for (let i = startIdx; i <= S.idx; i++) { if (tr[i]) { sp = tr[i]; break; } }
    if (sp && sp.px && sp.bx && p.px && p.bx) {
      rel = ((p.px / sp.px) / (p.bx / sp.bx) - 1) * 100;
    }

    out.push({
      id: m.id, name: m.name, short: m.short, color: S.colors[m.id],
      ratio: p.ratio, mom: p.mom, dratio: dr, dmom: dm,
      quad: quadrantOf(p.ratio, p.mom),
      heading: heading(dr, dm), rel
    });
  }
  const k = S.sort.key, dir = S.sort.dir;
  const order = { lead:0, weak:1, lag:2, imp:3 };
  out.sort((a, b) => {
    let av = a[k], bv = b[k];
    if (k === 'name') return dir * a.name.localeCompare(b.name);
    if (k === 'quad') return dir * (order[a.quad] - order[b.quad]);
    if (av === null) av = -1e9; if (bv === null) bv = -1e9;
    return dir * (av - bv);
  });
  return out;
}

function renderTable() {
  const tb = $('#table tbody');
  tb.innerHTML = '';
  $('#relHead').textContent = `last ${S.tail} ${PARAMS[S.timeframe].label}s`;

  for (const r of rowsData()) {
    const tr = document.createElement('tr');
    if (S.hidden.has(r.id)) tr.className = 'off';
    const sign = v => v === null ? '' : (v >= 0 ? 'up' : 'down');
    const pm = (v, d=2) => v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d);
    tr.innerHTML =
      `<td><span class="dot" style="background:${r.color}"></span>${r.name}` +
      `${isProxy(r.id) ? '<i class="px" title="Rebuilt from constituent stocks, not the published index">~</i>' : ''}</td>` +
      `<td><span class="badge ${r.quad}">${QUADS[r.quad].name}</span></td>` +
      `<td class="num">${fmt(r.ratio)}</td>` +
      `<td class="num">${fmt(r.mom)}</td>` +
      `<td class="num ${sign(r.dratio)}">${pm(r.dratio)}</td>` +
      `<td class="num ${sign(r.dmom)}">${pm(r.dmom)}</td>` +
      `<td class="num">${r.heading === null ? '—' : compass(r.heading) + ' ' + Math.round(r.heading) + '°'}</td>` +
      `<td class="num ${sign(r.rel)}">${pm(r.rel, 1)}%</td>`;
    tr.onclick = () => { S.hidden.has(r.id) ? S.hidden.delete(r.id) : S.hidden.add(r.id); renderAll(); };
    tr.onmouseenter = () => { S.hover = { id: r.id }; draw(); };
    tr.onmouseleave = () => { S.hover = null; draw(); };
    tb.appendChild(tr);
  }
}

/* ------------------------------------------------------------ tooltip */
function pickAt(mx, my, radius) {
  if (!VIEW) return null;
  let best = null, bestD = radius * radius;
  for (const id of visibleIds()) {
    const pts = tailSlice(id);
    if (!pts.length) continue;
    const h = pts[pts.length - 1];
    const dx = VIEW.X(h.ratio) - mx, dy = VIEW.Y(h.mom) - my;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = { id, p: h, x: VIEW.X(h.ratio), y: VIEW.Y(h.mom) }; }
  }
  return best;
}

function localXY(e) {
  const r = cv.getBoundingClientRect();
  const src = (e.touches && e.touches[0]) || e;
  return [src.clientX - r.left, src.clientY - r.top];
}

function setHover(best) {
  const changed = (best && best.id) !== (S.hover && S.hover.id);
  S.hover = best;
  showTip(best);
  if (changed) draw();
}

cv.addEventListener('mousemove', e => setHover(pickAt(...localXY(e), 15)));
cv.addEventListener('mouseleave', () => setHover(null));

/* touch: a finger is far less precise than a cursor, so accept a wider hit
   radius and keep the tooltip up until the next tap elsewhere */
cv.addEventListener('touchstart', e => {
  const best = pickAt(...localXY(e), 30);
  setHover(best);
  if (best) e.preventDefault();
}, { passive: false });

function showTip(h) {
  const tip = $('#tip');
  if (!h) { tip.hidden = true; return; }
  const m = S.meta.find(x => x.id === h.id);
  const q = quadrantOf(h.p.ratio, h.p.mom);
  const rows = rowsData().find(r => r.id === h.id) || {};
  tip.innerHTML =
    `<div class="t"><i style="background:${S.colors[h.id]}"></i>${m.name}</div>` +
    `<div class="r"><span>Quadrant</span><b style="color:var(${QUADS[q].v})">${QUADS[q].name}</b></div>` +
    `<div class="r"><span>RS-Ratio</span><b>${fmt(h.p.ratio)}</b></div>` +
    `<div class="r"><span>RS-Mom</span><b>${fmt(h.p.mom)}</b></div>` +
    `<div class="r"><span>Heading</span><b>${rows.heading === null || rows.heading === undefined ? '—' : compass(rows.heading)}</b></div>` +
    `<div class="r"><span>Date</span><b>${h.p.d}</b></div>` +
    (m.reconstructed
      ? `<div class="r px-note">proxy from ${m.members} stocks` +
        (m.fit_corr ? ` · corr ${m.fit_corr}` : '') + `</div>`
      : '');
  tip.hidden = false;
  const wrap = cv.parentElement;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = h.x + 16, y = h.y - th / 2;
  if (x + tw > wrap.clientWidth - 6) x = h.x - tw - 16;
  y = Math.max(6, Math.min(y, wrap.clientHeight - th - 6));
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

/* -------------------------------------------------------------- wiring */
function renderAll() { draw(); renderLegend(); renderTable(); updateScrub(); }

function updateScrub() {
  const sc = $('#scrub');
  sc.min = S.firstValid; sc.max = S.timeline.length - 1; sc.value = S.idx;
  $('#dateLabel').textContent = S.timeline[S.idx] || '—';
}

function setIdx(i) {
  S.idx = Math.max(S.firstValid, Math.min(i, S.timeline.length - 1));
  renderAll();
}

function rebuild(keepEnd = true) {
  compute();
  S.idx = keepEnd ? S.timeline.length - 1 : Math.min(S.idx, S.timeline.length - 1);
  renderAll();
}

function segment(sel, cb) {
  $$(sel + ' button').forEach(b => b.onclick = () => {
    $$(sel + ' button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    cb(b.dataset.v);
  });
}

function play() {
  if (S.playing) return stop();
  S.playing = true; $('#playBtn').textContent = '❚❚';
  if (S.idx >= S.timeline.length - 1) S.idx = Math.max(S.firstValid, S.timeline.length - 60);
  S.playTimer = setInterval(() => {
    if (S.idx >= S.timeline.length - 1) return stop();
    setIdx(S.idx + 1);
  }, 110);
}
function stop() { S.playing = false; clearInterval(S.playTimer); $('#playBtn').textContent = '▶'; }

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms);
}

/* ------------------------------------------------- data provenance panel */
const D_FMT = { day: '2-digit', month: 'short', year: 'numeric' };
const niceDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString(undefined, D_FMT);

/** Two different dates matter and they are easy to confuse:
 *  - the newest MARKET BAR in the file (what the chart is actually about)
 *  - when the download last RAN (which says nothing about how fresh it is)
 *  Both are shown, newest bar first, plus a per-index breakdown on click. */
function renderStamp(data) {
  const newestBar = S.meta.reduce((a, m) => m.last_date > a ? m.last_date : a, '');
  const ran = new Date(data.generated_at);
  const ageDays = Math.floor((Date.now() - new Date(newestBar + 'T00:00:00')) / 864e5);

  const el = $('#stamp');
  el.innerHTML =
    `<b>Prices to ${niceDate(newestBar)}</b>` +
    `<span>fetched ${ran.toLocaleString(undefined,
      { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` +
    `${ageDays > 4 ? ' · ' + ageDays + ' days old' : ''}</span>`;
  el.classList.toggle('warnstamp', ageDays > 4);

  const stale = staleIds();
  const rows = [...S.meta]
    .sort((a, b) => (a.last_date === b.last_date)
      ? a.name.localeCompare(b.name) : (a.last_date < b.last_date ? -1 : 1))
    .map(m => {
      const bad = stale.has(m.id);
      const note = bad ? 'stale — not plotted'
        : m.reconstructed === 'spliced'
          ? `proxy after ${niceDate(m.spliced_from)} · corr ${m.fit_corr}`
        : m.reconstructed
          ? 'proxy, equal-weight, unverified'
        : '';
      return `<tr class="${bad ? 'bad' : m.reconstructed ? 'proxy' : ''}"><td>${m.name}</td>` +
             `<td class="sym">${m.symbol}</td>` +
             `<td class="num">${niceDate(m.last_date)}</td>` +
             `<td class="num">${m.bars}</td>` +
             `<td>${note}</td></tr>`;
    }).join('');
  const missing = (data.failed || []).map(f =>
    `<tr class="bad"><td>${f.name}</td><td class="sym">—</td>` +
    `<td class="num">—</td><td class="num">0</td><td>no source found</td></tr>`).join('');

  $('#sources').innerHTML =
    `<h3>Where every line comes from</h3>
     <p>End-of-day closes, downloaded once and cached. Nothing here is live or
        intraday — re-run the fetcher (or press <b>Refresh data</b>) to move it forward.
        Rows marked <b>proxy</b> are rebuilt from constituent stocks because no feed
        publishes that index any more; where the index has past data the weights are
        fitted against it and the correlation shown is how well they reproduce it.</p>
     <div class="stbl"><table>
       <thead><tr><th>Index</th><th>Source symbol</th><th class="num">Last bar</th>
       <th class="num">Bars</th><th></th></tr></thead>
       <tbody>${rows}${missing}</tbody></table></div>`;

  el.onclick = () => { $('#sources').hidden = !$('#sources').hidden; };
  document.addEventListener('click', e => {
    if (!e.target.closest('#sources') && !e.target.closest('#stamp')) $('#sources').hidden = true;
  });
}

/* ---------------------------------------------------------------- boot */
async function boot() {
  let data;
  try {
    const res = await fetch('data/prices.json?t=' + Date.now());
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="margin:22px;padding:16px 18px;border:1px solid var(--lag);border-radius:12px;color:var(--ink)">
        <b>No price data.</b> Run <code>python fetch_data.py</code> in this folder, and open the page
        through <code>python serve.py</code> rather than double-clicking index.html.
      </div>`);
    return;
  }

  S.raw = data;
  S.meta = data.meta;
  S.meta.forEach((m, i) => S.colors[m.id] = PALETTE[i % PALETTE.length]);

  // benchmark dropdown
  const sel = $('#benchmark');
  sel.innerHTML = '';
  for (const m of S.meta.filter(x => x.benchmark)) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.name;
    sel.appendChild(o);
  }
  if (!S.meta.some(m => m.benchmark && m.id === S.benchmark)) {
    S.benchmark = (S.meta.find(m => m.benchmark) || S.meta[0]).id;
  }
  sel.value = S.benchmark;
  sel.onchange = () => { S.benchmark = sel.value; rebuild(); };

  renderStamp(data);
  const stale = staleIds();
  const plotted = S.meta.filter(m => m.sector && !stale.has(m.id)).length;
  let note = `Relative Rotation Graph — ${plotted} indices, daily closes`;
  const dropped = [
    ...S.meta.filter(m => stale.has(m.id)).map(m => `${m.name} (stopped ${m.last_date})`),
    ...((data.failed || []).map(f => `${f.name} (no source)`))
  ];
  if (dropped.length) {
    note += ` · ${dropped.length} excluded`;
    $('#subtitle').title = 'Excluded: ' + dropped.join(', ');
    document.querySelector('.chartcard').insertAdjacentHTML('afterbegin',
      `<details class="warn">
         <summary>${dropped.length} ${dropped.length > 1 ? 'indices are' : 'index is'} not
           plotted — source${dropped.length > 1 ? 's have' : ' has'} stopped updating</summary>
         <div class="warnbody"><b>${dropped.join(', ')}</b>. A stale price held flat against a
           moving benchmark would read as steady out-performance, so it is dropped rather than
           drawn. Add a working symbol in <code>universe.json</code> and refresh.</div>
       </details>`);
  }
  $('#subtitle').textContent = note;

  segment('#timeframe', v => { S.timeframe = v; rebuild(); });
  segment('#tail', v => { S.tail = +v; renderAll(); });

  $('#scrub').oninput = e => { stop(); setIdx(+e.target.value); };
  $('#playBtn').onclick = play;
  $('#liveBtn').onclick = () => { stop(); setIdx(S.timeline.length - 1); };
  $('#allBtn').onclick = () => { S.hidden.clear(); renderAll(); };
  $('#noneBtn').onclick = () => { S.meta.forEach(m => { if (m.sector && m.id !== S.benchmark) S.hidden.add(m.id); }); renderAll(); };

  $$('#table th').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    S.sort = { key: k, dir: (S.sort.key === k ? -S.sort.dir : (k === 'name' ? 1 : -1)) };
    renderTable();
  });

  $('#themeBtn').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', now);
    try { localStorage.setItem('rrg-theme', now); } catch (e) {}
    draw();
  };
  try {
    const t = localStorage.getItem('rrg-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}

  // 'Refresh data' needs serve.py behind the page. On static hosting
  // (GitHub Pages and friends) there is no such endpoint, so the button is
  // hidden rather than left there to fail.
  const localHost = /^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/
    .test(location.hostname);
  if (!localHost || location.protocol === 'file:') {
    $('#refreshBtn').hidden = true;
  }

  $('#refreshBtn').onclick = async () => {
    const b = $('#refreshBtn'); b.disabled = true; b.textContent = 'Refreshing…';
    try {
      const r = await fetch('api/refresh', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'fetch failed');
      toast('Data refreshed — reloading');
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      toast('Refresh failed. Run python fetch_data.py manually.');
      b.disabled = false; b.textContent = 'Refresh data';
    }
  };

  window.addEventListener('resize', () => draw());
  window.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { stop(); setIdx(S.idx + 1); }
    if (e.key === 'ArrowLeft')  { stop(); setIdx(S.idx - 1); }
    if (e.key === ' ') { e.preventDefault(); play(); }
  });

  rebuild();
}

boot();

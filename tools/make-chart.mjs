// Draw the rebase-cost chart FROM the measurements, so the picture can never drift
// from the numbers. Reads docs/measurements.json (written by `token-cost.mjs --json`)
// and emits a light and a dark SVG.
//
// usage: node tools/token-cost.mjs --json > docs/measurements.json
//        node tools/make-chart.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const data = JSON.parse(readFileSync(join(ROOT, "docs", "measurements.json"), "utf8"));
const tok = (b) => Math.round(b / data.bytesPerToken);

// The row people live in: an open PR whose base moved under it.
const rows = data.results
  .filter((r) => r.scenario === "open PR, base moved")
  .map((r) => ({
    label: r.size.replace(/\s*\(/, "\n(").split("\n")[1].replace(/[()]/g, ""),
    git: tok(r.git.read + r.git.write),
    avcs: tok(r.avcs.read + r.avcs.write),
    gitTrips: r.git.trips,
    avcsTrips: r.avcs.trips,
  }));
if (rows.length !== 3) throw new Error(`expected 3 file sizes, got ${rows.length}`);

const THEMES = {
  light: { surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", grid: "#e6e5e1", git: "#eb6834", avcs: "#2a78d6" },
  dark:  { surface: "#1a1a19", ink: "#ffffff", ink2: "#c3c2b7", grid: "#33322f", git: "#d95926", avcs: "#3987e5" },
};

const W = 820, H = 404;
const PAD = { t: 92, r: 28, b: 88, l: 64 };
const plotW = W - PAD.l - PAD.r;
const plotH = H - PAD.t - PAD.b;
const max = Math.max(...rows.map((r) => r.git)) * 1.12;
const y = (v) => PAD.t + plotH - (v / max) * plotH;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fmt = (n) => n.toLocaleString("en-US");

function svg(theme) {
  const c = THEMES[theme];
  const groupW = plotW / rows.length;
  const barW = 46, gap = 2; // 2px surface gap between adjacent bars
  const ticks = [0, 5000, 10000, 15000];

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Agent tokens to land a change after another PR merged: git grows with file size, AVCS stays flat">
<style>
  .t { font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .title { font-size: 17px; font-weight: 650; fill: ${c.ink}; }
  .sub { font-size: 12.5px; fill: ${c.ink2}; }
  .axis { font-size: 11.5px; fill: ${c.ink2}; }
  .val { font-size: 12px; font-weight: 600; fill: ${c.ink}; }
  .lg { font-size: 12.5px; fill: ${c.ink}; }
  .note { font-size: 11.5px; fill: ${c.ink2}; }
</style>
<rect width="${W}" height="${H}" rx="10" fill="${c.surface}"/>
<g class="t">
<text class="title" x="${PAD.l - 36}" y="34">Someone else's PR merged first. Now land yours.</text>
<text class="sub" x="${PAD.l - 36}" y="55">Agent tokens on the recovery path — rebase, resolve, force-push — measured by running both systems</text>
`;

  // legend (always present for 2 series)
  const lx = PAD.l - 36;
  s += `<rect x="${lx}" y="68" width="10" height="10" rx="2" fill="${c.git}"/>
<text class="lg" x="${lx + 16}" y="77">git</text>
<rect x="${lx + 52}" y="68" width="10" height="10" rx="2" fill="${c.avcs}"/>
<text class="lg" x="${lx + 68}" y="77">AVCS</text>
`;

  // recessive gridlines + y axis
  for (const t of ticks) {
    s += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t)}" y2="${y(t)}" stroke="${c.grid}" stroke-width="1"/>
<text class="axis" x="${PAD.l - 10}" y="${y(t) + 4}" text-anchor="end">${t === 0 ? "0" : `${t / 1000}k`}</text>
`;
  }

  rows.forEach((r, i) => {
    const cx = PAD.l + groupW * i + groupW / 2;
    const gx = cx - barW - gap / 2;
    const ax = cx + gap / 2;
    // 4px rounded data-end, anchored to the baseline
    const bar = (x, v, fill) => {
      const h = Math.max((v / max) * plotH, 2);
      const top = y(v);
      return `<path d="M${x} ${PAD.t + plotH} L${x} ${top + 4} Q${x} ${top} ${x + 4} ${top} L${x + barW - 4} ${top} Q${x + barW} ${top} ${x + barW} ${top + 4} L${x + barW} ${PAD.t + plotH} Z" fill="${fill}"/>`;
    };
    s += bar(gx, r.git, c.git) + bar(ax, r.avcs, c.avcs);
    // direct labels — both series, every group (3 groups × 2 is not "a number on every point")
    s += `<text class="val" x="${gx + barW / 2}" y="${y(r.git) - 8}" text-anchor="middle" fill="${c.ink}">${fmt(r.git)}</text>
<text class="val" x="${ax + barW / 2}" y="${y(r.avcs) - 8}" text-anchor="middle" fill="${c.ink}">${fmt(r.avcs)}</text>
<text class="axis" x="${cx}" y="${PAD.t + plotH + 22}" text-anchor="middle">${esc(r.label)} file</text>
`;
  });

  const last = rows[rows.length - 1];
  const ratio = Math.round(last.git / last.avcs);
  // Kept to ~105 characters a line: at 11.5px this stays inside the plot width.
  const notes = [
    `git's cost follows the size of the FILE — it reads and rewrites the whole thing. AVCS's follows the`,
    `size of the CHANGE: flat ${fmt(rows[0].avcs)} tokens at every size, ${ratio}× less on a ${esc(last.label)} file.`,
    `Round trips: git ${last.gitTrips} vs AVCS ${last.avcsTrips} — and this is ONE cycle, repeated for every PR that merges ahead of yours.`,
  ];
  s += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${PAD.t + plotH}" y2="${PAD.t + plotH}" stroke="${c.grid}" stroke-width="1"/>
${notes.map((n, i) => `<text class="note" x="${PAD.l - 36}" y="${H - 44 + i * 16}">${n}</text>`).join("\n")}
</g></svg>
`;
  return s;
}

for (const theme of ["light", "dark"]) {
  const out = join(ROOT, "docs", `rebase-token-cost-${theme}.svg`);
  writeFileSync(out, svg(theme));
  console.log(`wrote ${out}`);
}

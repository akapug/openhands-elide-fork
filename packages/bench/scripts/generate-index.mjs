import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDir = path.resolve(__dirname, '../results');

function parseMetrics(html) {
  const get = (key) => {
    const re = new RegExp(`<th>${key}<\\/th><td>([^<]+)<\\/td>`);
    const m = html.match(re);
    return m ? m[1] : '';
  };
  const num = (s) => (s ? Number(s) : NaN);
  return {
    mode: get('mode'),
    baseURL: get('baseURL'),
    path: get('path'),
    total: num(get('total')),
    concurrency: num(get('concurrency')),
    wall: num(get('wall')),
    rps: num(get('rps')),
    tps: num(get('tps')),
    ttft_p50: num(get('ttft_p50')),
    ttft_p95: num(get('ttft_p95')),
    ttft_p99: num(get('ttft_p99')),
    dur_p50: num(get('dur_p50')),
    dur_p95: num(get('dur_p95')),
    dur_p99: num(get('dur_p99')),
  };
}

function labelFromFilename(fname) {
  // bench-elide.32x128.html -> {server: 'elide', conc: 32, total: 128}
  const base = path.basename(fname);
  const m = base.match(/^bench-([^.]+)\.(\d+)x(\d+)\.html$/);
  if (!m) return { server: base, conc: NaN, total: NaN };
  return { server: m[1], conc: Number(m[2]), total: Number(m[3]) };
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n) {
  if (Number.isNaN(n)) return '';
  return n.toFixed(2);
}

async function main() {
  const files = (await fs.readdir(resultsDir))
    .filter((f) => f.startsWith('bench-') && f.endsWith('.html'))
    .sort();

  const entries = [];
  for (const f of files) {
    const full = path.join(resultsDir, f);
    const html = await fs.readFile(full, 'utf8');
    const metrics = parseMetrics(html);
    const meta = labelFromFilename(f);
    entries.push({ file: f, ...meta, ...metrics });
  }

  // group by scenario (conc x total)
  const scenarios = new Map();
  for (const e of entries) {
    const key = `${e.concurrency}x${e.total}`;
    if (!scenarios.has(key)) scenarios.set(key, []);
    scenarios.get(key).push(e);
  }

  const scenarioKeys = Array.from(scenarios.keys()).sort((a, b) => {
    const [ac, at] = a.split('x').map(Number);
    const [bc, bt] = b.split('x').map(Number);
    return ac - bc || at - bt;
  });

  let out = '';
  out += '<!doctype html><meta charset="utf-8"/>';
  out += '<title>Bench Comparison Index</title>';
  out += '<style>body{font:14px system-ui,Segoe UI,Arial} table{border-collapse:collapse;margin:12px 0} td,th{border:1px solid #ddd;padding:6px} h2{margin-top:20px} .sub{color:#666;font-size:12px}</style>';
  out += '<h2>Bench Comparison: Elide (inproc fanout) vs Express/FastAPI (HTTP fanout)</h2>';
  out += '<div class="sub">Auto-generated from bench-*.html in this folder. Metrics are from each report: rps, ttft_p50/p95/p99, dur_p95. Click filename to open the full report.</div>';

  for (const key of scenarioKeys) {
    const rows = scenarios.get(key);
    // order: elide, express, fastapi
    rows.sort((a, b) => {
      const pri = { elide: 0, express: 1, fastapi: 2 };
      const pa = pri[a.server] ?? 9;
      const pb = pri[b.server] ?? 9;
      return pa - pb;
    });
    out += `<h3>Scenario ${htmlEscape(key)}</h3>`;
    out += '<table><thead><tr>' +
           '<th>server</th><th>file</th><th>rps</th><th>ttft_p50</th><th>ttft_p95</th><th>ttft_p99</th><th>dur_p95</th>' +
           '</tr></thead><tbody>';
    for (const r of rows) {
      out += '<tr>' +
        `<td>${htmlEscape(r.server)}</td>` +
        `<td><a href="${encodeURI(r.file)}">${htmlEscape(r.file)}</a></td>` +
        `<td>${fmt(r.rps)}</td>` +
        `<td>${fmt(r.ttft_p50)}</td>` +
        `<td>${fmt(r.ttft_p95)}</td>` +
        `<td>${fmt(r.ttft_p99)}</td>` +
        `<td>${fmt(r.dur_p95)}</td>` +
        '</tr>';
    }
    out += '</tbody></table>';
  }

  const outPath = path.join(resultsDir, 'index.html');
  await fs.writeFile(outPath, out);
  console.log('Wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


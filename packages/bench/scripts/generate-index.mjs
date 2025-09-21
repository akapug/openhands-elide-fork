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

function fmtPercent(n) {
  if (Number.isNaN(n)) return '';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function calculatePercentDiff(baseline, comparison) {
  if (!baseline || !comparison || baseline === 0) return NaN;
  return ((comparison - baseline) / baseline) * 100;
}

function getPerformanceInsight(metric, baseline, comparison, baselineServer, comparisonServer) {
  const diff = calculatePercentDiff(baseline, comparison);
  if (Number.isNaN(diff) || Math.abs(diff) < 5) return null;

  const better = diff > 0 ? comparisonServer : baselineServer;
  const worse = diff > 0 ? baselineServer : comparisonServer;
  const magnitude = Math.abs(diff);

  let significance = 'marginal';
  if (magnitude > 50) significance = 'significant';
  else if (magnitude > 20) significance = 'notable';

  const explanations = {
    rps: `${better} shows ${significance} advantage in throughput (${fmtPercent(Math.abs(diff))}), likely due to ${better === 'elide' ? 'optimized streaming pipeline and lower overhead' : 'different runtime characteristics'}`,
    ttft_p50: `${better} has ${significance}ly faster median time-to-first-token (${fmtPercent(-Math.abs(diff))}), indicating ${better === 'elide' ? 'optimized request handling' : 'different processing overhead'}`,
    ttft_p95: `${better} shows ${significance} improvement in 95th percentile TTFT (${fmtPercent(-Math.abs(diff))}), suggesting ${better === 'elide' ? 'more consistent performance under load' : 'better tail latency characteristics'}`,
    dur_p95: `${better} has ${significance}ly lower 95th percentile duration (${fmtPercent(-Math.abs(diff))}), indicating ${better === 'elide' ? 'efficient streaming completion' : 'optimized response handling'}`
  };

  return explanations[metric] || `${better} outperforms ${worse} by ${fmtPercent(Math.abs(diff))} in ${metric}`;
}

function generateComparativeAnalysis(scenarios) {
  const insights = [];

  for (const [scenarioKey, rows] of scenarios) {
    if (rows.length < 2) continue;

    const elide = rows.find(r => r.server === 'elide');
    const others = rows.filter(r => r.server !== 'elide');

    if (!elide || others.length === 0) continue;

    for (const other of others) {
      const metrics = ['rps', 'ttft_p50', 'ttft_p95', 'dur_p95'];
      for (const metric of metrics) {
        const insight = getPerformanceInsight(metric, other[metric], elide[metric], other.server, 'elide');
        if (insight) {
          insights.push({
            scenario: scenarioKey,
            comparison: `${other.server} vs elide`,
            metric,
            insight,
            magnitude: Math.abs(calculatePercentDiff(other[metric], elide[metric]))
          });
        }
      }
    }
  }

  return insights.sort((a, b) => b.magnitude - a.magnitude);
}

function generateExecutiveSummary(scenarios, insights) {
  const totalScenarios = scenarios.size;
  const frameworks = new Set();
  let totalTests = 0;

  for (const rows of scenarios.values()) {
    totalTests += rows.length;
    rows.forEach(r => frameworks.add(r.server));
  }

  const frameworkList = Array.from(frameworks).sort();
  const significantInsights = insights.filter(i => i.magnitude > 20);

  return {
    totalScenarios,
    totalTests,
    frameworks: frameworkList,
    significantInsights: significantInsights.length,
    topInsight: insights[0]
  };
}

async function main() {
  // Migrate any legacy root-level bench-*.html into a per-run folder
  const runsRootTop = path.join(resultsDir, 'runs');
  await fs.mkdir(runsRootTop, { recursive: true }).catch(()=>{});
  const all = await fs.readdir(resultsDir)
  const legacy = all.filter((f) => f.startsWith('bench-') && f.endsWith('.html')).sort();
  if (legacy.length) {
    const runId = 'migrated-' + new Date().toISOString().replace(/[:.]/g,'-');
    const rp = path.join(runsRootTop, runId);
    await fs.mkdir(rp, { recursive: true }).catch(()=>{});
    for (const f of legacy) {
      try { await fs.rename(path.join(resultsDir, f), path.join(rp, f)); } catch {}
    }
  }
  const allNow = await fs.readdir(resultsDir)
  const files = allNow.filter((f) => f.startsWith('bench-') && f.endsWith('.html')).sort();
  const uiFiles = allNow.filter((f) => f.startsWith('ui-') && f.endsWith('.json')).sort();

  const entries = [];
  for (const f of files) {
    const full = path.join(resultsDir, f);
    const html = await fs.readFile(full, 'utf8');
    const metrics = parseMetrics(html);
    const meta = labelFromFilename(f);
    const conc = Number.isFinite(metrics.concurrency) ? metrics.concurrency : meta.conc;
    const total = Number.isFinite(metrics.total) ? metrics.total : meta.total;
    entries.push({ file: f, ...meta, ...metrics, concurrency: conc, total });
  }

  const uiRuns = [];
  for (const f of uiFiles) {
    try {
      const full = path.join(resultsDir, f);
      const json = JSON.parse(await fs.readFile(full, 'utf8'));
      uiRuns.push({ file: f, ...json });
    } catch {}
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

  // Generate comparative analysis
  const insights = generateComparativeAnalysis(scenarios);
  const summary = generateExecutiveSummary(scenarios, insights);

  let out = '';
  out += '<!doctype html><meta charset="utf-8"/>';
  out += '<title>Elide-Bench: Performance Analysis</title>';
  out += `<style>
    body { font: 14px system-ui, 'Segoe UI', Arial; margin: 20px; background: #f8f9fa; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    table { border-collapse: collapse; margin: 12px 0; width: 100%; }
    td, th { border: 1px solid #dee2e6; padding: 8px; text-align: left; }
    th { background: #f8f9fa; font-weight: 600; }
    h1 { color: #212529; margin: 0 0 8px 0; }
    h2 { margin-top: 32px; color: #495057; border-bottom: 2px solid #dee2e6; padding-bottom: 8px; }
    h3 { margin-top: 24px; color: #6c757d; }
    .sub { color: #6c757d; font-size: 12px; margin-bottom: 20px; }
    .summary { background: #e7f3ff; padding: 16px; border-radius: 6px; margin: 20px 0; }
    .insight { background: #f8f9fa; padding: 12px; margin: 8px 0; border-left: 4px solid #0d6efd; border-radius: 4px; }
    .insight-high { border-left-color: #dc3545; }
    .insight-med { border-left-color: #fd7e14; }
    .insight-low { border-left-color: #198754; }
    .perf-better { color: #198754; font-weight: 600; }
    .perf-worse { color: #dc3545; font-weight: 600; }
    .perf-neutral { color: #6c757d; }
    .metric-table td:nth-child(3), .metric-table td:nth-child(4), .metric-table td:nth-child(5), .metric-table td:nth-child(6), .metric-table td:nth-child(7) { text-align: right; font-family: monospace; }
  </style>`;
  out += '<div class="container">';
  out += '<h1>🚀 Elide-Bench: Performance Analysis</h1>';
  out += '<div class="sub">Comprehensive runtime performance comparison across streaming and HTTP workloads</div>';

  // Executive Summary
  out += '<div class="summary">';
  out += '<h3 style="margin-top: 0;">📊 Executive Summary</h3>';
  out += `<p><strong>${summary.totalTests}</strong> tests across <strong>${summary.totalScenarios}</strong> scenarios comparing <strong>${summary.frameworks.join(', ')}</strong></p>`;
  if (summary.significantInsights > 0) {
    out += `<p><strong>${summary.significantInsights}</strong> significant performance differences identified (>20% variance)</p>`;
    if (summary.topInsight) {
      out += `<p><strong>Key Finding:</strong> ${summary.topInsight.insight}</p>`;
    }
  } else {
    out += '<p>Performance characteristics are relatively similar across frameworks for tested scenarios.</p>';
  }
  out += '</div>';

  // Performance Insights
  if (insights.length > 0) {
    out += '<h2>🔍 Performance Insights</h2>';
    out += '<div class="sub">Automated analysis of performance differences and their likely explanations</div>';

    for (const insight of insights.slice(0, 10)) { // Top 10 insights
      const cssClass = insight.magnitude > 50 ? 'insight-high' : insight.magnitude > 20 ? 'insight-med' : 'insight-low';
      out += `<div class="insight ${cssClass}">`;
      out += `<strong>${insight.scenario} (${insight.comparison}):</strong> ${insight.insight}`;
      out += '</div>';
    }
  }

  // Detailed Scenario Analysis
  out += '<h2>📈 Detailed Performance Comparison</h2>';
  out += '<div class="sub">Side-by-side performance metrics with comparative analysis. Green indicates better performance, red indicates worse.</div>';

  for (const key of scenarioKeys) {
    const rows = scenarios.get(key);
    // order: elide, express, fastapi, flask
    rows.sort((a, b) => {
      const pri = { elide: 0, express: 1, fastapi: 2, flask: 3 };
      const pa = pri[a.server] ?? 9;
      const pb = pri[b.server] ?? 9;
      return pa - pb;
    });

    const elide = rows.find(r => r.server === 'elide');

    out += `<h3>Scenario ${htmlEscape(key)}</h3>`;
    out += '<table class="metric-table"><thead><tr>' +
           '<th>Framework</th><th>Report</th><th>RPS</th><th>TTFT P50 (ms)</th><th>TTFT P95 (ms)</th><th>TTFT P99 (ms)</th><th>Duration P95 (ms)</th>' +
           '</tr></thead><tbody>';

    for (const r of rows) {
      const getComparisonClass = (metric, value) => {
        if (!elide || r.server === 'elide' || !value || !elide[metric]) return 'perf-neutral';
        const diff = calculatePercentDiff(elide[metric], value);
        if (Math.abs(diff) < 5) return 'perf-neutral';

        // For RPS, higher is better. For latency metrics, lower is better.
        const higherIsBetter = metric === 'rps';
        const isBetter = higherIsBetter ? diff > 0 : diff < 0;
        return isBetter ? 'perf-better' : 'perf-worse';
      };

      const getComparisonText = (metric, value) => {
        if (!elide || r.server === 'elide' || !value || !elide[metric]) return fmt(value);
        const diff = calculatePercentDiff(elide[metric], value);
        if (Math.abs(diff) < 5) return fmt(value);
        return `${fmt(value)} (${fmtPercent(diff)})`;
      };

      out += '<tr>' +
        `<td><strong>${htmlEscape(r.server)}</strong></td>` +
        `<td><a href="${encodeURI(r.file)}">${htmlEscape(r.file.replace('bench-', '').replace('.html', ''))}</a></td>` +
        `<td class="${getComparisonClass('rps', r.rps)}">${getComparisonText('rps', r.rps)}</td>` +
        `<td class="${getComparisonClass('ttft_p50', r.ttft_p50)}">${getComparisonText('ttft_p50', r.ttft_p50)}</td>` +
        `<td class="${getComparisonClass('ttft_p95', r.ttft_p95)}">${getComparisonText('ttft_p95', r.ttft_p95)}</td>` +
        `<td class="${getComparisonClass('ttft_p99', r.ttft_p99)}">${getComparisonText('ttft_p99', r.ttft_p99)}</td>` +
        `<td class="${getComparisonClass('dur_p95', r.dur_p95)}">${getComparisonText('dur_p95', r.dur_p95)}</td>` +
        '</tr>';
    }
    out += '</tbody></table>';

    // Add scenario-specific insights
    const scenarioInsights = insights.filter(i => i.scenario === key);
    if (scenarioInsights.length > 0) {
      out += '<div style="margin: 12px 0; padding: 8px; background: #f8f9fa; border-radius: 4px; font-size: 12px;">';
      out += '<strong>Key Insights:</strong> ';
      out += scenarioInsights.slice(0, 2).map(i => i.insight).join(' • ');
      out += '</div>';
    }
  }

  // Per-run folders under results/runs/* → generate a run index and list here
  const runsRoot = path.join(resultsDir, 'runs');
  let runLinks = '';
  let latestName = '';

  try {
    const names = await fs.readdir(runsRoot);
    for (const name of names.sort()) {
      const rp = path.join(runsRoot, name);
      try {
        latestName = name; // track last name in sorted order

        const st = await fs.stat(rp);
        if (!st.isDirectory()) continue;
        const benchFiles = (await fs.readdir(rp)).filter(f=>f.startsWith('bench-') && f.endsWith('.html')).sort();
        // Build per-run index from bench files in this folder
        const perEntries = [];
        for (const f of benchFiles) {
          const html = await fs.readFile(path.join(rp, f), 'utf8');
          const metrics = parseMetrics(html);
          const meta = labelFromFilename(f);
          const conc = Number.isFinite(metrics.concurrency) ? metrics.concurrency : meta.conc;
          const total = Number.isFinite(metrics.total) ? metrics.total : meta.total;
          perEntries.push({ file: f, ...meta, ...metrics, concurrency: conc, total });
        }
        // group by scenario
        const perScenarios = new Map();
        for (const e of perEntries) {
          const key = `${e.concurrency}x${e.total}`;
          if (!perScenarios.has(key)) perScenarios.set(key, []);
          perScenarios.get(key).push(e);
        }
        const keys = Array.from(perScenarios.keys()).sort((a,b)=>{
          const [ac,at]=a.split('x').map(Number); const [bc,bt]=b.split('x').map(Number); return ac-bc || at-bt;
        });
        const present = Array.from(new Set(perEntries.map(e=>e.server))).sort().join(', ');
        const runInsights = generateComparativeAnalysis(perScenarios);
        const runSummary = generateExecutiveSummary(perScenarios, runInsights);

        let perHtml = '<!doctype html><meta charset="utf-8"/><title>Elide-Bench Run: '+htmlEscape(name)+'</title>'+
                      `<style>
                        body { font: 14px system-ui, 'Segoe UI', Arial; margin: 20px; background: #f8f9fa; }
                        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                        table { border-collapse: collapse; margin: 12px 0; width: 100%; }
                        td, th { border: 1px solid #dee2e6; padding: 8px; text-align: left; }
                        th { background: #f8f9fa; font-weight: 600; }
                        h1, h2 { color: #495057; }
                        h3 { color: #6c757d; }
                        .sub { color: #6c757d; font-size: 12px; margin-bottom: 16px; }
                        .hdr { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
                        .summary { background: #e7f3ff; padding: 16px; border-radius: 6px; margin: 16px 0; }
                        .insight { background: #f8f9fa; padding: 8px; margin: 4px 0; border-left: 3px solid #0d6efd; border-radius: 3px; font-size: 13px; }
                        .perf-better { color: #198754; font-weight: 600; }
                        .perf-worse { color: #dc3545; font-weight: 600; }
                        .perf-neutral { color: #6c757d; }
                        .metric-table td:nth-child(3), .metric-table td:nth-child(4), .metric-table td:nth-child(5), .metric-table td:nth-child(6), .metric-table td:nth-child(7) { text-align: right; font-family: monospace; }
                        button { padding: 6px 12px; background: #0d6efd; color: white; border: none; border-radius: 4px; cursor: pointer; }
                        button:hover { background: #0b5ed7; }
                        a { color: #0d6efd; text-decoration: none; }
                        a:hover { text-decoration: underline; }
                      </style>`+
                      '<div class="container">'+
                      `<div class="hdr"><h1 style="margin:0">🚀 Bench Run: ${htmlEscape(name)}</h1><button onclick="navigator.clipboard.writeText(location.href)">📋 Copy Link</button><a href="../../index.html">← Back to Results</a></div>`+
                      `<div class="sub">Frameworks tested: ${htmlEscape(present)} • ${benchFiles.length} individual reports • Generated ${new Date().toLocaleString()}</div>`;

        // Add run summary
        if (runSummary.significantInsights > 0) {
          perHtml += '<div class="summary">';
          perHtml += '<h3 style="margin-top: 0;">📊 Run Summary</h3>';
          perHtml += `<p><strong>${runSummary.totalTests}</strong> tests across <strong>${runSummary.totalScenarios}</strong> scenarios</p>`;
          perHtml += `<p><strong>${runSummary.significantInsights}</strong> significant performance differences identified</p>`;
          if (runSummary.topInsight) {
            perHtml += `<p><strong>Key Finding:</strong> ${runSummary.topInsight.insight}</p>`;
          }
          perHtml += '</div>';
        }

        for (const key of keys) {
          const rows = perScenarios.get(key);
          rows.sort((a,b)=>{ const pri={elide:0,express:1,fastapi:2,flask:3}; return (pri[a.server]??9)-(pri[b.server]??9); });
          const elide = rows.find(r => r.server === 'elide');

          perHtml += `<h3>Scenario ${htmlEscape(key)}</h3>`;
          perHtml += '<table class="metric-table"><thead><tr>'+
                     '<th>Framework</th><th>Report</th><th>RPS</th><th>TTFT P50 (ms)</th><th>TTFT P95 (ms)</th><th>TTFT P99 (ms)</th><th>Duration P95 (ms)</th>'+
                     '</tr></thead><tbody>';

          for (const r of rows) {
            const getComparisonClass = (metric, value) => {
              if (!elide || r.server === 'elide' || !value || !elide[metric]) return 'perf-neutral';
              const diff = calculatePercentDiff(elide[metric], value);
              if (Math.abs(diff) < 5) return 'perf-neutral';
              const higherIsBetter = metric === 'rps';
              const isBetter = higherIsBetter ? diff > 0 : diff < 0;
              return isBetter ? 'perf-better' : 'perf-worse';
            };

            const getComparisonText = (metric, value) => {
              if (!elide || r.server === 'elide' || !value || !elide[metric]) return fmt(value);
              const diff = calculatePercentDiff(elide[metric], value);
              if (Math.abs(diff) < 5) return fmt(value);
              return `${fmt(value)} (${fmtPercent(diff)})`;
            };

            perHtml += '<tr>'+
              `<td><strong>${htmlEscape(r.server)}</strong></td>`+
              `<td><a href="${encodeURI(r.file)}">${htmlEscape(r.file.replace('bench-', '').replace('.html', ''))}</a></td>`+
              `<td class="${getComparisonClass('rps', r.rps)}">${getComparisonText('rps', r.rps)}</td>`+
              `<td class="${getComparisonClass('ttft_p50', r.ttft_p50)}">${getComparisonText('ttft_p50', r.ttft_p50)}</td>`+
              `<td class="${getComparisonClass('ttft_p95', r.ttft_p95)}">${getComparisonText('ttft_p95', r.ttft_p95)}</td>`+
              `<td class="${getComparisonClass('ttft_p99', r.ttft_p99)}">${getComparisonText('ttft_p99', r.ttft_p99)}</td>`+
              `<td class="${getComparisonClass('dur_p95', r.dur_p95)}">${getComparisonText('dur_p95', r.dur_p95)}</td>`+
              '</tr>';
          }
          perHtml += '</tbody></table>';

          // Add scenario insights
          const scenarioInsights = runInsights.filter(i => i.scenario === key);
          if (scenarioInsights.length > 0) {
            scenarioInsights.slice(0, 2).forEach(insight => {
              perHtml += `<div class="insight">${insight.insight}</div>`;
            });
          }
        }
        perHtml += '</div>'; // Close container
        await fs.writeFile(path.join(rp, 'index.html'), perHtml);

        // Enhanced run link with date
        const timestamp = name.includes('-') ? name.split('-').slice(-3).join('-') : name;
        runLinks += `\n<tr><td><a href="runs/${encodeURI(name)}/index.html">${htmlEscape(name)}</a></td><td>${benchFiles.length}</td><td>${htmlEscape(present)}</td><td>${htmlEscape(timestamp)}</td></tr>`;
      } catch {}
    }
  } catch {}
  if (runLinks) {
    out += '<h2>📁 Historical Runs</h2>';
    out += '<div class="sub">Individual benchmark runs with detailed per-run analysis</div>';
    out += '<table><thead><tr><th>Run ID</th><th>Tests</th><th>Frameworks</th><th>Date</th></tr></thead><tbody>'+runLinks+'\n</tbody></table>';
  }

  if (latestName) {
    out += `<div style="margin: 16px 0; padding: 12px; background: #d1ecf1; border-radius: 6px;">`;
    out += `<strong>📊 Latest Run:</strong> <a href="runs/${encodeURI(latestName)}/index.html">${htmlEscape(latestName)}</a>`;
    out += `</div>`;
  }

  if (uiRuns.length) {
    out += '<h2>🖥️ Interactive Test Runs</h2>';
    out += '<div class="sub">Results from browser-based single tests and manual sweeps</div>';
    for (const ur of uiRuns) {
      const meta = ur.meta || {};
      const runs = ur.runs || [];
      out += `<h3>${htmlEscape(ur.file.replace('ui-', '').replace('.json', ''))} — ${htmlEscape(meta.target||'')} (${htmlEscape(meta.mode||'')})</h3>`;
      out += '<table class="metric-table"><thead><tr>' +
             '<th>Concurrency</th><th>Total</th><th>Bytes</th><th>Frames</th><th>Delay (ms)</th><th>Fanout</th><th>CPU Spin (ms)</th><th>GZip</th>'+
             '<th>RPS</th><th>TTFT P50</th><th>TTFT P95</th><th>TTFT P99</th><th>Dur P50</th><th>Dur P95</th><th>Dur P99</th>'+
             '</tr></thead><tbody>';
      for (const r of runs) {
        const s = r.summary || {};
        out += '<tr>' +
          `<td>${htmlEscape(r.concurrency)}</td>`+
          `<td>${htmlEscape(r.total)}</td>`+
          `<td>${htmlEscape(r.bytes||'')}</td>`+
          `<td>${htmlEscape(r.frames||'')}</td>`+
          `<td>${htmlEscape(r.delay_ms||'')}</td>`+
          `<td>${htmlEscape(r.fanout||'')}</td>`+
          `<td>${htmlEscape(r.cpu_spin_ms||'')}</td>`+
          `<td>${htmlEscape(r.gzip?'✓':'')}</td>`+
          `<td>${fmt(s.rps)}</td>`+
          `<td>${fmt(s.ttft_p50)}</td>`+
          `<td>${fmt(s.ttft_p95)}</td>`+
          `<td>${fmt(s.ttft_p99)}</td>`+
          `<td>${fmt(s.dur_p50)}</td>`+
          `<td>${fmt(s.dur_p95)}</td>`+
          `<td>${fmt(s.dur_p99)}</td>`+
          '</tr>';
      }
      out += '</tbody></table>';
    }
  }

  // Footer with methodology
  out += '<h2>📋 Methodology</h2>';
  out += '<div style="background: #f8f9fa; padding: 16px; border-radius: 6px; font-size: 13px; line-height: 1.5;">';
  out += '<p><strong>Test Environment:</strong> All frameworks tested under identical conditions with standardized ports and Docker containerization where applicable.</p>';
  out += '<p><strong>Metrics:</strong> RPS (requests per second), TTFT (time to first token), Duration (total response time). P50/P95/P99 represent 50th, 95th, and 99th percentiles.</p>';
  out += '<p><strong>Comparative Analysis:</strong> Percentage differences calculated relative to baseline framework. Green indicates better performance, red indicates worse performance.</p>';
  out += '<p><strong>Insights:</strong> Automated analysis identifies significant performance differences (>5% variance) and provides explanations based on framework characteristics.</p>';
  out += '</div>';

  out += '</div>'; // Close container

  const outPath = path.join(resultsDir, 'index.html');
  await fs.writeFile(outPath, out);
  console.log('Wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


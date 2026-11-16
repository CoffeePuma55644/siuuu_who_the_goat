// Agrège un CSV de mesures : bun bench/aggregate.ts [fichier.csv]
// Sorties dans bench/results/ : summary.md (tableau lisible), summary.csv, coords.tex (courbes pgfplots)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = "bench/results";
const file =
  process.argv[2] ??
  `${dir}/` + readdirSync(dir).filter((f) => /^results_.*\.csv$/.test(f)).sort().at(-1);
const [head, ...lines] = readFileSync(file, "utf8").trim().split("\n");
const cols = head!.split(",");
const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i]!, v])));

const num = (r: Record<string, string>, k: string) => Number(r[k]);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));

const keys = [...new Set(rows.map((r) => `${r.scenario}|${r.vus}|${r.tech}`))];
const METRICS = ["rps", "p50_ms", "p95_ms", "p99_ms", "cpu_pct_mean", "mem_mib_max", "http_failed_rate"] as const;

type Agg = { scenario: string; vus: number; tech: string; n: number } & Record<string, number>;
const aggs: Agg[] = keys.map((k) => {
  const [scenario, vus, tech] = k.split("|") as [string, string, string];
  const g = rows.filter((r) => r.scenario === scenario && r.vus === vus && r.tech === tech);
  const o: any = { scenario, vus: Number(vus), tech, n: g.length };
  for (const m of METRICS) {
    const v = g.map((r) => num(r, m)).filter(Number.isFinite);
    o[m] = v.length ? mean(v) : NaN;
    o[m + "_sd"] = v.length ? sd(v) : NaN;
  }
  return o;
});
aggs.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.vus - b.vus || a.tech.localeCompare(b.tech));

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");
let md = `# Synthèse (${file}, moyenne ± écart-type sur n essais)\n`;
for (const sc of [...new Set(aggs.map((a) => a.scenario))]) {
  for (const v of [...new Set(aggs.filter((a) => a.scenario === sc).map((a) => a.vus))]) {
    md += `\n## ${sc}, ${v} utilisateurs simultanés\n\n| Techno | n | RPS | P50 (ms) | P95 (ms) | P99 (ms) | CPU moy. (%) | RAM max (MiB) | Erreurs |\n|---|---|---|---|---|---|---|---|---|\n`;
    for (const a of aggs.filter((x) => x.scenario === sc && x.vus === v)) {
      md += `| ${a.tech} | ${a.n} | ${f(a.rps, 0)} ± ${f(a.rps_sd, 0)} | ${f(a.p50_ms, 2)} | ${f(a.p95_ms, 2)} | ${f(a.p99_ms, 2)} | ${f(a.cpu_pct_mean, 0)} | ${f(a.mem_mib_max, 0)} | ${f(a.http_failed_rate * 100, 2)} % |\n`;
    }
  }
}
writeFileSync(`${dir}/summary.md`, md);

writeFileSync(
  `${dir}/summary.csv`,
  "scenario,vus,tech,n," + METRICS.flatMap((m) => [m, m + "_sd"]).join(",") + "\n" +
    aggs.map((a) => [a.scenario, a.vus, a.tech, a.n, ...METRICS.flatMap((m) => [a[m], a[(m + "_sd") as string]])].join(",")).join("\n") + "\n",
);

// Coordonnées pgfplots : RPS et P99 selon la charge, par techno (premier scénario)
const sc0 = aggs[0]!.scenario;
let tex = `% scénario : ${sc0}\n`;
for (const metric of ["rps", "p99_ms"] as const) {
  tex += `% ${metric}\n`;
  for (const t of [...new Set(aggs.map((a) => a.tech))]) {
    const pts = aggs.filter((a) => a.scenario === sc0 && a.tech === t).map((a) => `(${a.vus},${f(a[metric], 2)})`).join(" ");
    tex += `\\addplot coordinates {${pts}}; \\addlegendentry{${t}}\n`;
  }
}
writeFileSync(`${dir}/coords.tex`, tex);
console.log(md);
console.log(`Écrit : ${dir}/summary.md, summary.csv, coords.tex`);

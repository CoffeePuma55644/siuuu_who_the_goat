// Banc d'essai : bun bench/run.ts <build|smoke|run> [options]
// Chaque mesure = un conteneur Docker neuf (base SQLite fraîche, 1000 tâches),
// limité en CPU/RAM, + warm-up, + k6 lancé depuis l'hôte.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runSmoke } from "./smoke.ts";

const TECHS: Record<string, { dir: string; port: number }> = {
  elysia: { dir: "apps/elysiajs", port: 18081 },
  hono: { dir: "apps/hono", port: 18082 },
  rust: { dir: "apps/rust", port: 18083 },
  go: { dir: "apps/go", port: 18084 },
};
const NAME = "bench-run";

const [cmd = "help", ...rest] = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = rest.indexOf(`--${k}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : d;
};
const techs = opt("techs", "elysia,hono,rust,go").split(",");
const scenarios = opt("scenarios", "mixed").split(",");
const levels = opt("levels", "10,100,500").split(",").map(Number);
const runs = Number(opt("runs", "5"));
const duration = Number(opt("duration", "8"));
const cpus = opt("cpus", "2");
const memory = opt("memory", "2g");
const outDir = opt("out", "bench/results");

async function sh(c: string[]) {
  const p = Bun.spawn(c, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}
async function inherit(c: string[]) {
  const p = Bun.spawn(c, { stdout: "inherit", stderr: "inherit" });
  return p.exited;
}

async function start(tech: string) {
  await sh(["docker", "rm", "-f", NAME]);
  const t = TECHS[tech]!;
  const r = await sh([
    "docker", "run", "-d", "--rm", "--name", NAME,
    "--cpus", cpus, "--memory", memory, "-p", `${t.port}:8080`, `bench-${tech}`,
  ]);
  if (r.code !== 0) throw new Error(`docker run ${tech}: ${r.err}`);
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${t.port}/health`);
      if (res.ok) return `http://localhost:${t.port}`;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`${tech} ne démarre pas`);
}
const stop = () => sh(["docker", "rm", "-f", NAME]);

const MIB: Record<string, number> = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024, kB: 1 / 1024, MB: 1, GB: 1024 };
function parseMem(s: string) {
  const m = s.match(/([\d.]+)\s*([KMG]?i?B|kB)/);
  return m ? Number(m[1]) * (MIB[m[2]!] ?? 1) : NaN;
}

async function sampler(flag: { done: boolean }) {
  const cpu: number[] = [];
  const mem: number[] = [];
  while (!flag.done) {
    const r = await sh(["docker", "stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", NAME]);
    const [c, m] = r.out.trim().split("|");
    const cv = parseFloat(c ?? "");
    const mv = parseMem(m ?? "");
    if (!Number.isNaN(cv)) cpu.push(cv);
    if (!Number.isNaN(mv)) mem.push(mv);
  }
  return { cpu, mem };
}

const k6 = (base: string, scenario: string, vus: number, secs: number, out?: string) =>
  inherit([
    "k6", "run", "--quiet",
    "-e", `BASE_URL=${base}`, "-e", `SCENARIO=${scenario}`, "-e", `VUS=${vus}`, "-e", `DURATION=${secs}s`,
    ...(out ? ["-e", `OUT=${out}`] : []),
    "bench/k6/todo.js",
  ]);

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const shuffle = <T,>(a: T[]) => a.map((x) => [Math.random(), x] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);

if (cmd === "build") {
  for (const t of techs) {
    console.log(`== docker build bench-${t}`);
    if ((await inherit(["docker", "build", "-t", `bench-${t}`, TECHS[t]!.dir])) !== 0) process.exit(1);
  }
} else if (cmd === "smoke") {
  const transcripts: Record<string, string> = {};
  let bad = false;
  for (const t of techs) {
    const base = await start(t);
    const r = await runSmoke(base);
    await stop();
    console.log(`${t}: ${r.pass ? "OK" : "ÉCHEC"} (${r.transcript.length} requêtes)`);
    for (const f of r.fails) console.log("   -", f);
    if (!r.pass) bad = true;
    transcripts[t] = JSON.stringify(r.transcript);
  }
  const ref = transcripts[techs[0]!];
  for (const t of techs.slice(1)) {
    const same = transcripts[t] === ref;
    console.log(`transcription ${t} == ${techs[0]} : ${same ? "identique" : "DIFFÉRENTE"}`);
    if (!same) bad = true;
  }
  process.exit(bad ? 1 : 0);
} else if (cmd === "run") {
  mkdirSync(`${outDir}/raw`, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csv = `${outDir}/results_${stamp}.csv`;
  writeFileSync(
    csv,
    "tech,scenario,vus,run,duration_s,reqs,rps,avg_ms,p50_ms,p90_ms,p95_ms,p99_ms,max_ms,http_failed_rate,checks_rate,cpu_pct_mean,cpu_pct_max,mem_mib_max,cpus,memory\n",
  );
  const total = runs * scenarios.length * levels.length * techs.length;
  console.log(`${total} mesures, ~${Math.round((total * (duration + 10)) / 60)} min. CSV : ${csv}`);
  let n = 0;
  for (let run = 1; run <= runs; run++)
    for (const scenario of scenarios)
      for (const vus of levels)
        for (const tech of shuffle(techs)) {
          n++;
          console.log(`[${n}/${total}] ${tech} ${scenario} vus=${vus} essai=${run}`);
          const base = await start(tech);
          await k6(base, "mixed", 10, 3); // warm-up, écarté
          const flag = { done: false };
          const s = sampler(flag);
          const raw = `${outDir}/raw/${tech}_${scenario}_${vus}_${run}.json`;
          await k6(base, scenario, vus, duration, raw);
          flag.done = true;
          const { cpu, mem } = await s;
          await stop();
          if (!existsSync(raw)) {
            console.log("   pas de résumé k6 : mesure ignorée");
            continue;
          }
          const k = JSON.parse(readFileSync(raw, "utf8"));
          const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "");
          appendFileSync(
            csv,
            [
              tech, scenario, vus, run, duration, k.reqs, f(k.rps), f(k.avg), f(k.p50), f(k.p90), f(k.p95), f(k.p99), f(k.max),
              k.http_failed_rate, k.checks_rate, f(avg(cpu)), f(Math.max(...cpu)), f(Math.max(...mem)), cpus, memory,
            ].join(",") + "\n",
          );
        }
  console.log(`Terminé. Données brutes : ${csv} et ${outDir}/raw/`);
} else {
  console.log(`Usage : bun bench/run.ts <build|smoke|run> [--techs elysia,hono,rust,go] [--scenarios mixed|get_list,get_one,post,put,delete,mixed]
  [--levels 10,100,500] [--runs 5] [--duration 8] [--cpus 2] [--memory 2g] [--out bench/results]`);
}

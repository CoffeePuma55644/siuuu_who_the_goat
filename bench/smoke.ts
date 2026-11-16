// Test d'équivalence fonctionnelle. Usage : bun bench/smoke.ts http://localhost:3001
// Part d'une base fraîche (1000 tâches semées). Renvoie aussi une "transcription"
// normalisée, comparée d'une technologie à l'autre par `bun bench/run.ts smoke`.

type Rec = { step: string; status: number; body: unknown };

const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const norm = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, k === "created_at" && typeof x === "string" && TS.test(x) ? "<ts>" : norm(x)]),
    );
  }
  return v;
};

export async function runSmoke(base: string) {
  const rec: Rec[] = [];
  const fails: string[] = [];

  async function call(step: string, method: string, path: string, expect: number, body?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(base + path, { method, headers, body });
    const text = await r.text();
    let parsed: any = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = "<non-json>";
      }
      if (!(r.headers.get("content-type") ?? "").includes("application/json")) {
        fails.push(`${step}: Content-Type non JSON`);
      }
    }
    if (r.status !== expect) fails.push(`${step}: statut ${r.status}, attendu ${expect}`);
    for (const o of Array.isArray(parsed) ? parsed : [parsed]) {
      if (o && typeof o === "object" && "created_at" in o && !TS.test(o.created_at)) {
        fails.push(`${step}: created_at au mauvais format (${o.created_at})`);
        break;
      }
    }
    rec.push({ step, status: r.status, body: norm(parsed) });
    return parsed;
  }
  const must = (step: string, cond: boolean) => {
    if (!cond) fails.push(`${step}: condition fausse`);
  };

  let b: any;
  b = await call("health", "GET", "/health", 200);
  must("health body", b?.status === "ok");

  b = await call("list", "GET", "/tasks", 200);
  must("list: 100 éléments triés par id", Array.isArray(b) && b.length === 100 && b[0].id === 1 && b[99].id === 100);

  b = await call("get 1", "GET", "/tasks/1", 200);
  must("get 1: forme", b?.id === 1 && b.title === "Task 1" && b.completed === false && typeof b.created_at === "string");
  b = await call("get 5", "GET", "/tasks/5", 200);
  must("get 5: completed=true", b?.completed === true && b.description === "Description of task 5");
  await call("get absent", "GET", "/tasks/999999", 404);
  await call("get id invalide", "GET", "/tasks/abc", 400);
  await call("get id négatif", "GET", "/tasks/-1", 400);

  b = await call("post minimal", "POST", "/tasks", 201, JSON.stringify({ title: "A" }));
  must("post minimal: défauts", b?.id === 1001 && b.description === null && b.completed === false);
  b = await call("post complet", "POST", "/tasks", 201, JSON.stringify({ title: "B", description: "d", completed: true }));
  must("post complet", b?.id === 1002 && b.description === "d" && b.completed === true);
  await call("post sans titre", "POST", "/tasks", 400, JSON.stringify({ description: "x" }));
  await call("post titre vide", "POST", "/tasks", 400, JSON.stringify({ title: "" }));
  await call("post titre non-string", "POST", "/tasks", 400, JSON.stringify({ title: 3 }));
  await call("post completed invalide", "POST", "/tasks", 400, JSON.stringify({ title: "x", completed: "yes" }));
  await call("post description invalide", "POST", "/tasks", 400, JSON.stringify({ title: "x", description: 5 }));
  await call("post JSON invalide", "POST", "/tasks", 400, "{pas du json");
  await call("post tableau", "POST", "/tasks", 400, JSON.stringify([1, 2]));

  b = await call("put 1", "PUT", "/tasks/1", 200, JSON.stringify({ title: "Nouveau", completed: true }));
  must("put 1: remplacement complet", b?.id === 1 && b.title === "Nouveau" && b.description === null && b.completed === true);
  b = await call("get 1 après put", "GET", "/tasks/1", 200);
  must("put persisté", b?.title === "Nouveau");
  await call("put absent", "PUT", "/tasks/999999", 404, JSON.stringify({ title: "x" }));
  await call("put id invalide", "PUT", "/tasks/abc", 400, JSON.stringify({ title: "x" }));
  await call("put corps invalide", "PUT", "/tasks/1", 400, JSON.stringify({ title: "" }));
  await call("put id invalide + corps invalide", "PUT", "/tasks/abc", 400, JSON.stringify({ title: "" }));
  await call("put absent + corps invalide", "PUT", "/tasks/999999", 400, JSON.stringify({ title: "" }));

  await call("delete 1001", "DELETE", "/tasks/1001", 204);
  await call("get après delete", "GET", "/tasks/1001", 404);
  await call("delete déjà supprimé", "DELETE", "/tasks/1001", 404);
  await call("delete id invalide", "DELETE", "/tasks/abc", 400);

  return { pass: fails.length === 0, fails, transcript: rec };
}

if (import.meta.main) {
  const base = process.argv[2] ?? "http://localhost:3001";
  const r = await runSmoke(base);
  console.log(r.pass ? `OK (${r.transcript.length} requêtes)` : "ÉCHEC");
  for (const f of r.fails) console.log(" -", f);
  process.exit(r.pass ? 0 : 1);
}

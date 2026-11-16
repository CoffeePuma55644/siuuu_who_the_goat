// Test de charge k6 : boucle fermée (pas de temps de réflexion), VUS utilisateurs virtuels.
// Variables : BASE_URL, SCENARIO (get_list|get_one|post|put|delete|mixed), VUS, DURATION, OUT
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
const SCENARIO = __ENV.SCENARIO || "mixed";
const JSON_HDR = { headers: { "Content-Type": "application/json" } };

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || "10s",
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

const rid = () => 1 + Math.floor(Math.random() * 1000); // ids semés : 1..1000
const payload = () =>
  JSON.stringify({ title: "k6 " + Math.random(), description: "bench", completed: false });

function getList() {
  const r = http.get(`${BASE}/tasks`);
  check(r, { "GET /tasks 200": (x) => x.status === 200 });
}
function getOne() {
  const r = http.get(`${BASE}/tasks/${rid()}`);
  check(r, { "GET /tasks/:id 200": (x) => x.status === 200 });
}
function post() {
  const r = http.post(`${BASE}/tasks`, payload(), JSON_HDR);
  check(r, { "POST /tasks 201": (x) => x.status === 201 });
}
function put() {
  const r = http.put(`${BASE}/tasks/${rid()}`, payload(), JSON_HDR);
  check(r, { "PUT /tasks/:id 200": (x) => x.status === 200 });
}
// DELETE : on crée puis on supprime sa propre tâche (la table reste stable)
function del() {
  const c = http.post(`${BASE}/tasks`, payload(), JSON_HDR);
  const okc = check(c, { "POST (avant DELETE) 201": (x) => x.status === 201 });
  if (!okc) return;
  const d = http.del(`${BASE}/tasks/${c.json("id")}`);
  check(d, { "DELETE 204": (x) => x.status === 204 });
}
function mixed() {
  const p = Math.random();
  if (p < 0.5) getOne();
  else if (p < 0.7) getList();
  else if (p < 0.85) post();
  else if (p < 0.95) put();
  else del();
}

const SCENARIOS = { get_list: getList, get_one: getOne, post, put, delete: del, mixed };

export default function () {
  (SCENARIOS[SCENARIO] || mixed)();
}

function pick(m, ...keys) {
  const v = m && (m.values || m);
  if (!v) return null;
  for (const k of keys) if (v[k] !== undefined) return v[k];
  return null;
}

export function handleSummary(data) {
  if (!__ENV.OUT) return {};
  const d = data.metrics["http_req_duration"];
  const summary = {
    reqs: pick(data.metrics["http_reqs"], "count"),
    rps: pick(data.metrics["http_reqs"], "rate"),
    avg: pick(d, "avg"),
    p50: pick(d, "med"),
    p90: pick(d, "p(90)"),
    p95: pick(d, "p(95)"),
    p99: pick(d, "p(99)"),
    max: pick(d, "max"),
    http_failed_rate: pick(data.metrics["http_req_failed"], "rate", "value"),
    checks_rate: pick(data.metrics["checks"], "rate", "value"),
  };
  return { [__ENV.OUT]: JSON.stringify(summary) };
}

import { Hono } from "hono";
import { Database } from "bun:sqlite";

// Contrat commun : voir docs/openapi.yaml
const PORT = Number(process.env.PORT ?? 3002);
const DB_PATH = process.env.DB_PATH ?? "bench.db";

// --- Base SQLite : une seule connexion, WAL, mêmes réglages dans les 4 versions
const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA busy_timeout = 5000");
db.run(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  completed BOOLEAN NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const count = db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
if (count.n === 0) {
  const ins = db.query(
    "INSERT INTO tasks (title, description, completed) VALUES (?, ?, ?)",
  );
  db.transaction(() => {
    for (let i = 1; i <= 1000; i++) {
      ins.run(`Task ${i}`, `Description of task ${i}`, i % 5 === 0 ? 1 : 0);
    }
  })();
}

const COLS = "id, title, description, completed, created_at";
const qList = db.query(`SELECT ${COLS} FROM tasks ORDER BY id LIMIT 100`);
const qOne = db.query(`SELECT ${COLS} FROM tasks WHERE id = ?`);
const qInsert = db.query(
  `INSERT INTO tasks (title, description, completed) VALUES (?, ?, ?) RETURNING ${COLS}`,
);
const qUpdate = db.query(
  `UPDATE tasks SET title = ?, description = ?, completed = ? WHERE id = ? RETURNING ${COLS}`,
);
const qDelete = db.query("DELETE FROM tasks WHERE id = ?");

type Row = {
  id: number;
  title: string;
  description: string | null;
  completed: number;
  created_at: string;
};
const toTask = (r: Row) => ({ ...r, completed: r.completed !== 0 });

// --- Validation manuelle (identique dans les 4 versions)
function parseId(s: string): number | null {
  return /^\d+$/.test(s) ? Number(s) : null;
}
function parseInput(b: unknown) {
  if (typeof b !== "object" || b === null || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  if (typeof o.title !== "string" || o.title.length === 0) return null;
  const d = o.description;
  if (d !== undefined && d !== null && typeof d !== "string") return null;
  const c = o.completed;
  if (c !== undefined && typeof c !== "boolean") return null;
  return { title: o.title, description: (d ?? null) as string | null, completed: c === true ? 1 : 0 };
}

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/tasks", (c) => c.json((qList.all() as Row[]).map(toTask)));

app.get("/tasks/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_id" }, 400);
  const row = qOne.get(id) as Row | null;
  return row ? c.json(toTask(row)) : c.json({ error: "not_found" }, 404);
});

app.post("/tasks", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const input = parseInput(body);
  if (!input) return c.json({ error: "validation_error" }, 400);
  const row = qInsert.get(input.title, input.description, input.completed) as Row;
  return c.json(toTask(row), 201);
});

app.put("/tasks/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_id" }, 400);
  const body = await c.req.json().catch(() => undefined);
  const input = parseInput(body);
  if (!input) return c.json({ error: "validation_error" }, 400);
  const row = qUpdate.get(input.title, input.description, input.completed, id) as Row | null;
  return row ? c.json(toTask(row)) : c.json({ error: "not_found" }, 404);
});

app.delete("/tasks/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_id" }, 400);
  const r = qDelete.run(id);
  return r.changes > 0 ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});

console.log(`Hono (Bun) écoute sur :${PORT}`);

// Bun.serve est lancé par Bun lui-même à partir de cet export par défaut
export default { port: PORT, fetch: app.fetch };

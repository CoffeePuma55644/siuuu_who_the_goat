use axum::{
    Router,
    body::Bytes,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

// Contrat commun : voir docs/openapi.yaml
// Une seule connexion SQLite protégée par un Mutex, WAL, mêmes réglages que les autres versions.
type Db = Arc<Mutex<Connection>>;

const SQL_LIST: &str = "SELECT id, title, description, completed, created_at FROM tasks ORDER BY id LIMIT 100";
const SQL_ONE: &str = "SELECT id, title, description, completed, created_at FROM tasks WHERE id = ?1";
const SQL_INSERT: &str = "INSERT INTO tasks (title, description, completed) VALUES (?1, ?2, ?3) RETURNING id, title, description, completed, created_at";
const SQL_UPDATE: &str = "UPDATE tasks SET title = ?1, description = ?2, completed = ?3 WHERE id = ?4 RETURNING id, title, description, completed, created_at";
const SQL_DELETE: &str = "DELETE FROM tasks WHERE id = ?1";

fn row_to_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let completed: i64 = r.get(3)?;
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "title": r.get::<_, String>(1)?,
        "description": r.get::<_, Option<String>>(2)?,
        "completed": completed != 0,
        "created_at": r.get::<_, String>(4)?,
    }))
}

fn json_resp(status: StatusCode, v: Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
}

fn fail(status: StatusCode, code: &str) -> Response {
    json_resp(status, json!({ "error": code }))
}

fn parse_id(s: &str) -> Option<i64> {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

// (title, description, completed)
fn parse_input(body: &Bytes) -> Option<(String, Option<String>, i64)> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let o = v.as_object()?;
    let title = o.get("title")?.as_str()?;
    if title.is_empty() {
        return None;
    }
    let description = match o.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        _ => return None,
    };
    let completed = match o.get("completed") {
        None => 0,
        Some(Value::Bool(b)) => *b as i64,
        _ => return None,
    };
    Some((title.to_string(), description, completed))
}

async fn health() -> Response {
    json_resp(StatusCode::OK, json!({ "status": "ok" }))
}

async fn list(State(db): State<Db>) -> Response {
    let conn = db.lock().unwrap();
    let out = match conn.prepare_cached(SQL_LIST) {
        Ok(mut stmt) => match stmt.query_map([], row_to_json) {
            Ok(rows) => match rows.collect::<Result<Vec<Value>, _>>() {
                Ok(v) => json_resp(StatusCode::OK, Value::Array(v)),
                Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
            },
            Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        },
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };
    out
}

async fn get_one(State(db): State<Db>, Path(id): Path<String>) -> Response {
    let Some(id) = parse_id(&id) else {
        return fail(StatusCode::BAD_REQUEST, "invalid_id");
    };
    let conn = db.lock().unwrap();
    let out = match conn.prepare_cached(SQL_ONE) {
        Ok(mut stmt) => match stmt.query_row([id], row_to_json).optional() {
            Ok(Some(v)) => json_resp(StatusCode::OK, v),
            Ok(None) => fail(StatusCode::NOT_FOUND, "not_found"),
            Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        },
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };
    out
}

async fn create(State(db): State<Db>, body: Bytes) -> Response {
    let Some((title, description, completed)) = parse_input(&body) else {
        return fail(StatusCode::BAD_REQUEST, "validation_error");
    };
    let conn = db.lock().unwrap();
    let out = match conn.prepare_cached(SQL_INSERT) {
        Ok(mut stmt) => match stmt.query_row(params![title, description, completed], row_to_json) {
            Ok(v) => json_resp(StatusCode::CREATED, v),
            Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        },
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };
    out
}

async fn update(State(db): State<Db>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(id) = parse_id(&id) else {
        return fail(StatusCode::BAD_REQUEST, "invalid_id");
    };
    let Some((title, description, completed)) = parse_input(&body) else {
        return fail(StatusCode::BAD_REQUEST, "validation_error");
    };
    let conn = db.lock().unwrap();
    let out = match conn.prepare_cached(SQL_UPDATE) {
        Ok(mut stmt) => match stmt
            .query_row(params![title, description, completed, id], row_to_json)
            .optional()
        {
            Ok(Some(v)) => json_resp(StatusCode::OK, v),
            Ok(None) => fail(StatusCode::NOT_FOUND, "not_found"),
            Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        },
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };
    out
}

async fn remove(State(db): State<Db>, Path(id): Path<String>) -> Response {
    let Some(id) = parse_id(&id) else {
        return fail(StatusCode::BAD_REQUEST, "invalid_id");
    };
    let conn = db.lock().unwrap();
    let out = match conn.prepare_cached(SQL_DELETE) {
        Ok(mut stmt) => match stmt.execute([id]) {
            Ok(n) if n > 0 => StatusCode::NO_CONTENT.into_response(),
            Ok(_) => fail(StatusCode::NOT_FOUND, "not_found"),
            Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        },
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };
    out
}

#[tokio::main]
async fn main() {
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "bench.db".into());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3003);

    let conn = Connection::open(&db_path).expect("ouverture SQLite");
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS tasks (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           title TEXT NOT NULL,
           description TEXT,
           completed BOOLEAN NOT NULL DEFAULT 0,
           created_at DATETIME DEFAULT CURRENT_TIMESTAMP
         );",
    )
    .expect("init schéma");

    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
        .unwrap();
    if n == 0 {
        let tx = conn.unchecked_transaction().unwrap();
        {
            let mut st = tx
                .prepare("INSERT INTO tasks (title, description, completed) VALUES (?1, ?2, ?3)")
                .unwrap();
            for i in 1..=1000 {
                st.execute(params![
                    format!("Task {i}"),
                    format!("Description of task {i}"),
                    (i % 5 == 0) as i64
                ])
                .unwrap();
            }
        }
        tx.commit().unwrap();
    }

    let db: Db = Arc::new(Mutex::new(conn));
    let app = Router::new()
        .route("/health", get(health))
        .route("/tasks", get(list).post(create))
        .route("/tasks/{id}", get(get_one).put(update).delete(remove))
        .with_state(db);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind");
    println!("Axum (Tokio) écoute sur :{port}");
    axum::serve(listener, app).await.unwrap();
}

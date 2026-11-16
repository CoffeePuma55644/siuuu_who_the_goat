package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"

	_ "modernc.org/sqlite"
)

// Contrat commun : voir docs/openapi.yaml
// Une seule connexion SQLite, WAL, mêmes réglages que les autres versions.

type Task struct {
	ID          int64   `json:"id"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
	Completed   bool    `json:"completed"`
	CreatedAt   string  `json:"created_at"`
}

const cols = "id, title, description, completed, created_at"

var (
	stmtList   *sql.Stmt
	stmtOne    *sql.Stmt
	stmtInsert *sql.Stmt
	stmtUpdate *sql.Stmt
	stmtDelete *sql.Stmt
)

type scanner interface{ Scan(dest ...any) error }

func scanTask(s scanner) (Task, error) {
	var t Task
	var desc sql.NullString
	var completed int64
	if err := s.Scan(&t.ID, &t.Title, &desc, &completed, &t.CreatedAt); err != nil {
		return t, err
	}
	if desc.Valid {
		d := desc.String
		t.Description = &d
	}
	t.Completed = completed != 0
	return t, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(b)
}

func fail(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func parseID(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	id, err := strconv.ParseInt(s, 10, 64)
	return id, err == nil
}

// title, description, completed
func parseInput(r *http.Request) (string, *string, int64, bool) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return "", nil, 0, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return "", nil, 0, false
	}
	title, ok := m["title"].(string)
	if !ok || title == "" {
		return "", nil, 0, false
	}
	var desc *string
	if v, present := m["description"]; present && v != nil {
		s, ok := v.(string)
		if !ok {
			return "", nil, 0, false
		}
		desc = &s
	}
	var completed int64
	if v, present := m["completed"]; present {
		b, ok := v.(bool)
		if !ok {
			return "", nil, 0, false
		}
		if b {
			completed = 1
		}
	}
	return title, desc, completed, true
}

func health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func list(w http.ResponseWriter, r *http.Request) {
	rows, err := stmtList.Query()
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error")
		return
	}
	defer rows.Close()
	tasks := make([]Task, 0, 100)
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			fail(w, http.StatusInternalServerError, "internal_error")
			return
		}
		tasks = append(tasks, t)
	}
	writeJSON(w, http.StatusOK, tasks)
}

func getOne(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		fail(w, http.StatusBadRequest, "invalid_id")
		return
	}
	t, err := scanTask(stmtOne.QueryRow(id))
	if err == sql.ErrNoRows {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func create(w http.ResponseWriter, r *http.Request) {
	title, desc, completed, ok := parseInput(r)
	if !ok {
		fail(w, http.StatusBadRequest, "validation_error")
		return
	}
	t, err := scanTask(stmtInsert.QueryRow(title, desc, completed))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func update(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		fail(w, http.StatusBadRequest, "invalid_id")
		return
	}
	title, desc, completed, ok := parseInput(r)
	if !ok {
		fail(w, http.StatusBadRequest, "validation_error")
		return
	}
	t, err := scanTask(stmtUpdate.QueryRow(title, desc, completed, id))
	if err == sql.ErrNoRows {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func remove(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		fail(w, http.StatusBadRequest, "invalid_id")
		return
	}
	res, err := stmtDelete.Exec(id)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	dbPath := getenv("DB_PATH", "bench.db")
	port := getenv("PORT", "3004")

	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS tasks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		title TEXT NOT NULL,
		description TEXT,
		completed BOOLEAN NOT NULL DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		log.Fatal(err)
	}

	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM tasks").Scan(&n); err != nil {
		log.Fatal(err)
	}
	if n == 0 {
		tx, err := db.Begin()
		if err != nil {
			log.Fatal(err)
		}
		ins, err := tx.Prepare("INSERT INTO tasks (title, description, completed) VALUES (?, ?, ?)")
		if err != nil {
			log.Fatal(err)
		}
		for i := 1; i <= 1000; i++ {
			c := 0
			if i%5 == 0 {
				c = 1
			}
			if _, err := ins.Exec(fmt.Sprintf("Task %d", i), fmt.Sprintf("Description of task %d", i), c); err != nil {
				log.Fatal(err)
			}
		}
		ins.Close()
		if err := tx.Commit(); err != nil {
			log.Fatal(err)
		}
	}

	prep := func(q string) *sql.Stmt {
		s, err := db.Prepare(q)
		if err != nil {
			log.Fatal(err)
		}
		return s
	}
	stmtList = prep("SELECT " + cols + " FROM tasks ORDER BY id LIMIT 100")
	stmtOne = prep("SELECT " + cols + " FROM tasks WHERE id = ?")
	stmtInsert = prep("INSERT INTO tasks (title, description, completed) VALUES (?, ?, ?) RETURNING " + cols)
	stmtUpdate = prep("UPDATE tasks SET title = ?, description = ?, completed = ? WHERE id = ? RETURNING " + cols)
	stmtDelete = prep("DELETE FROM tasks WHERE id = ?")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("GET /tasks", list)
	mux.HandleFunc("POST /tasks", create)
	mux.HandleFunc("GET /tasks/{id}", getOne)
	mux.HandleFunc("PUT /tasks/{id}", update)
	mux.HandleFunc("DELETE /tasks/{id}", remove)

	log.Printf("Go net/http écoute sur :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

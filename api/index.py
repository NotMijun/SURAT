import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Literal

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

SESSION_TTL_SECONDS = 60 * 60 * 2
LOGIN_RATE_WINDOW_SECONDS = 10 * 60
LOGIN_RATE_MAX_ATTEMPTS = 8

_schema_lock = threading.Lock()
_schema_ready = False

app = FastAPI()


@app.exception_handler(HTTPException)
async def _http_exception_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=int(exc.status_code), content={"error": str(exc.detail)})


@app.exception_handler(Exception)
async def _unhandled_exception_handler(_: Request, __: Exception):
    return JSONResponse(status_code=500, content={"error": "Kesalahan server"})


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_text(s: str) -> str:
    return " ".join((s or "").strip().lower().split())


def pbkdf2_hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return "pbkdf2_sha256$200000$" + base64.b64encode(salt).decode("ascii") + "$" + base64.b64encode(dk).decode("ascii")


def pbkdf2_verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iters, b64salt, b64hash = stored.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(b64salt.encode("ascii"))
        expected = base64.b64decode(b64hash.encode("ascii"))
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iters))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


def _database_url() -> str:
    url = (os.getenv("DATABASE_URL") or "").strip()
    if not url:
        raise HTTPException(status_code=500, detail="DATABASE_URL belum dikonfigurasi")
    return url


@contextmanager
def db_connect():
    conn = psycopg2.connect(_database_url(), connect_timeout=5)
    try:
        _ensure_schema(conn)
        yield conn
    finally:
        conn.close()


def _ensure_schema(conn) -> None:
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                  id BIGSERIAL PRIMARY KEY,
                  username TEXT NOT NULL UNIQUE,
                  display_name TEXT NOT NULL,
                  password_hash TEXT NOT NULL,
                  role TEXT NOT NULL CHECK (role IN ('guard','supervisor','admin')),
                  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
                  created_at TEXT NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                  id TEXT PRIMARY KEY,
                  user_id BIGINT NOT NULL REFERENCES users(id),
                  created_at TEXT NOT NULL,
                  last_seen_at TEXT NOT NULL,
                  shift TEXT NOT NULL,
                  post TEXT NOT NULL,
                  expires_at BIGINT NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS login_attempts (
                  key TEXT PRIMARY KEY,
                  count INTEGER NOT NULL,
                  first_ts BIGINT NOT NULL,
                  last_ts BIGINT NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS key_transactions (
                  id BIGSERIAL PRIMARY KEY,
                  borrower_name TEXT NOT NULL,
                  borrower_name_norm TEXT NOT NULL,
                  unit TEXT NOT NULL,
                  key_name TEXT NOT NULL,
                  key_name_norm TEXT NOT NULL,
                  checkout_at TEXT NOT NULL,
                  checkin_at TEXT,
                  notes TEXT NOT NULL,
                  status TEXT NOT NULL CHECK (status IN ('open','closed','void')),
                  created_by BIGINT NOT NULL REFERENCES users(id),
                  created_shift TEXT NOT NULL,
                  created_post TEXT NOT NULL,
                  closed_by BIGINT REFERENCES users(id),
                  closed_shift TEXT,
                  closed_post TEXT,
                  void_reason TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_key_open ON key_transactions(status, key_name_norm)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_key_borrower ON key_transactions(borrower_name_norm)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_key_checkout ON key_transactions(checkout_at)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS mutasi_entries (
                  id BIGSERIAL PRIMARY KEY,
                  occurred_at TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  description TEXT NOT NULL,
                  created_by BIGINT NOT NULL REFERENCES users(id),
                  shift TEXT NOT NULL,
                  post TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_mutasi_occurred ON mutasi_entries(occurred_at)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS guest_entries (
                  id BIGSERIAL PRIMARY KEY,
                  name TEXT NOT NULL,
                  instansi TEXT NOT NULL,
                  purpose TEXT NOT NULL,
                  meet_person TEXT NOT NULL,
                  checkin_at TEXT NOT NULL,
                  checkout_at TEXT,
                  notes TEXT NOT NULL,
                  status TEXT NOT NULL CHECK (status IN ('in','out')),
                  created_by BIGINT NOT NULL REFERENCES users(id),
                  shift TEXT NOT NULL,
                  post TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_guest_status ON guest_entries(status)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_guest_checkin ON guest_entries(checkin_at)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS task_entries (
                  id BIGSERIAL PRIMARY KEY,
                  kind TEXT NOT NULL,
                  occurred_at TEXT NOT NULL,
                  destination TEXT NOT NULL,
                  notes TEXT NOT NULL,
                  created_by BIGINT NOT NULL REFERENCES users(id),
                  shift TEXT NOT NULL,
                  post TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_task_occurred ON task_entries(occurred_at)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_log (
                  id BIGSERIAL PRIMARY KEY,
                  actor_user_id BIGINT NOT NULL REFERENCES users(id),
                  target_key_transaction_id BIGINT REFERENCES key_transactions(id),
                  target_guest_entry_id BIGINT REFERENCES guest_entries(id),
                  target_mutasi_entry_id BIGINT REFERENCES mutasi_entries(id),
                  target_task_entry_id BIGINT REFERENCES task_entries(id),
                  target_user_id BIGINT REFERENCES users(id),
                  action TEXT NOT NULL,
                  actor_shift TEXT NOT NULL,
                  actor_post TEXT NOT NULL,
                  before_json TEXT,
                  after_json TEXT,
                  created_at TEXT NOT NULL,
                  CONSTRAINT audit_log_one_target CHECK (
                    ((target_key_transaction_id IS NOT NULL)::int +
                     (target_guest_entry_id IS NOT NULL)::int +
                     (target_mutasi_entry_id IS NOT NULL)::int +
                     (target_task_entry_id IS NOT NULL)::int +
                     (target_user_id IS NOT NULL)::int) = 1
                  )
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, created_at)")
        conn.commit()
        _maybe_bootstrap_admin(conn)
        _schema_ready = True


def _maybe_bootstrap_admin(conn) -> None:
    username = (os.getenv("BOOTSTRAP_ADMIN_USERNAME") or "admin").strip()
    password = (os.getenv("BOOTSTRAP_ADMIN_PASSWORD") or "").strip()
    display_name = (os.getenv("BOOTSTRAP_ADMIN_DISPLAY_NAME") or "ADMIN").strip()
    if not password:
        return
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(1) FROM users")
        c = int(cur.fetchone()[0] or 0)
        if c != 0:
            return
        cur.execute(
            "INSERT INTO users(username, display_name, password_hash, role, is_active, created_at) VALUES (%s,%s,%s,%s,%s,%s)",
            (normalize_text(username), display_name, pbkdf2_hash_password(password), "admin", 1, utc_now_iso()),
        )
    conn.commit()


def _client_key(request: Request) -> str:
    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if not ip:
        ip = request.client.host if request.client else ""
    ua = (request.headers.get("user-agent") or "")[:120]
    raw = f"{ip}|{ua}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _rate_limit_login(conn, request: Request) -> bool:
    now_ts = int(time.time())
    key = _client_key(request)
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT key, count, first_ts, last_ts FROM login_attempts WHERE key = %s", (key,))
        row = cur.fetchone()
        if not row:
            cur.execute("INSERT INTO login_attempts(key, count, first_ts, last_ts) VALUES (%s,%s,%s,%s)", (key, 0, now_ts, now_ts))
            conn.commit()
            return False
        first_ts = int(row["first_ts"])
        if now_ts - first_ts > LOGIN_RATE_WINDOW_SECONDS:
            cur.execute("UPDATE login_attempts SET count=0, first_ts=%s, last_ts=%s WHERE key=%s", (now_ts, now_ts, key))
            conn.commit()
            return False
        count = int(row["count"])
        return count >= LOGIN_RATE_MAX_ATTEMPTS


def _record_login_attempt(conn, request: Request, success: bool) -> None:
    now_ts = int(time.time())
    key = _client_key(request)
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT key, count, first_ts FROM login_attempts WHERE key=%s", (key,))
        row = cur.fetchone()
        if not row:
            cur.execute("INSERT INTO login_attempts(key, count, first_ts, last_ts) VALUES (%s,%s,%s,%s)", (key, 0, now_ts, now_ts))
            cur.execute("SELECT key, count, first_ts FROM login_attempts WHERE key=%s", (key,))
            row = cur.fetchone()
        first_ts = int(row["first_ts"])
        if now_ts - first_ts > LOGIN_RATE_WINDOW_SECONDS:
            cur.execute("UPDATE login_attempts SET count=%s, first_ts=%s, last_ts=%s WHERE key=%s", (0, now_ts, now_ts, key))
            conn.commit()
            return
        if success:
            cur.execute("UPDATE login_attempts SET count=0, last_ts=%s WHERE key=%s", (now_ts, key))
        else:
            cur.execute("UPDATE login_attempts SET count=count+1, last_ts=%s WHERE key=%s", (now_ts, key))
    conn.commit()


def _get_token(request: Request) -> str:
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth.split(None, 1)[1].strip()
    return ""


def _get_session(conn, request: Request) -> dict[str, Any] | None:
    token = _get_token(request)
    if not token:
        return None
    now_ts = int(time.time())
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT s.id AS sid, s.user_id, s.shift, s.post, s.expires_at, s.last_seen_at,
                   u.username, u.display_name, u.role, u.is_active
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.id = %s
            """,
            (token,),
        )
        row = cur.fetchone()
        if not row:
            return None
        if int(row["is_active"]) != 1:
            return None
        if int(row["expires_at"]) <= now_ts:
            cur.execute("DELETE FROM sessions WHERE id = %s", (token,))
            conn.commit()
            return None
        cur.execute("UPDATE sessions SET last_seen_at=%s, expires_at=%s WHERE id=%s", (utc_now_iso(), now_ts + SESSION_TTL_SECONDS, token))
    conn.commit()
    return dict(row)


def _require_session(conn, request: Request) -> dict[str, Any]:
    sess = _get_session(conn, request)
    if not sess:
        raise HTTPException(status_code=401, detail="Harus login")
    return sess


def _require_role(sess: dict[str, Any], allowed_roles: tuple[str, ...]) -> None:
    if (sess.get("role") or "") not in allowed_roles:
        raise HTTPException(status_code=403, detail="Tidak punya akses")


def _audit(conn, sess: dict[str, Any], table_name: str, record_id: str, action: str, before, after):
    target: dict[str, Any] = {
        "target_key_transaction_id": None,
        "target_guest_entry_id": None,
        "target_mutasi_entry_id": None,
        "target_task_entry_id": None,
        "target_user_id": None,
    }
    try:
        rec_int = int(record_id)
    except Exception:
        rec_int = None
    t = (table_name or "").strip()
    if t == "key_transactions":
        target["target_key_transaction_id"] = rec_int
    elif t == "guest_entries":
        target["target_guest_entry_id"] = rec_int
    elif t == "mutasi_entries":
        target["target_mutasi_entry_id"] = rec_int
    elif t == "task_entries":
        target["target_task_entry_id"] = rec_int
    elif t in ("users", "auth"):
        target["target_user_id"] = rec_int

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO audit_log(actor_user_id, target_key_transaction_id, target_guest_entry_id, target_mutasi_entry_id, target_task_entry_id, target_user_id,
                                  action, actor_shift, actor_post, before_json, after_json, created_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (
                sess["user_id"],
                target["target_key_transaction_id"],
                target["target_guest_entry_id"],
                target["target_mutasi_entry_id"],
                target["target_task_entry_id"],
                target["target_user_id"],
                action,
                sess["shift"],
                sess["post"],
                json.dumps(before, ensure_ascii=False) if before is not None else None,
                json.dumps(after, ensure_ascii=False) if after is not None else None,
                utc_now_iso(),
            ),
        )


class LoginBody(BaseModel):
    username: str
    password: str
    shift: str | None = None
    post: str | None = None


class CreateUserBody(BaseModel):
    username: str
    display_name: str
    password: str
    role: Literal["guard", "supervisor", "admin"]


class PatchUserBody(BaseModel):
    display_name: str | None = None
    role: Literal["guard", "supervisor", "admin"] | None = None
    is_active: int | None = None


class CreateKeyBody(BaseModel):
    borrower_name: str | None = None
    unit: str | None = None
    key_name: str
    checkout_at: str | None = None
    notes: str | None = None
    force: bool | None = None


class PatchKeyBody(BaseModel):
    borrower_name: str | None = None
    unit: str | None = None
    key_name: str | None = None
    notes: str | None = None


class CreateMutasiBody(BaseModel):
    kind: str
    occurred_at: str
    description: str


class CreateGuestBody(BaseModel):
    name: str
    instansi: str
    purpose: str
    meet_person: str
    checkin_at: str
    notes: str | None = None


class CreateTaskBody(BaseModel):
    kind: str
    occurred_at: str
    destination: str
    notes: str


@app.get("/api/health")
def health():
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1;")
            cur.fetchone()
    return {"ok": True, "message": "Backend hidup dan database tersambung"}


@app.post("/api/login")
def login(body: LoginBody, request: Request):
    with db_connect() as conn:
        if _rate_limit_login(conn, request):
            raise HTTPException(status_code=429, detail="Terlalu banyak percobaan login. Coba lagi beberapa menit.")
        username = normalize_text(body.username or "")
        password = body.password or ""
        shift = (body.shift or "").strip() or "Pagi"
        post = (body.post or "").strip() or "IGD"
        if not username or not password:
            _record_login_attempt(conn, request, success=False)
            raise HTTPException(status_code=400, detail="Username dan password wajib diisi")

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id, username, display_name, password_hash, role, is_active FROM users WHERE username=%s",
                (username,),
            )
            user = cur.fetchone()
            if not user or int(user["is_active"]) != 1:
                _record_login_attempt(conn, request, success=False)
                raise HTTPException(status_code=401, detail="Login gagal")
            if not pbkdf2_verify_password(password, str(user["password_hash"])):
                _record_login_attempt(conn, request, success=False)
                raise HTTPException(status_code=401, detail="Login gagal")

            _record_login_attempt(conn, request, success=True)
            sid = secrets.token_urlsafe(24)
            now_iso = utc_now_iso()
            now_ts = int(time.time())
            cur.execute(
                "INSERT INTO sessions(id, user_id, created_at, last_seen_at, shift, post, expires_at) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (sid, int(user["id"]), now_iso, now_iso, shift, post, now_ts + SESSION_TTL_SECONDS),
            )
        conn.commit()
        return {
            "ok": True,
            "token": sid,
            "user": {"id": int(user["id"]), "username": user["username"], "display_name": user["display_name"], "role": user["role"]},
            "shift": shift,
            "post": post,
        }


@app.get("/api/me")
def me(request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        return {
            "user": {"id": int(sess["user_id"]), "username": sess["username"], "display_name": sess["display_name"], "role": sess["role"]},
            "shift": sess["shift"],
            "post": sess["post"],
        }


@app.post("/api/logout")
def logout(request: Request):
    with db_connect() as conn:
        token = _get_token(request)
        if token:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM sessions WHERE id=%s", (token,))
            conn.commit()
    return {"ok": True}


@app.get("/api/handover")
def handover(request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, borrower_name, unit, key_name, checkout_at, notes, status
                FROM key_transactions
                WHERE status='open'
                ORDER BY checkout_at DESC
                LIMIT 50
                """
            )
            keys_open = cur.fetchall()
            cur.execute(
                """
                SELECT id, name, instansi, purpose, meet_person, checkin_at, status
                FROM guest_entries
                WHERE status='in'
                ORDER BY checkin_at DESC
                LIMIT 50
                """
            )
            guests_in = cur.fetchall()
        return {"open_keys": keys_open, "guests_in": guests_in}


@app.get("/api/keys")
def list_keys(request: Request, status: str = "open", q: str = ""):
    with db_connect() as conn:
        _require_session(conn, request)
        status = (status or "open").strip()
        qn = normalize_text(q)
        where = []
        params: list[Any] = []
        if status in ("open", "closed", "void"):
            where.append("kt.status = %s")
            params.append(status)
        if qn:
            where.append("(kt.borrower_name_norm LIKE %s OR kt.key_name_norm LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%"])
        sql = """
          SELECT kt.id, kt.borrower_name, kt.unit, kt.key_name, kt.checkout_at, kt.checkin_at, kt.notes, kt.status,
                 u.display_name AS created_by_name,
                 u2.display_name AS closed_by_name,
                 kt.created_shift, kt.created_post, kt.closed_shift, kt.closed_post
          FROM key_transactions kt
          JOIN users u ON u.id = kt.created_by
          LEFT JOIN users u2 ON u2.id = kt.closed_by
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY kt.checkout_at DESC LIMIT 200"
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/keys")
def create_key(body: CreateKeyBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        borrower_name = (body.borrower_name or "").strip() or "Tidak diketahui"
        unit = (body.unit or "").strip() or "-"
        key_name = (body.key_name or "").strip()
        checkout_at = (body.checkout_at or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        notes = (body.notes or "").strip()
        if not key_name:
            raise HTTPException(status_code=400, detail="Kunci/ruangan wajib diisi")
        key_norm = normalize_text(key_name)
        borrower_norm = normalize_text(borrower_name)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id, borrower_name, unit, key_name, checkout_at FROM key_transactions WHERE status='open' AND key_name_norm=%s",
                (key_norm,),
            )
            existing_open = cur.fetchone()
            if existing_open and not body.force:
                raise HTTPException(status_code=409, detail=f"Kunci '{existing_open['key_name']}' masih tercatat dipinjam (ID {existing_open['id']}).")

            cur.execute(
                """
                SELECT id FROM key_transactions
                WHERE borrower_name_norm=%s AND key_name_norm=%s AND status='open'
                LIMIT 1
                """,
                (borrower_norm, key_norm),
            )
            recent_dup = cur.fetchone()
            if recent_dup and not body.force:
                raise HTTPException(status_code=409, detail=f"Transaksi serupa sudah ada (ID {recent_dup['id']}).")

            now = utc_now_iso()
            cur.execute(
                """
                INSERT INTO key_transactions(
                  borrower_name, borrower_name_norm, unit, key_name, key_name_norm, checkout_at, checkin_at, notes, status,
                  created_by, created_shift, created_post, created_at, updated_at
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
                """,
                (
                    borrower_name,
                    borrower_norm,
                    unit,
                    key_name,
                    key_norm,
                    checkout_at,
                    None,
                    notes,
                    "open",
                    sess["user_id"],
                    sess["shift"],
                    sess["post"],
                    now,
                    now,
                ),
            )
            record_id = int(cur.fetchone()["id"])
            _audit(
                conn,
                sess,
                "key_transactions",
                str(record_id),
                "create",
                None,
                {"borrower_name": borrower_name, "unit": unit, "key_name": key_name, "checkout_at": checkout_at, "notes": notes, "status": "open"},
            )
        conn.commit()
        return {"ok": True, "id": record_id}


@app.post("/api/keys/{key_id}/return")
def return_key(key_id: str, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM key_transactions WHERE id=%s", (key_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if row["status"] != "open":
                raise HTTPException(status_code=400, detail="Transaksi sudah ditutup")
            before = dict(row)
            now = utc_now_iso()
            cur.execute(
                """
                UPDATE key_transactions
                SET status='closed', checkin_at=%s, closed_by=%s, closed_shift=%s, closed_post=%s, updated_at=%s
                WHERE id=%s
                """,
                (datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), sess["user_id"], sess["shift"], sess["post"], now, key_id),
            )
            cur.execute("SELECT * FROM key_transactions WHERE id=%s", (key_id,))
            after = dict(cur.fetchone())
            _audit(conn, sess, "key_transactions", str(key_id), "close", before, after)
        conn.commit()
        return {"ok": True}


@app.patch("/api/keys/{key_id}")
def patch_key(key_id: str, body: PatchKeyBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM key_transactions WHERE id=%s", (key_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            before = dict(row)
            updates: dict[str, Any] = {}
            if body.borrower_name is not None:
                updates["borrower_name"] = (body.borrower_name or "").strip()
            if body.unit is not None:
                updates["unit"] = (body.unit or "").strip()
            if body.key_name is not None:
                updates["key_name"] = (body.key_name or "").strip()
            if body.notes is not None:
                updates["notes"] = (body.notes or "").strip()
            if not updates:
                return {"ok": True}
            if "borrower_name" in updates:
                if not updates["borrower_name"]:
                    updates["borrower_name"] = "Tidak diketahui"
                updates["borrower_name_norm"] = normalize_text(updates["borrower_name"])
            if "unit" in updates and not updates["unit"]:
                updates["unit"] = "-"
            if "key_name" in updates:
                if not updates["key_name"]:
                    raise HTTPException(status_code=400, detail="Kunci/ruangan tidak boleh kosong")
                updates["key_name_norm"] = normalize_text(updates["key_name"])

            updates["updated_at"] = utc_now_iso()
            cols = ", ".join([f"{k}=%s" for k in updates.keys()])
            params = list(updates.values()) + [key_id]
            cur.execute(f"UPDATE key_transactions SET {cols} WHERE id=%s", params)
            cur.execute("SELECT * FROM key_transactions WHERE id=%s", (key_id,))
            after = dict(cur.fetchone())
            _audit(conn, sess, "key_transactions", str(key_id), "update", before, after)
        conn.commit()
        return {"ok": True}


@app.get("/api/mutasi")
def list_mutasi(request: Request, q: str = ""):
    with db_connect() as conn:
        _require_session(conn, request)
        qn = normalize_text(q)
        where = []
        params: list[Any] = []
        if qn:
            where.append("(lower(kind) LIKE %s OR lower(description) LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%"])
        sql = """
          SELECT m.id, m.occurred_at, m.kind, m.description, u.display_name AS created_by_name, m.shift, m.post
          FROM mutasi_entries m
          JOIN users u ON u.id = m.created_by
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY m.occurred_at DESC LIMIT 200"
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/mutasi")
def create_mutasi(body: CreateMutasiBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        kind = (body.kind or "").strip() or "Lainnya"
        occurred = (body.occurred_at or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        desc = (body.description or "").strip()
        if not desc:
            raise HTTPException(status_code=400, detail="Deskripsi wajib diisi")
        now = utc_now_iso()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO mutasi_entries(occurred_at, kind, description, created_by, shift, post, created_at, updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
                """,
                (occurred, kind, desc, sess["user_id"], sess["shift"], sess["post"], now, now),
            )
            mid = int(cur.fetchone()[0])
            _audit(conn, sess, "mutasi_entries", str(mid), "create", None, {"occurred_at": occurred, "kind": kind, "description": desc})
        conn.commit()
        return {"ok": True, "id": mid}


@app.get("/api/guests")
def list_guests(request: Request, status: str = "in", q: str = ""):
    with db_connect() as conn:
        _require_session(conn, request)
        status = (status or "in").strip()
        qn = normalize_text(q)
        where = []
        params: list[Any] = []
        if status in ("in", "out"):
            where.append("g.status = %s")
            params.append(status)
        if qn:
            where.append("(lower(g.name) LIKE %s OR lower(g.instansi) LIKE %s OR lower(g.purpose) LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%", f"%{qn}%"])
        sql = """
          SELECT g.id, g.name, g.instansi, g.purpose, g.meet_person, g.checkin_at, g.checkout_at, g.notes, g.status,
                 u.display_name AS created_by_name, g.shift, g.post
          FROM guest_entries g
          JOIN users u ON u.id = g.created_by
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY g.checkin_at DESC LIMIT 200"
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/guests")
def create_guest(body: CreateGuestBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        name = (body.name or "").strip()
        instansi = (body.instansi or "").strip()
        purpose = (body.purpose or "").strip()
        meet = (body.meet_person or "").strip()
        checkin_at = (body.checkin_at or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        notes = (body.notes or "").strip()
        if not name or not instansi or not purpose or not meet:
            raise HTTPException(status_code=400, detail="Data tamu belum lengkap")
        now = utc_now_iso()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO guest_entries(name, instansi, purpose, meet_person, checkin_at, checkout_at, notes, status, created_by, shift, post, created_at, updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
                """,
                (name, instansi, purpose, meet, checkin_at, None, notes, "in", sess["user_id"], sess["shift"], sess["post"], now, now),
            )
            gid = int(cur.fetchone()[0])
            _audit(
                conn,
                sess,
                "guest_entries",
                str(gid),
                "create",
                None,
                {"name": name, "instansi": instansi, "purpose": purpose, "meet_person": meet, "checkin_at": checkin_at, "notes": notes, "status": "in"},
            )
        conn.commit()
        return {"ok": True, "id": gid}


@app.post("/api/guests/{guest_id}/checkout")
def checkout_guest(guest_id: str, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM guest_entries WHERE id=%s", (guest_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if row["status"] != "in":
                raise HTTPException(status_code=400, detail="Tamu sudah checkout")
            before = dict(row)
            now = utc_now_iso()
            checkout_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            cur.execute(
                "UPDATE guest_entries SET status='out', checkout_at=%s, updated_at=%s WHERE id=%s",
                (checkout_at, now, guest_id),
            )
            cur.execute("SELECT * FROM guest_entries WHERE id=%s", (guest_id,))
            after = dict(cur.fetchone())
            _audit(conn, sess, "guest_entries", str(guest_id), "checkout", before, after)
        conn.commit()
        return {"ok": True}


@app.get("/api/tasks")
def list_tasks(request: Request, q: str = ""):
    with db_connect() as conn:
        _require_session(conn, request)
        qn = normalize_text(q)
        where = []
        params: list[Any] = []
        if qn:
            where.append("(lower(t.kind) LIKE %s OR lower(t.destination) LIKE %s OR lower(t.notes) LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%", f"%{qn}%"])
        sql = """
          SELECT t.id, t.kind, t.occurred_at, t.destination, t.notes, u.display_name AS created_by_name, t.shift, t.post
          FROM task_entries t
          JOIN users u ON u.id = t.created_by
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY t.occurred_at DESC LIMIT 200"
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/tasks")
def create_task(body: CreateTaskBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        kind = (body.kind or "").strip() or "Lainnya"
        occurred = (body.occurred_at or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        dest = (body.destination or "").strip()
        notes = (body.notes or "").strip()
        if not dest:
            raise HTTPException(status_code=400, detail="Tujuan wajib diisi")
        now = utc_now_iso()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO task_entries(kind, occurred_at, destination, notes, created_by, shift, post, created_at, updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
                """,
                (kind, occurred, dest, notes, sess["user_id"], sess["shift"], sess["post"], now, now),
            )
            tid = int(cur.fetchone()[0])
            _audit(conn, sess, "task_entries", str(tid), "create", None, {"kind": kind, "occurred_at": occurred, "destination": dest, "notes": notes})
        conn.commit()
        return {"ok": True, "id": tid}


@app.get("/api/report/shift")
def report_shift(request: Request, date: str = "", shift: str = "", post: str = ""):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        if not date:
            date = datetime.now().strftime("%Y-%m-%d")
        start = f"{date}T00:00:00"
        end = f"{date}T23:59:59"
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(1) FROM key_transactions WHERE checkout_at BETWEEN %s AND %s", (start, end))
            key_total = int(cur.fetchone()[0] or 0)
            cur.execute("SELECT COUNT(1) FROM key_transactions WHERE status='open'")
            key_open = int(cur.fetchone()[0] or 0)
            cur.execute("SELECT COUNT(1) FROM guest_entries WHERE checkin_at BETWEEN %s AND %s", (start, end))
            guest_total = int(cur.fetchone()[0] or 0)
            cur.execute("SELECT COUNT(1) FROM task_entries WHERE occurred_at BETWEEN %s AND %s", (start, end))
            task_total = int(cur.fetchone()[0] or 0)
            cur.execute("SELECT COUNT(1) FROM mutasi_entries WHERE occurred_at BETWEEN %s AND %s", (start, end))
            mutasi_total = int(cur.fetchone()[0] or 0)
        return {
            "date": date,
            "shift": shift or sess["shift"],
            "post": post or sess["post"],
            "counts": {"keys_total": key_total, "keys_open": key_open, "guests_total": guest_total, "tasks_total": task_total, "mutasi_total": mutasi_total},
        }


@app.get("/api/audit/{record}")
def audit_record(record: str, request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        if ":" not in record:
            raise HTTPException(status_code=400, detail="Format audit salah")
        table_name, record_id = record.split(":", 1)
        table_name = normalize_text(table_name)
        record_id = record_id.strip()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT a.id, a.action, a.created_at, u.display_name AS actor_name, a.actor_shift, a.actor_post, a.before_json, a.after_json
                FROM audit_log a
                JOIN users u ON u.id = a.actor_user_id
                WHERE
                  CASE
                    WHEN %s = 'key_transactions' THEN a.target_key_transaction_id = CAST(%s AS BIGINT)
                    WHEN %s = 'guest_entries' THEN a.target_guest_entry_id = CAST(%s AS BIGINT)
                    WHEN %s = 'mutasi_entries' THEN a.target_mutasi_entry_id = CAST(%s AS BIGINT)
                    WHEN %s = 'task_entries' THEN a.target_task_entry_id = CAST(%s AS BIGINT)
                    WHEN %s = 'users' THEN a.target_user_id = CAST(%s AS BIGINT)
                    WHEN %s = 'auth' THEN a.target_user_id = CAST(%s AS BIGINT)
                    ELSE false
                  END
                ORDER BY a.id DESC
                LIMIT 50
                """,
                (table_name, record_id, table_name, record_id, table_name, record_id, table_name, record_id, table_name, record_id, table_name, record_id),
            )
            rows = cur.fetchall()
        items = []
        for r in rows:
            items.append(
                {
                    "id": int(r["id"]),
                    "action": r["action"],
                    "created_at": r["created_at"],
                    "actor_name": r["actor_name"],
                    "actor_shift": r["actor_shift"],
                    "actor_post": r["actor_post"],
                    "before": json.loads(r["before_json"]) if r["before_json"] else None,
                    "after": json.loads(r["after_json"]) if r["after_json"] else None,
                }
            )
        return {"items": items}


@app.get("/api/admin/users")
def admin_users(request: Request, q: str = ""):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        qn = normalize_text(q)
        where = []
        params: list[Any] = []
        if qn:
            where.append("(lower(username) LIKE %s OR lower(display_name) LIKE %s OR lower(role) LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%", f"%{qn}%"])
        sql = "SELECT id, username, display_name, role, is_active, created_at FROM users"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id ASC"
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/admin/users")
def admin_create_user(body: CreateUserBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        username = normalize_text(body.username)
        display_name = (body.display_name or "").strip()
        password = body.password or ""
        role = body.role
        if not username or not display_name:
            raise HTTPException(status_code=400, detail="Username dan nama wajib")
        if len(password) < 4:
            raise HTTPException(status_code=400, detail="Password minimal 4 karakter")
        now = utc_now_iso()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO users(username, display_name, password_hash, role, is_active, created_at) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                    (username, display_name, pbkdf2_hash_password(password), role, 1, now),
                )
                record_id = int(cur.fetchone()[0])
                _audit(
                    conn,
                    sess,
                    "users",
                    str(record_id),
                    "create",
                    None,
                    {"id": record_id, "username": username, "display_name": display_name, "role": role, "is_active": 1, "created_at": now},
                )
            conn.commit()
            return {"ok": True, "id": record_id}
        except psycopg2.IntegrityError:
            conn.rollback()
            raise HTTPException(status_code=409, detail="Username sudah dipakai")


@app.patch("/api/admin/users/{user_id}")
def admin_patch_user(user_id: str, body: PatchUserBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, username, display_name, role, is_active, created_at FROM users WHERE id=%s", (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="User tidak ditemukan")
            before = dict(row)
            updates: dict[str, Any] = {}
            if body.display_name is not None:
                dn = body.display_name.strip()
                if not dn:
                    raise HTTPException(status_code=400, detail="Nama tidak boleh kosong")
                updates["display_name"] = dn
            if body.role is not None:
                updates["role"] = body.role
            if body.is_active is not None:
                if body.is_active not in (0, 1):
                    raise HTTPException(status_code=400, detail="is_active tidak valid")
                updates["is_active"] = int(body.is_active)
            if not updates:
                return {"ok": True}
            cols = ", ".join([f"{k}=%s" for k in updates.keys()])
            params = list(updates.values()) + [user_id]
            cur.execute(f"UPDATE users SET {cols} WHERE id=%s", params)
            cur.execute("SELECT id, username, display_name, role, is_active, created_at FROM users WHERE id=%s", (user_id,))
            after = dict(cur.fetchone())
            _audit(conn, sess, "users", str(user_id), "update", before, after)
        conn.commit()
        return {"ok": True}


@app.post("/api/admin/users/{user_id}/reset_password")
def admin_reset_password(user_id: str, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, username, display_name, role, is_active FROM users WHERE id=%s", (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="User tidak ditemukan")
            temp_password = secrets.token_urlsafe(9)[:10]
            before = dict(row)
            cur.execute("UPDATE users SET password_hash=%s WHERE id=%s", (pbkdf2_hash_password(temp_password), user_id))
            after = {**before}
            _audit(conn, sess, "users", str(user_id), "reset_password", before, after)
        conn.commit()
        return {"ok": True, "temp_password": temp_password}


@app.get("/api/admin/audit")
def admin_audit(request: Request, q: str = "", table_name: str = "", record_id: str = "", limit: int = 100):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        qn = normalize_text(q)
        tn = normalize_text(table_name)
        rid = (record_id or "").strip()
        limit = max(1, min(200, int(limit or 100)))
        base = """
          SELECT
            a.id,
            CASE
              WHEN a.target_key_transaction_id IS NOT NULL THEN 'key_transactions'
              WHEN a.target_guest_entry_id IS NOT NULL THEN 'guest_entries'
              WHEN a.target_mutasi_entry_id IS NOT NULL THEN 'mutasi_entries'
              WHEN a.target_task_entry_id IS NOT NULL THEN 'task_entries'
              WHEN a.target_user_id IS NOT NULL THEN 'users'
              ELSE 'unknown'
            END AS table_name,
            COALESCE(a.target_key_transaction_id, a.target_guest_entry_id, a.target_mutasi_entry_id, a.target_task_entry_id, a.target_user_id) AS record_id,
            a.action, a.created_at,
            u.display_name AS actor_name, a.actor_shift, a.actor_post
          FROM audit_log a
          JOIN users u ON u.id = a.actor_user_id
        """
        filters = []
        params: list[Any] = []
        if tn:
            filters.append(
                "lower(CASE WHEN a.target_key_transaction_id IS NOT NULL THEN 'key_transactions' WHEN a.target_guest_entry_id IS NOT NULL THEN 'guest_entries' WHEN a.target_mutasi_entry_id IS NOT NULL THEN 'mutasi_entries' WHEN a.target_task_entry_id IS NOT NULL THEN 'task_entries' WHEN a.target_user_id IS NOT NULL THEN 'users' ELSE 'unknown' END) = %s"
            )
            params.append(tn)
        if rid:
            filters.append("COALESCE(a.target_key_transaction_id, a.target_guest_entry_id, a.target_mutasi_entry_id, a.target_task_entry_id, a.target_user_id) = CAST(%s AS BIGINT)")
            params.append(rid)
        if qn:
            filters.append("(lower(a.action) LIKE %s OR lower(u.display_name) LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%"])
        if filters:
            base += " WHERE " + " AND ".join(filters)
        base += " ORDER BY a.id DESC LIMIT %s"
        params.append(limit)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(base, tuple(params))
            rows = cur.fetchall()
        items = []
        for r in rows:
            items.append(
                {
                    "id": int(r["id"]),
                    "table_name": r["table_name"],
                    "record_id": str(r["record_id"]) if r["record_id"] is not None else "",
                    "action": r["action"],
                    "created_at": r["created_at"],
                    "actor_name": r["actor_name"],
                    "actor_shift": r["actor_shift"],
                    "actor_post": r["actor_post"],
                }
            )
        return {"items": items}


@app.get("/api/admin/security_history")
def admin_security_history(request: Request, user_id: str, limit: int = 120):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        uid = (user_id or "").strip()
        if not uid:
            raise HTTPException(status_code=400, detail="user_id wajib")
        limit = max(1, min(300, int(limit or 120)))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                  a.id,
                  CASE
                    WHEN a.target_key_transaction_id IS NOT NULL THEN 'key_transactions'
                    WHEN a.target_guest_entry_id IS NOT NULL THEN 'guest_entries'
                    WHEN a.target_mutasi_entry_id IS NOT NULL THEN 'mutasi_entries'
                    WHEN a.target_task_entry_id IS NOT NULL THEN 'task_entries'
                    WHEN a.target_user_id IS NOT NULL THEN 'users'
                    ELSE 'unknown'
                  END AS table_name,
                  COALESCE(a.target_key_transaction_id, a.target_guest_entry_id, a.target_mutasi_entry_id, a.target_task_entry_id, a.target_user_id) AS record_id,
                  a.action, a.created_at,
                  u.display_name AS actor_name, a.actor_shift, a.actor_post,
                  a.before_json, a.after_json
                FROM audit_log a
                JOIN users u ON u.id = a.actor_user_id
                WHERE a.actor_user_id = %s
                ORDER BY a.id DESC
                LIMIT %s
                """,
                (uid, limit),
            )
            rows = cur.fetchall()
        items = []
        for r in rows:
            items.append(
                {
                    "id": int(r["id"]),
                    "created_at": r["created_at"],
                    "actor_name": r["actor_name"],
                    "actor_shift": r["actor_shift"],
                    "actor_post": r["actor_post"],
                    "action": r["action"],
                    "table_name": r["table_name"],
                    "record_id": str(r["record_id"]) if r["record_id"] is not None else "",
                    "before": json.loads(r["before_json"]) if r["before_json"] else None,
                    "after": json.loads(r["after_json"]) if r["after_json"] else None,
                }
            )
        return {"items": items}


@app.delete("/api/admin/security_history")
def admin_delete_security_history(request: Request, user_id: str, keep: int = 0):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        uid = (user_id or "").strip()
        if not uid:
            raise HTTPException(status_code=400, detail="user_id wajib")
        keep = max(0, min(500, int(keep or 0)))
        with conn.cursor() as cur:
            if keep > 0:
                cur.execute(
                    """
                    DELETE FROM audit_log
                    WHERE actor_user_id = %s
                      AND id NOT IN (
                        SELECT id FROM audit_log
                        WHERE actor_user_id = %s
                        ORDER BY id DESC
                        LIMIT %s
                      )
                    """,
                    (uid, uid, keep),
                )
            else:
                cur.execute("DELETE FROM audit_log WHERE actor_user_id = %s", (uid,))
            deleted = int(cur.rowcount or 0)
        conn.commit()
        return {"ok": True, "deleted": deleted, "kept": keep}


@app.delete("/api/admin/records/{table_name}")
def admin_delete_record(table_name: str, request: Request, id: str, note: str = ""):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        allowed = {"key_transactions", "mutasi_entries", "guest_entries", "task_entries"}
        if table_name not in allowed:
            raise HTTPException(status_code=400, detail="Table tidak diizinkan")
        record_id = (id or "").strip()
        note = (note or "").strip()
        if not record_id:
            raise HTTPException(status_code=400, detail="id wajib")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if table_name == "key_transactions":
                cur.execute("SELECT * FROM key_transactions WHERE id=%s", (record_id,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Data tidak ditemukan")
                if row["status"] == "void":
                    return {"ok": True}
                before = dict(row)
                now = utc_now_iso()
                cur.execute("UPDATE key_transactions SET status='void', void_reason=%s, updated_at=%s WHERE id=%s", (note or f"void oleh admin {sess['user_id']}", now, record_id))
                cur.execute("SELECT * FROM key_transactions WHERE id=%s", (record_id,))
                after = dict(cur.fetchone())
                _audit(conn, sess, "key_transactions", str(record_id), "void", before, after)
                conn.commit()
                return {"ok": True, "mode": "void"}

            cur.execute(f"SELECT * FROM {table_name} WHERE id=%s", (record_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            before = dict(row)
            cur.execute(f"DELETE FROM {table_name} WHERE id=%s", (record_id,))
            _audit(conn, sess, table_name, str(record_id), "delete", before, {"note": note} if note else None)
        conn.commit()
        return {"ok": True, "mode": "deleted"}


@app.delete("/api/admin/users/{user_id}/delete")
def admin_delete_user(user_id: str, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        if str(user_id) == str(sess["user_id"]):
            raise HTTPException(status_code=400, detail="Tidak bisa menghapus akun sendiri")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, username, display_name, role, is_active, created_at FROM users WHERE id=%s", (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="User tidak ditemukan")
            before = dict(row)
            try:
                cur.execute("DELETE FROM users WHERE id=%s", (user_id,))
                _audit(conn, sess, "users", str(user_id), "delete", before, None)
                conn.commit()
                return {"ok": True, "mode": "deleted"}
            except psycopg2.IntegrityError:
                conn.rollback()
                with conn.cursor() as cur2:
                    cur2.execute("UPDATE users SET is_active=0 WHERE id=%s", (user_id,))
                    after = {**before, "is_active": 0}
                    _audit(conn, sess, "users", str(user_id), "deactivate", before, after)
                conn.commit()
                return {"ok": True, "mode": "deactivated"}

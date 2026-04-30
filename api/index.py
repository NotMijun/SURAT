import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from sys import stderr
from typing import Any, Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from dotenv import load_dotenv
from pydantic import BaseModel

_psycopg2_import_error: str | None = None
try:
    import psycopg2  # type: ignore
    import psycopg2.extras  # type: ignore
except Exception as e:
    psycopg2 = None  # type: ignore
    _psycopg2_import_error = repr(e)

SESSION_TTL_SECONDS = max(60, min(60 * 60 * 24, int(os.getenv("SESSION_TTL_SECONDS", 60 * 60 * 2))))
LOGIN_RATE_WINDOW_SECONDS = 10 * 60
LOGIN_RATE_MAX_ATTEMPTS = 8
MAX_PHOTO_BYTES = 3 * 1024 * 1024
DEDUPE_WINDOW_SECONDS = max(10, min(10 * 60, int(os.getenv("DEDUPE_WINDOW_SECONDS", 90))))
VOID_WINDOW_SECONDS = max(10, min(24 * 60 * 60, int(os.getenv("VOID_WINDOW_SECONDS", 10 * 60))))
KEY_REOPEN_WINDOW_SECONDS = max(10, min(24 * 60 * 60, int(os.getenv("KEY_REOPEN_WINDOW_SECONDS", 10 * 60))))

_schema_lock = threading.Lock()
_schema_ready = False
_users_has_password = False
_users_has_password_hash = True

app = FastAPI()
ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(dotenv_path=str(ROOT_DIR / ".env"), override=True)


@app.exception_handler(HTTPException)
async def _http_exception_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=int(exc.status_code), content={"error": str(exc.detail)})


@app.exception_handler(Exception)
async def _unhandled_exception_handler(_: Request, exc: Exception):
    traceback.print_exception(type(exc), exc, exc.__traceback__, file=stderr)
    if (os.getenv("DEBUG") or "").strip() == "1":
        return JSONResponse(status_code=500, content={"error": str(exc)})
    return JSONResponse(status_code=500, content={"error": "Kesalahan server"})


def _serve_root_file(name: str, content_type: str):
    file_path = ROOT_DIR / name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path=str(file_path), media_type=content_type)


@app.get("/")
def root_index():
    return _serve_root_file("index.html", "text/html; charset=utf-8")


@app.get("/app.html")
def root_app_html():
    return _serve_root_file("app.html", "text/html; charset=utf-8")


@app.get("/styles.css")
def root_styles():
    return _serve_root_file("styles.css", "text/css; charset=utf-8")


@app.get("/api/brand/logo.png")
def brand_logo():
    file_path = ROOT_DIR / "bshcrop.png"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Logo tidak ditemukan")
    return FileResponse(path=str(file_path), media_type="image/png")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_text(s: str) -> str:
    return " ".join((s or "").strip().lower().split())

def _day_bounds(date_str: str) -> tuple[str, str] | None:
    d = (date_str or "").strip()
    if len(d) != 10:
        return None
    if d[4] != "-" or d[7] != "-":
        return None
    y, m, day = d.split("-", 2)
    if not (y.isdigit() and m.isdigit() and day.isdigit()):
        return None
    return (f"{d}T00:00:00", f"{d}T23:59:59")


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


def _parse_truthy(v: Any) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    return s in ("1", "true", "yes", "y", "on")


def _recent_cutoff_iso(seconds: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=max(1, seconds))).isoformat(timespec="seconds")


def _can_quick_modify(sess: dict[str, Any], *, created_by: int, created_at_iso: str) -> bool:
    role = str(sess.get("role") or "")
    if role in ("admin", "supervisor"):
        return True
    if int(sess.get("user_id") or 0) != int(created_by):
        return False
    try:
        t = datetime.fromisoformat(str(created_at_iso).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).total_seconds() <= VOID_WINDOW_SECONDS
    except Exception:
        return True


def _text_field(value: Any, *, field: str, max_len: int, default: str = "") -> str:
    s = ("" if value is None else str(value)).strip()
    if not s:
        return default
    if len(s) > max_len:
        raise HTTPException(status_code=400, detail=f"{field} terlalu panjang")
    return s


def _iso_field(value: Any, *, field: str) -> str:
    s = ("" if value is None else str(value)).strip()
    if not s:
        return ""
    if len(s) > 32:
        raise HTTPException(status_code=400, detail=f"{field} tidak valid")
    try:
        datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field} tidak valid")
    return s


def _read_photo_upload(photo: UploadFile | None) -> tuple[str | None, str | None, str | None, str | None]:
    if not photo:
        return (None, None, None, None)
    ctype = (photo.content_type or "").strip().lower()
    if not ctype.startswith("image/"):
        raise HTTPException(status_code=400, detail="File foto harus berupa gambar (image/*)")
    data = photo.file.read()
    if not data:
        return (None, None, None, None)
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="Ukuran foto terlalu besar (maks 3MB)")
    b64 = base64.b64encode(data).decode("ascii")
    name = (photo.filename or "").strip() or "photo"
    return (b64, ctype, name, utc_now_iso())


_ATTACH_ALLOWED_TABLES = {"key_transactions", "guest_entries", "mutasi_entries", "task_entries"}

_ATTACH_TABLE_ALIASES = {
    "key_transaction": "key_transactions",
    "keys": "key_transactions",
    "kunci": "key_transactions",
    "guest": "guest_entries",
    "guests": "guest_entries",
    "tamu": "guest_entries",
    "mutasi": "mutasi_entries",
    "task": "task_entries",
    "tasks": "task_entries",
}


def _normalize_table_token(value: str) -> str:
    s = (value or "").strip().lower()
    if not s:
        return ""
    s = s.replace("-", "_")
    s = "_".join(s.split())
    while "__" in s:
        s = s.replace("__", "_")
    return s


def _attach_table_name(value: str) -> str:
    t = _normalize_table_token(value)
    if t in _ATTACH_ALLOWED_TABLES:
        return t
    mapped = _ATTACH_TABLE_ALIASES.get(t)
    if mapped and mapped in _ATTACH_ALLOWED_TABLES:
        return mapped
    raise HTTPException(status_code=400, detail="Target tidak valid")


def _attach_kind(value: Any) -> str:
    s = ("" if value is None else str(value)).strip()
    if not s:
        return "Foto"
    if len(s) > 40:
        raise HTTPException(status_code=400, detail="Jenis lampiran terlalu panjang")
    return s


def _attach_record_exists(conn, table: str, record_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute(f"SELECT 1 FROM {table} WHERE id=%s", (record_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Data tidak ditemukan")


def _add_attachments(conn, sess: dict[str, Any], table: str, record_id: int, photos: list[UploadFile], kinds: list[str]) -> int:
    if not photos:
        return 0
    if len(photos) > 6:
        raise HTTPException(status_code=413, detail="Maksimal 6 foto per entri")
    kind_list = [(_attach_kind(k) if k is not None else "Foto") for k in (kinds or [])]
    while len(kind_list) < len(photos):
        kind_list.append("Foto")
    now = utc_now_iso()
    inserted = 0
    with conn.cursor() as cur:
        for i, p in enumerate(photos):
            (b64, mime, name, uploaded_at) = _read_photo_upload(p)
            if not b64 or not mime or not name or not uploaded_at:
                continue
            cur.execute(
                """
                INSERT INTO media_attachments(target_table, target_id, kind, photo_b64, photo_mime, photo_name, photo_uploaded_at, created_by, created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (table, record_id, kind_list[i], b64, mime, name, uploaded_at, int(sess["user_id"]), now),
            )
            inserted += 1
    return inserted


def _database_url() -> str:
    pooler = (os.getenv("DATABASE_URL_POOLER") or "").strip()
    if pooler:
        return pooler

    url = (os.getenv("DATABASE_URL") or "").strip()
    if not url:
        raise HTTPException(status_code=500, detail="DATABASE_URL belum dikonfigurasi (set di environment atau file .env)")

    prefer_pooler = (os.getenv("PREFER_POOLER") or "1").strip() == "1"
    if prefer_pooler and "db." in url and ".supabase.co" in url and "pooler" not in url:
        raise HTTPException(
            status_code=500,
            detail="Isi DATABASE_URL_POOLER (Supabase Connection Pooler). Direct connection ke db.*.supabase.co tidak cocok untuk jaringan ini.",
        )
    return url


@contextmanager
def db_connect():
    if psycopg2 is None:
        hint = "Dependency psycopg2 tidak terpasang di environment server. Pastikan Vercel install requirements.txt untuk folder api/."
        if (os.getenv("DEBUG") or "").strip() == "1":
            raise HTTPException(status_code=500, detail=f"{hint} Detail: {_psycopg2_import_error}")
        raise HTTPException(status_code=500, detail=hint)
    hostaddr = (os.getenv("DATABASE_HOSTADDR") or "").strip()
    if hostaddr:
        conn = psycopg2.connect(_database_url(), connect_timeout=5, hostaddr=hostaddr)
    else:
        conn = psycopg2.connect(_database_url(), connect_timeout=5)
    try:
        _ensure_schema(conn)
        yield conn
    finally:
        conn.close()


def _ensure_schema(conn) -> None:
    global _schema_ready
    global _users_has_password
    global _users_has_password_hash
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
            cur.execute("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS display_name TEXT")
            cur.execute("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash TEXT")
            cur.execute("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT")
            cur.execute("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_active INTEGER")
            cur.execute("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TEXT")
            cur.execute(
                """
                DO $$
                BEGIN
                  IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='users' AND column_name='is_active' AND data_type='boolean'
                  ) THEN
                    ALTER TABLE public.users ALTER COLUMN is_active DROP DEFAULT;
                    ALTER TABLE public.users
                      ALTER COLUMN is_active TYPE INTEGER
                      USING (CASE WHEN is_active THEN 1 ELSE 0 END);
                  END IF;
                END $$;
                """
            )
            cur.execute("UPDATE public.users SET display_name = COALESCE(display_name, username) WHERE display_name IS NULL")
            cur.execute("UPDATE public.users SET role = COALESCE(role, 'admin') WHERE role IS NULL")
            cur.execute("UPDATE public.users SET is_active = COALESCE(is_active, 1) WHERE is_active IS NULL")
            cur.execute("ALTER TABLE public.users ALTER COLUMN role SET DEFAULT 'guard'")
            cur.execute("ALTER TABLE public.users ALTER COLUMN is_active SET DEFAULT 1")
            cur.execute(
                """
                DO $$
                BEGIN
                  IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='users' AND column_name='created_at'
                      AND data_type IN ('timestamp without time zone', 'timestamp with time zone')
                  ) THEN
                    UPDATE public.users SET created_at = COALESCE(created_at, now()) WHERE created_at IS NULL;
                    ALTER TABLE public.users ALTER COLUMN created_at SET DEFAULT now();
                  ELSE
                    UPDATE public.users SET created_at = COALESCE(created_at, (now() AT TIME ZONE 'utc')::text) WHERE created_at IS NULL;
                    ALTER TABLE public.users ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'utc')::text;
                  END IF;
                END $$;
                """
            )
            cur.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users'"
            )
            cols = {r[0] for r in cur.fetchall()}
            _users_has_password = "password" in cols
            _users_has_password_hash = "password_hash" in cols
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
                  photo_b64 TEXT,
                  photo_mime TEXT,
                  photo_name TEXT,
                  photo_uploaded_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("ALTER TABLE key_transactions ADD COLUMN IF NOT EXISTS photo_b64 TEXT")
            cur.execute("ALTER TABLE key_transactions ADD COLUMN IF NOT EXISTS photo_mime TEXT")
            cur.execute("ALTER TABLE key_transactions ADD COLUMN IF NOT EXISTS photo_name TEXT")
            cur.execute("ALTER TABLE key_transactions ADD COLUMN IF NOT EXISTS photo_uploaded_at TEXT")
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
                  photo_b64 TEXT,
                  photo_mime TEXT,
                  photo_name TEXT,
                  photo_uploaded_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("ALTER TABLE mutasi_entries ADD COLUMN IF NOT EXISTS photo_b64 TEXT")
            cur.execute("ALTER TABLE mutasi_entries ADD COLUMN IF NOT EXISTS photo_mime TEXT")
            cur.execute("ALTER TABLE mutasi_entries ADD COLUMN IF NOT EXISTS photo_name TEXT")
            cur.execute("ALTER TABLE mutasi_entries ADD COLUMN IF NOT EXISTS photo_uploaded_at TEXT")
            cur.execute("ALTER TABLE mutasi_entries ADD COLUMN IF NOT EXISTS status TEXT")
            cur.execute("ALTER TABLE mutasi_entries ADD COLUMN IF NOT EXISTS void_reason TEXT")
            cur.execute("ALTER TABLE mutasi_entries ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES users(id)")
            cur.execute("ALTER TABLE mutasi_entries ADD COLUMN IF NOT EXISTS voided_at TEXT")
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
                  paraf TEXT,
                  status TEXT NOT NULL CHECK (status IN ('in','out','void')),
                  created_by BIGINT NOT NULL REFERENCES users(id),
                  shift TEXT NOT NULL,
                  post TEXT NOT NULL,
                  void_reason TEXT,
                  voided_by BIGINT REFERENCES users(id),
                  voided_at TEXT,
                  photo_b64 TEXT,
                  photo_mime TEXT,
                  photo_name TEXT,
                  photo_uploaded_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS photo_b64 TEXT")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS photo_mime TEXT")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS photo_name TEXT")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS photo_uploaded_at TEXT")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS void_reason TEXT")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES users(id)")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS voided_at TEXT")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS destination_room TEXT")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS visitor_card_no TEXT")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS ktp_exchanged BOOLEAN")
            cur.execute("ALTER TABLE guest_entries ADD COLUMN IF NOT EXISTS paraf TEXT")
            cur.execute("ALTER TABLE guest_entries DROP CONSTRAINT IF EXISTS guest_entries_status_check")
            cur.execute("ALTER TABLE guest_entries ADD CONSTRAINT guest_entries_status_check CHECK (status IN ('in','out','void'))")
            cur.execute(
                """
                UPDATE guest_entries
                SET instansi=''
                WHERE (post='Pintu Utama' OR post='Lobby')
                  AND COALESCE(instansi,'') <> ''
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
                  photo_b64 TEXT,
                  photo_mime TEXT,
                  photo_name TEXT,
                  photo_uploaded_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS photo_b64 TEXT")
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS photo_mime TEXT")
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS photo_name TEXT")
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS photo_uploaded_at TEXT")
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS extra_json TEXT")
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS status TEXT")
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS void_reason TEXT")
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES users(id)")
            cur.execute("ALTER TABLE task_entries ADD COLUMN IF NOT EXISTS voided_at TEXT")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_task_occurred ON task_entries(occurred_at)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS key_master (
                  id BIGSERIAL PRIMARY KEY,
                  name TEXT NOT NULL UNIQUE,
                  name_norm TEXT NOT NULL UNIQUE,
                  is_active BOOLEAN NOT NULL DEFAULT TRUE,
                  created_by BIGINT REFERENCES users(id),
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_key_master_active ON key_master(is_active, name)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS room_master (
                  id BIGSERIAL PRIMARY KEY,
                  name TEXT NOT NULL UNIQUE,
                  name_norm TEXT NOT NULL UNIQUE,
                  is_active BOOLEAN NOT NULL DEFAULT TRUE,
                  created_by BIGINT REFERENCES users(id),
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_room_master_active ON room_master(is_active, name)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS pom_unit_master (
                  id BIGSERIAL PRIMARY KEY,
                  name TEXT NOT NULL UNIQUE,
                  name_norm TEXT NOT NULL UNIQUE,
                  sort_order INT NOT NULL DEFAULT 0,
                  is_active BOOLEAN NOT NULL DEFAULT TRUE,
                  created_by BIGINT REFERENCES users(id),
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_pom_unit_master_active ON pom_unit_master(is_active, sort_order, name)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS catering_vendors (
                  id BIGSERIAL PRIMARY KEY,
                  name TEXT NOT NULL UNIQUE,
                  name_norm TEXT NOT NULL UNIQUE,
                  created_by BIGINT REFERENCES users(id),
                  created_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_catering_vendors_norm ON catering_vendors(name_norm)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS pom_catering_sheets (
                  id BIGSERIAL PRIMARY KEY,
                  sheet_date TEXT NOT NULL UNIQUE,
                  staff_name TEXT,
                  data_json TEXT NOT NULL,
                  created_by BIGINT REFERENCES users(id),
                  updated_by BIGINT REFERENCES users(id),
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            cur.execute("ALTER TABLE pom_catering_sheets ADD COLUMN IF NOT EXISTS staff_name TEXT")
            cur.execute("ALTER TABLE pom_catering_sheets ADD COLUMN IF NOT EXISTS data_json TEXT")
            cur.execute("ALTER TABLE pom_catering_sheets ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id)")
            cur.execute("ALTER TABLE pom_catering_sheets ADD COLUMN IF NOT EXISTS updated_by BIGINT REFERENCES users(id)")
            cur.execute("ALTER TABLE pom_catering_sheets ADD COLUMN IF NOT EXISTS created_at TEXT")
            cur.execute("ALTER TABLE pom_catering_sheets ADD COLUMN IF NOT EXISTS updated_at TEXT")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_pom_catering_sheets_date ON pom_catering_sheets(sheet_date)")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS media_attachments (
                  id BIGSERIAL PRIMARY KEY,
                  target_table TEXT NOT NULL,
                  target_id BIGINT NOT NULL,
                  kind TEXT NOT NULL,
                  photo_b64 TEXT NOT NULL,
                  photo_mime TEXT NOT NULL,
                  photo_name TEXT NOT NULL,
                  photo_uploaded_at TEXT NOT NULL,
                  created_by BIGINT NOT NULL REFERENCES users(id),
                  created_at TEXT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_media_attachments_target ON media_attachments(target_table, target_id, id)")
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
        hashed = pbkdf2_hash_password(password)
        if _users_has_password:
            cur.execute(
                """
                INSERT INTO users(username, display_name, password, password_hash, role, is_active, created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (username)
                DO UPDATE SET display_name=EXCLUDED.display_name, password=EXCLUDED.password, password_hash=EXCLUDED.password_hash, role='admin', is_active=1
                """,
                (normalize_text(username), display_name, hashed, hashed, "admin", 1, utc_now_iso()),
            )
        else:
            cur.execute(
                """
                INSERT INTO users(username, display_name, password_hash, role, is_active, created_at)
                VALUES (%s,%s,%s,%s,%s,%s)
                ON CONFLICT (username)
                DO UPDATE SET display_name=EXCLUDED.display_name, password_hash=EXCLUDED.password_hash, role='admin', is_active=1
                """,
                (normalize_text(username), display_name, hashed, "admin", 1, utc_now_iso()),
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


def _delete_related_and_record(conn, table_name: str, record_id: int) -> dict[str, int]:
    allowed = {"key_transactions", "guest_entries", "mutasi_entries", "task_entries"}
    if table_name not in allowed:
        raise HTTPException(status_code=400, detail="Table tidak diizinkan")
    audit_col = {
        "key_transactions": "target_key_transaction_id",
        "guest_entries": "target_guest_entry_id",
        "mutasi_entries": "target_mutasi_entry_id",
        "task_entries": "target_task_entry_id",
    }.get(table_name)
    deleted_attach = 0
    deleted_audit = 0
    deleted_row = 0
    with conn.cursor() as cur:
        cur.execute("DELETE FROM media_attachments WHERE target_table=%s AND target_id=%s", (table_name, int(record_id)))
        deleted_attach = int(cur.rowcount or 0)
        if audit_col:
            cur.execute(f"DELETE FROM audit_log WHERE {audit_col}=%s", (int(record_id),))
            deleted_audit = int(cur.rowcount or 0)
        cur.execute(f"DELETE FROM {table_name} WHERE id=%s", (int(record_id),))
        deleted_row = int(cur.rowcount or 0)
    return {"attachments": deleted_attach, "audit": deleted_audit, "rows": deleted_row}


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
    petugas_id: int | None = None


class PatchKeyBody(BaseModel):
    borrower_name: str | None = None
    unit: str | None = None
    key_name: str | None = None
    notes: str | None = None


class PatchGuestBody(BaseModel):
    name: str | None = None
    instansi: str | None = None
    purpose: str | None = None
    meet_person: str | None = None
    checkin_at: str | None = None
    checkout_at: str | None = None
    notes: str | None = None
    paraf: str | None = None
    destination_room: str | None = None
    visitor_card_no: str | None = None
    ktp_exchanged: bool | None = None


class CreateMutasiBody(BaseModel):
    kind: str
    occurred_at: str
    description: str
    force: bool | None = None


class CreateGuestBody(BaseModel):
    name: str
    instansi: str | None = None
    purpose: str | None = None
    meet_person: str | None = None
    checkin_at: str | None = None
    notes: str | None = None
    paraf: str | None = None
    post: str | None = None
    force: bool | None = None
    destination_room: str | None = None
    visitor_card_no: str | None = None
    ktp_exchanged: bool | None = None


class PomCateringCellBody(BaseModel):
    jatah: int | None = None
    taken: int | None = None
    person: str | None = None
    note: str | None = None


class PomCateringRowBody(BaseModel):
    unit: str
    cell: PomCateringCellBody | None = None
    jatah: int | None = None
    taken: int | None = None
    person: str | None = None
    note: str | None = None


class SavePomCateringSheetBody(BaseModel):
    staff_name: str | None = None
    rows: list[PomCateringRowBody] | None = None
    total_boxes_in: int | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None


class CreateTaskBody(BaseModel):
    kind: str
    occurred_at: str
    destination: str
    notes: str
    extra: Any | None = None
    force: bool | None = None

class CreateCateringVendorBody(BaseModel):
    name: str

class PatchCateringVendorBody(BaseModel):
    name: str

class VoidBody(BaseModel):
    reason: str


class OptionalVoidBody(BaseModel):
    reason: str | None = None

class PatchTaskBody(BaseModel):
    destination: str | None = None
    notes: str | None = None
    extra: Any | None = None

class PatchMutasiBody(BaseModel):
    kind: str | None = None
    description: str | None = None

class CreateKeyMasterBody(BaseModel):
    name: str

class PatchKeyMasterBody(BaseModel):
    name: str | None = None
    is_active: bool | None = None


class CreateRoomMasterBody(BaseModel):
    name: str


class PatchRoomMasterBody(BaseModel):
    name: str | None = None
    is_active: bool | None = None


class CreatePomUnitBody(BaseModel):
    name: str
    sort_order: int | None = None


class PatchPomUnitBody(BaseModel):
    name: str | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class ResetDataBody(BaseModel):
    confirm: str | None = None


@app.get("/api/health")
def health():
    try:
        with db_connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1;")
                cur.fetchone()
        return {"ok": True, "message": "Backend hidup dan database tersambung"}
    except Exception as e:
        detail = str(e)
        hint = "Tidak bisa konek ke database. Host Supabase kamu resolve ke IPv6, tapi jaringan ini tidak punya koneksi IPv6 (network unreachable). Pakai Supabase Connection Pooler (isi DATABASE_URL_POOLER di .env / Vercel env), atau gunakan jaringan yang support IPv6."
        if (os.getenv("DEBUG") or "").strip() == "1":
            raise HTTPException(status_code=503, detail=f"{hint} Detail: {detail}")
        raise HTTPException(status_code=503, detail=hint)


@app.post("/api/login")
def login(body: LoginBody, request: Request):
    with db_connect() as conn:
        with conn.cursor() as cur:
            pw_expr = "COALESCE(password_hash, '')"
            if _users_has_password and _users_has_password_hash:
                pw_expr = "COALESCE(password_hash, password, '')"
            elif _users_has_password and not _users_has_password_hash:
                pw_expr = "COALESCE(password, '')"
            cur.execute(f"SELECT COUNT(1) FROM users WHERE {pw_expr} <> '' AND is_active = 1")
            user_count = int((cur.fetchone() or [0])[0] or 0)
        if user_count == 0 and not (os.getenv("BOOTSTRAP_ADMIN_PASSWORD") or "").strip():
            raise HTTPException(status_code=503, detail="Belum ada user. Set BOOTSTRAP_ADMIN_PASSWORD di environment/.env lalu restart backend untuk membuat admin pertama.")
        if _rate_limit_login(conn, request):
            raise HTTPException(status_code=429, detail="Terlalu banyak percobaan login. Coba lagi beberapa menit.")
        username = normalize_text(body.username or "")
        password = body.password or ""
        shift = (body.shift or "").strip() or "Pagi"
        post = (body.post or "").strip() or "IGD"
        if not username or not password:
            _record_login_attempt(conn, request, success=False)
            raise HTTPException(status_code=400, detail="Username dan password wajib diisi")

        fields = ["id", "username", "display_name", "role", "is_active"]
        if _users_has_password_hash:
            fields.append("password_hash")
        if _users_has_password:
            fields.append("password")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"SELECT {', '.join(fields)} FROM users WHERE username=%s", (username,))
            user = cur.fetchone()
            if not user or int(user["is_active"]) != 1:
                _record_login_attempt(conn, request, success=False)
                raise HTTPException(status_code=401, detail="Login gagal")
            stored = (user.get("password_hash") or "") if _users_has_password_hash else ""
            if not stored and _users_has_password:
                stored = user.get("password") or ""
            if not stored:
                _record_login_attempt(conn, request, success=False)
                raise HTTPException(status_code=401, detail="Login gagal")
            if not pbkdf2_verify_password(password, str(stored)):
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
        exp_ts = int(sess.get("expires_at") or 0)
        exp_iso = datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat(timespec="seconds") if exp_ts else None
        return {
            "user": {"id": int(sess["user_id"]), "username": sess["username"], "display_name": sess["display_name"], "role": sess["role"]},
            "shift": sess["shift"],
            "post": sess["post"],
            "session_ttl_seconds": SESSION_TTL_SECONDS,
            "session_expires_at": exp_ts,
            "session_expires_at_iso": exp_iso,
        }


@app.get("/api/guards")
def list_guards(request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, display_name FROM users WHERE is_active = 1 ORDER BY display_name ASC")
            rows = cur.fetchall()
        return {"items": rows}


@app.get("/api/vendors/catering")
def vendors_catering(request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name FROM catering_vendors ORDER BY name ASC")
            rows = cur.fetchall()
        if rows:
            return {"items": rows}
    raw = (os.getenv("CATERING_VENDORS") or "").strip()
    fallback = []
    seen: set[str] = set()
    for part in raw.split(","):
        name = part.strip()
        if not name or len(name) > 80:
            continue
        norm = normalize_text(name)
        if not norm or norm in seen:
            continue
        seen.add(norm)
        fallback.append({"id": None, "name": name})
    return {"items": fallback}


_POM_CATERING_UNITS_DEFAULT = [
    "Direktur",
    "Manajer Medis",
    "Sekretaris",
    "Div. Keu & Akt",
    "Div. TI",
    "Div. Umum",
    "Div. SDM",
    "Marketing",
    "Driver Operasional",
    "Rumah Tangga",
    "Pembelian",
    "IPCN",
    "Manajer Keperawatan",
    "CSSD",
    "Fisioterapi",
    "Pemeliharaan",
    "Dokter Umum",
    "Driver",
    "Laboratorium",
    "Gizi",
    "Farmasi",
    "Rekam medis",
    "Radiologi",
    "FO",
    "Kasir",
    "MCU",
    "Karyawan Baru",
    "Ranap Inap Lt 3 & P",
    "Ranap Inap Lt 2 & HD",
    "IKO, Endoskopi, Bedah",
    "IGD",
    "Poli",
    "ICU",
    "Bidan",
    "Perinatologi (NICU)",
    "Perinatologi (K. Bayi)",
    "Stock Opname",
    "Tim Casemix",
    "Kegiatan MCU (tambahan untuk vendor/radiologi dll)",
    "MPP",
]

def _pom_get_units(conn) -> list[str]:
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT name FROM pom_unit_master WHERE is_active=TRUE ORDER BY sort_order ASC, name ASC")
            rows = cur.fetchall()
        units: list[str] = []
        for r in rows or []:
            nm = str((r or {}).get("name") or "").strip()
            if nm and len(nm) <= 80:
                units.append(nm)
        if units:
            return units
    except Exception:
        pass
    return list(_POM_CATERING_UNITS_DEFAULT)


def _ymd_or_today(value: str) -> str:
    s = (value or "").strip()
    if not s:
        return datetime.now().strftime("%Y-%m-%d")
    if len(s) != 10 or s[4] != "-" or s[7] != "-":
        raise HTTPException(status_code=400, detail="Tanggal tidak valid")
    y, m, d = s.split("-", 2)
    if not (y.isdigit() and m.isdigit() and d.isdigit()):
        raise HTTPException(status_code=400, detail="Tanggal tidak valid")
    return s


def _pom_shift_key(value: str) -> str:
    s = normalize_text(value or "")
    if s.startswith("so"):
        return "sore"
    if s.startswith("ma"):
        return "malam"
    return "siang"


def _pom_cell(value: PomCateringCellBody | None) -> dict[str, Any]:
    v = value or PomCateringCellBody()
    jatah_raw = v.jatah if v.jatah is not None else 0
    taken_raw = v.taken if v.taken is not None else 0
    try:
        jatah = int(jatah_raw)
    except Exception:
        jatah = 0
    try:
        taken = int(taken_raw)
    except Exception:
        taken = 0
    jatah = max(0, min(9_999, jatah))
    taken = max(0, min(9_999, taken))
    person = _text_field(v.person, field="Penanggung jawab", max_len=80, default="")
    note = _text_field(v.note, field="Keterangan", max_len=120, default="")
    return {"jatah": jatah, "taken": taken, "person": person, "note": note}


def _pom_rows_normalized(rows: Any, units: list[str] | None = None) -> list[dict[str, Any]]:
    units_list = units or _POM_CATERING_UNITS_DEFAULT
    items: list[Any] = list(rows or []) if isinstance(rows, list) else []
    by_norm: dict[str, dict[str, Any]] = {}
    for r in items:
        if isinstance(r, PomCateringRowBody):
            unit = _text_field(r.unit, field="Unit", max_len=80, default="").strip()
            cell_src = r.cell or PomCateringCellBody(jatah=r.jatah, taken=r.taken, person=r.person, note=r.note)
            cell = _pom_cell(cell_src)
        else:
            unit = _text_field(str((r or {}).get("unit") or ""), field="Unit", max_len=80, default="").strip()
            raw = r or {}
            raw_cell = raw.get("cell")
            if isinstance(raw_cell, dict):
                cell = _pom_cell(PomCateringCellBody(jatah=raw_cell.get("jatah"), taken=raw_cell.get("taken"), person=raw_cell.get("person"), note=raw_cell.get("note")))
            else:
                has_flat = any(k in raw for k in ("jatah", "taken", "person", "note"))
                if has_flat:
                    cell = _pom_cell(PomCateringCellBody(jatah=raw.get("jatah"), taken=raw.get("taken"), person=raw.get("person"), note=raw.get("note")))
                else:
                    cell = _pom_cell(None)
        if not unit:
            continue
        key = normalize_text(unit)
        by_norm[key] = {
            "unit": unit,
            "jatah": cell["jatah"],
            "taken": cell["taken"],
            "person": cell["person"],
            "note": cell["note"],
        }
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for unit in units_list:
        key = normalize_text(unit)
        row = by_norm.get(key)
        if row is None:
            row = {"unit": unit, "jatah": 0, "taken": 0, "person": "", "note": ""}
        else:
            row["unit"] = unit
        result.append(row)
        seen.add(key)
    for key, row in by_norm.items():
        if key in seen:
            continue
        result.append(row)
    if not result:
        for unit in units_list:
            result.append({"unit": unit, "jatah": 0, "taken": 0, "person": "", "note": ""})
    return result


def _pom_total_boxes_in(value: Any) -> int:
    if value is None:
        return 0
    try:
        n = int(value)
    except Exception:
        n = 0
    return max(0, min(50_000, n))


def _pom_upgrade_legacy_data(row_db: dict[str, Any], parsed: dict[str, Any], fallback_staff: str, units: list[str] | None = None) -> dict[str, Any]:
    legacy_rows = parsed.get("rows")
    if not isinstance(legacy_rows, list):
        legacy_rows = []
    staff_name = (row_db.get("staff_name") or fallback_staff or "").strip()
    total_boxes_in = _pom_total_boxes_in(parsed.get("total_boxes_in"))
    blocks: dict[str, dict[str, Any]] = {}
    for shift_key in ("siang", "sore", "malam"):
        tmp: list[PomCateringRowBody] = []
        for r in legacy_rows:
            unit = str((r or {}).get("unit") or "").strip()
            if not unit:
                continue
            cell_src = (r or {}).get(shift_key) or {}
            qty = cell_src.get("qty")
            note = cell_src.get("note")
            cell = PomCateringCellBody(jatah=qty, taken=qty, person=None, note=note)
            tmp.append(PomCateringRowBody(unit=unit, cell=cell))
        rows_norm = _pom_rows_normalized(tmp or None, units)
        blocks[shift_key] = {
            "staff_name": staff_name,
            "vendor_id": None,
            "vendor_name": None,
            "total_boxes_in": total_boxes_in,
            "rows": rows_norm,
        }
    return blocks


def _pom_ensure_all_shifts(parsed: Any, default_staff: str, units: list[str] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    src = parsed if isinstance(parsed, dict) else {}
    for shift_key in ("siang", "sore", "malam"):
        block_raw = src.get(shift_key) if isinstance(src.get(shift_key), dict) else {}
        staff_name = str((block_raw.get("staff_name") or default_staff or "")).strip()
        rows_norm = _pom_rows_normalized(block_raw.get("rows"), units)
        total_boxes_in = _pom_total_boxes_in(block_raw.get("total_boxes_in"))
        vendor_id_raw = block_raw.get("vendor_id")
        try:
            vendor_id = int(vendor_id_raw) if vendor_id_raw is not None else None
        except Exception:
            vendor_id = None
        vendor_name_text = _text_field(block_raw.get("vendor_name"), field="Nama vendor", max_len=80, default="")
        vendor_name = vendor_name_text or None
        out[shift_key] = {
            "staff_name": staff_name,
            "vendor_id": vendor_id,
            "vendor_name": vendor_name,
            "total_boxes_in": total_boxes_in,
            "rows": rows_norm,
        }
    return out


def _pom_sheet_task_time(shift_key: str) -> str:
    if shift_key == "sore":
        return "16:00:00"
    if shift_key == "malam":
        return "21:00:00"
    return "11:00:00"


def _upsert_pom_sheet_task(conn, sess, sheet_date: str, shift_key: str, vendor_name: str | None, total_boxes_in: int, total_jatah: int, total_taken: int) -> None:
    occurred_at = f"{sheet_date}T{_pom_sheet_task_time(shift_key)}"
    extra = {
        "source": "sheet",
        "sheet_date": sheet_date,
        "sheet_shift": shift_key,
        "vendor": vendor_name,
        "vendor_name": vendor_name,
        "pom_status": "Selesai",
        "arrived_at": occurred_at,
        "box_count": int(total_boxes_in),
        "total_boxes_in": int(total_boxes_in),
        "total_jatah": int(total_jatah),
        "total_taken": int(total_taken),
    }
    extra_json = json.dumps(extra, ensure_ascii=False, separators=(",", ":"))
    now = utc_now_iso()
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT *
            FROM task_entries
            WHERE COALESCE(status,'active') <> 'void'
              AND lower(kind)=lower('Pom Catering')
              AND COALESCE(destination,'-')='-'
              AND COALESCE(extra_json,'') LIKE %s
              AND COALESCE(extra_json,'') LIKE %s
            ORDER BY occurred_at DESC
            LIMIT 1
            """,
            (f"%\"sheet_date\":\"{sheet_date}\"%", f"%\"sheet_shift\":\"{shift_key}\"%"),
        )
        existing = cur.fetchone()
        if existing:
            before = dict(existing)
            cur.execute(
                """
                UPDATE task_entries
                SET occurred_at=%s, notes=%s, extra_json=%s, updated_at=%s
                WHERE id=%s
                """,
                (occurred_at, "", extra_json, now, int(existing["id"])),
            )
            cur.execute("SELECT * FROM task_entries WHERE id=%s", (int(existing["id"]),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "task_entries", str(int(existing["id"])), "update", before, after)
            return
        cur.execute(
            """
            INSERT INTO task_entries(kind, occurred_at, destination, notes, extra_json, status, void_reason, voided_by, voided_at, created_by, shift, post, photo_b64, photo_mime, photo_name, photo_uploaded_at, created_at, updated_at)
            VALUES (%s,%s,%s,%s,%s,'active',NULL,NULL,NULL,%s,%s,%s,NULL,NULL,NULL,NULL,%s,%s)
            RETURNING id
            """,
            ("Pom Catering", occurred_at, "-", "", extra_json, int(sess["user_id"]), sess["shift"], sess["post"], now, now),
        )
        tid = int(cur.fetchone()["id"])
        _audit(conn, sess, "task_entries", str(tid), "create", None, {"kind": "Pom Catering", "occurred_at": occurred_at, "destination": "-", "notes": "", "extra": extra})


@app.get("/api/pom_catering/sheet")
def get_pom_catering_sheet(request: Request, date: str = "", shift: str = ""):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        d = _ymd_or_today(date)
        shift_key = _pom_shift_key(shift)
        default_staff = str(sess.get("display_name") or "")
        units = _pom_get_units(conn)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT sheet_date, staff_name, data_json, updated_at FROM pom_catering_sheets WHERE sheet_date=%s", (d,))
            row = cur.fetchone()
        updated_at = ""
        parsed_all: dict[str, Any] = {}
        if row:
            updated_at = row.get("updated_at") or ""
            data_raw = (row.get("data_json") or "").strip()
            if data_raw:
                try:
                    parsed_all = json.loads(data_raw)
                except Exception:
                    parsed_all = {}
            if isinstance(parsed_all.get("rows"), list):
                parsed_all = _pom_upgrade_legacy_data(row, parsed_all, default_staff or (row.get("staff_name") or ""), units)
            parsed_all = _pom_ensure_all_shifts(parsed_all, (row.get("staff_name") or default_staff), units)
        else:
            parsed_all = _pom_ensure_all_shifts({}, default_staff, units)
        block = parsed_all.get(shift_key) or {}
        staff_name = str((block.get("staff_name") or (row.get("staff_name") if row else "") or default_staff) or "").strip()
        rows_norm = _pom_rows_normalized(block.get("rows"), units)
        total_boxes_in = _pom_total_boxes_in(block.get("total_boxes_in"))
        vendor_id = block.get("vendor_id")
        vendor_name = block.get("vendor_name")
        return {
            "date": d,
            "shift": shift_key,
            "staff_name": staff_name,
            "rows": rows_norm,
            "total_boxes_in": total_boxes_in,
            "vendor_id": vendor_id,
            "vendor_name": vendor_name,
            "updated_at": updated_at,
        }


@app.post("/api/pom_catering/sheet")
def save_pom_catering_sheet(body: SavePomCateringSheetBody, request: Request, date: str = "", shift: str = ""):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        d = _ymd_or_today(date)
        shift_key = _pom_shift_key(shift)
        staff_name = _text_field(body.staff_name, field="Nama", max_len=80, default=str(sess.get("display_name") or "")).strip() or str(sess.get("display_name") or "")
        units = _pom_get_units(conn)
        rows_norm = _pom_rows_normalized(body.rows, units)
        if len(rows_norm) > 200:
            raise HTTPException(status_code=400, detail="Terlalu banyak baris unit")
        total_boxes_in = _pom_total_boxes_in(body.total_boxes_in)
        vendor_id: int | None = None
        vendor_name: str | None = None
        raw_vid = body.vendor_id
        if raw_vid is not None:
            try:
                vid_int = int(raw_vid)
            except Exception:
                vid_int = None
            if vid_int is not None:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute("SELECT id, name FROM catering_vendors WHERE id=%s", (vid_int,))
                    vrow = cur.fetchone()
                if vrow:
                    vendor_id = int(vrow["id"])
                    vendor_name = str(vrow["name"])
        if vendor_id is None and (body.vendor_name or "").strip():
            vendor_name = _text_field(body.vendor_name, field="Nama vendor", max_len=80, default="")
        now = utc_now_iso()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, data_json FROM pom_catering_sheets WHERE sheet_date=%s", (d,))
            row = cur.fetchone()
            if row:
                data_raw = (row.get("data_json") or "").strip()
                parsed_all: dict[str, Any] = {}
                if data_raw:
                    try:
                        parsed_all = json.loads(data_raw)
                    except Exception:
                        parsed_all = {}
                if isinstance(parsed_all.get("rows"), list):
                    parsed_all = _pom_upgrade_legacy_data(row, parsed_all, staff_name, units)
            else:
                parsed_all = {}
            parsed_all = _pom_ensure_all_shifts(parsed_all, staff_name, units)
            block = parsed_all.get(shift_key) or {}
            block["staff_name"] = staff_name
            block["rows"] = rows_norm
            block["total_boxes_in"] = total_boxes_in
            block["vendor_id"] = vendor_id
            block["vendor_name"] = vendor_name
            parsed_all[shift_key] = block
            data_json = json.dumps(parsed_all, ensure_ascii=False, separators=(",", ":"))
            if row:
                cur.execute(
                    """
                    UPDATE pom_catering_sheets
                    SET staff_name=%s, data_json=%s, updated_by=%s, updated_at=%s
                    WHERE sheet_date=%s
                    """,
                    (staff_name, data_json, int(sess["user_id"]), now, d),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO pom_catering_sheets(sheet_date, staff_name, data_json, created_by, updated_by, created_at, updated_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (d, staff_name, data_json, int(sess["user_id"]), int(sess["user_id"]), now, now),
                )
        total_jatah = 0
        total_taken = 0
        for r in rows_norm:
            try:
                total_jatah += int(r.get("jatah") or 0)
            except Exception:
                pass
            try:
                total_taken += int(r.get("taken") or 0)
            except Exception:
                pass
        _upsert_pom_sheet_task(conn, sess, d, shift_key, vendor_name, total_boxes_in, int(total_jatah), int(total_taken))
        conn.commit()
        return {"ok": True, "date": d, "shift": shift_key, "updated_at": now}


@app.get("/api/pom_catering/history")
def pom_catering_history(request: Request, limit: int = 60):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        default_staff = str(sess.get("display_name") or "")
        units = _pom_get_units(conn)
        limit_n = max(1, min(365, int(limit or 60)))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT sheet_date, staff_name, data_json, updated_at
                FROM pom_catering_sheets
                ORDER BY sheet_date DESC
                LIMIT %s
                """,
                (limit_n,),
            )
            rows = cur.fetchall()

        items: list[dict[str, Any]] = []
        for row in rows or []:
            d = str(row.get("sheet_date") or "").strip()
            updated_at = str(row.get("updated_at") or "").strip()
            data_raw = str((row.get("data_json") or "")).strip()
            parsed_all: dict[str, Any] = {}
            if data_raw:
                try:
                    parsed_all = json.loads(data_raw)
                except Exception:
                    parsed_all = {}
            if isinstance(parsed_all.get("rows"), list):
                parsed_all = _pom_upgrade_legacy_data(row, parsed_all, default_staff or (row.get("staff_name") or ""), units)
            parsed_all = _pom_ensure_all_shifts(parsed_all, (row.get("staff_name") or default_staff), units)
            for shift_key in ("siang", "sore", "malam"):
                block = parsed_all.get(shift_key) or {}
                vendor_name = block.get("vendor_name")
                total_boxes_in = _pom_total_boxes_in(block.get("total_boxes_in"))
                rows_norm = _pom_rows_normalized(block.get("rows"), units)
                total_jatah = 0
                total_taken = 0
                for r in rows_norm:
                    try:
                        total_jatah += int(r.get("jatah") or 0)
                    except Exception:
                        pass
                    try:
                        total_taken += int(r.get("taken") or 0)
                    except Exception:
                        pass
                items.append(
                    {
                        "date": d,
                        "shift": shift_key,
                        "vendor_name": vendor_name,
                        "total_boxes_in": total_boxes_in,
                        "total_jatah": int(total_jatah),
                        "total_taken": int(total_taken),
                        "updated_at": updated_at,
                    }
                )
        return {"items": items}


@app.post("/api/logout")
def logout(request: Request):
    with db_connect() as conn:
        token = _get_token(request)
        if token:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM sessions WHERE id=%s", (token,))
            conn.commit()
    return {"ok": True}

@app.post("/api/logout_all")
def logout_all(request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM sessions WHERE user_id=%s", (int(sess["user_id"]),))
            deleted = int(cur.rowcount or 0)
        conn.commit()
        return {"ok": True, "deleted": deleted}


@app.get("/api/handover")
def handover(request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT COUNT(*)::int AS c FROM key_transactions WHERE status='open'")
            open_keys_count = int(cur.fetchone()["c"])
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
            cur.execute("SELECT COUNT(*)::int AS c FROM guest_entries WHERE status='in' AND (post='IGD' OR post='Pintu Utama' OR post='Lobby')")
            guests_in_count = int(cur.fetchone()["c"])
            cur.execute(
                """
                SELECT id, name, instansi, purpose, meet_person, checkin_at, status
                FROM guest_entries
                WHERE status='in'
                  AND (post='IGD' OR post='Pintu Utama' OR post='Lobby')
                ORDER BY checkin_at DESC
                LIMIT 50
                """
            )
            guests_in = cur.fetchall()
        return {"open_keys": keys_open, "open_keys_count": open_keys_count, "guests_in": guests_in, "guests_in_count": guests_in_count}


@app.get("/api/keys/master")
def list_key_master(request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name FROM key_master WHERE is_active=TRUE ORDER BY name ASC")
            rows = cur.fetchall()
        return {"items": rows}


@app.get("/api/rooms/master")
def list_room_master(request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name FROM room_master WHERE is_active=TRUE ORDER BY name ASC")
            rows = cur.fetchall()
        return {"items": rows}


@app.get("/api/keys")
def list_keys(
    request: Request,
    status: str = "open",
    q: str = "",
    date: str = "",
    date_field: str = "checkout",
    sort: str = "checkout_desc",
    limit: int = 200,
    offset: int = 0,
):
    with db_connect() as conn:
        _require_session(conn, request)
        status = (status or "open").strip()
        qn = normalize_text(q)
        bounds = _day_bounds(date)
        date_field = (date_field or "checkout").strip().lower()
        if status == "open":
            date_field = "checkout"
        if date_field not in ("checkout", "checkin"):
            date_field = "checkout"
        sort = (sort or "checkout_desc").strip()
        limit = max(1, min(500, int(limit or 200)))
        offset = max(0, min(100_000, int(offset or 0)))
        where = []
        params: list[Any] = []
        if status in ("open", "closed", "void"):
            where.append("kt.status = %s")
            params.append(status)
        if qn:
            where.append("(kt.borrower_name_norm LIKE %s OR kt.key_name_norm LIKE %s OR kt.checkout_at LIKE %s OR kt.checkin_at LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%", f"%{qn}%", f"%{qn}%"])
        if bounds:
            date_col = "kt.checkout_at" if date_field == "checkout" else "kt.checkin_at"
            where.append(f"{date_col} BETWEEN %s AND %s")
            params.extend([bounds[0], bounds[1]])
        order = "kt.checkout_at DESC"
        if sort == "checkout_asc":
            order = "kt.checkout_at ASC"
        elif sort == "checkin_desc":
            order = "kt.checkin_at DESC NULLS LAST"
        elif sort == "checkin_asc":
            order = "kt.checkin_at ASC NULLS LAST"
        sql = """
          SELECT kt.id, kt.borrower_name, kt.unit, kt.key_name, kt.checkout_at, kt.checkin_at, kt.notes, kt.status, kt.void_reason,
                 (CASE WHEN kt.photo_b64 IS NULL OR kt.photo_b64='' THEN 0 ELSE 1 END + COALESCE(att.c,0))::int AS photo_count,
                 kt.created_by, kt.created_at,
                 u.display_name AS created_by_name,
                 u2.display_name AS closed_by_name,
                 kt.created_shift, kt.created_post, kt.closed_shift, kt.closed_post
          FROM key_transactions kt
          JOIN users u ON u.id = kt.created_by
          LEFT JOIN users u2 ON u2.id = kt.closed_by
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS c
            FROM media_attachments ma
            WHERE ma.target_table='key_transactions' AND ma.target_id=kt.id
          ) att ON true
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY {order} LIMIT %s OFFSET %s"
        params.append(limit)
        params.append(offset)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        for r in rows:
            r["photo_count"] = int(r.get("photo_count") or 0)
            r["has_photo"] = r["photo_count"] > 0
            if r["has_photo"]:
                r["photo_url"] = f"/api/keys/{int(r['id'])}/photo"
        return {"items": rows}


@app.get("/api/keys/{key_id}/photo")
def get_key_photo(key_id: str, request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT photo_b64, photo_mime, photo_name FROM key_transactions WHERE id=%s", (key_id,))
            row = cur.fetchone()
            if row and (row.get("photo_b64") or ""):
                data = base64.b64decode((row["photo_b64"] or "").encode("ascii"))
                mime = (row.get("photo_mime") or "application/octet-stream").strip()
                name = (row.get("photo_name") or "photo").strip()
                headers = {"Content-Disposition": f'inline; filename="{name}"'}
                return Response(content=data, media_type=mime, headers=headers)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT photo_b64, photo_mime, photo_name FROM media_attachments WHERE target_table='key_transactions' AND target_id=%s ORDER BY id ASC LIMIT 1",
                (key_id,),
            )
            a = cur.fetchone()
            if not a or not (a.get("photo_b64") or ""):
                raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
            data = base64.b64decode((a["photo_b64"] or "").encode("ascii"))
            mime = (a.get("photo_mime") or "application/octet-stream").strip()
            name = (a.get("photo_name") or "photo").strip()
            headers = {"Content-Disposition": f'inline; filename="{name}"'}
            return Response(content=data, media_type=mime, headers=headers)


@app.get("/api/attachments/{table_name}/{record_id}")
def list_attachments(table_name: str, record_id: str, request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        t = _attach_table_name(table_name)
        try:
            rid = int(record_id)
        except Exception:
            raise HTTPException(status_code=400, detail="record_id tidak valid")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, kind, photo_name, photo_uploaded_at, created_at
                FROM media_attachments
                WHERE target_table=%s AND target_id=%s
                ORDER BY id ASC
                """,
                (t, rid),
            )
            rows = cur.fetchall() or []
        items = []
        for r in rows:
            items.append(
                {
                    "id": int(r["id"]),
                    "kind": r.get("kind") or "Foto",
                    "photo_name": r.get("photo_name") or "photo",
                    "uploaded_at": r.get("photo_uploaded_at") or r.get("created_at") or "",
                    "url": f"/api/attachments/{int(r['id'])}/blob",
                }
            )
        return {"items": items}


@app.get("/api/attachments/{attachment_id}/blob")
def get_attachment_blob(attachment_id: str, request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        try:
            aid = int(attachment_id)
        except Exception:
            raise HTTPException(status_code=400, detail="attachment_id tidak valid")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT photo_b64, photo_mime, photo_name FROM media_attachments WHERE id=%s", (aid,))
            row = cur.fetchone()
            if not row or not (row.get("photo_b64") or ""):
                raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
            data = base64.b64decode((row["photo_b64"] or "").encode("ascii"))
            mime = (row.get("photo_mime") or "application/octet-stream").strip()
            name = (row.get("photo_name") or "photo").strip()
            headers = {"Content-Disposition": f'inline; filename="{name}"'}
            return Response(content=data, media_type=mime, headers=headers)


@app.post("/api/attachments/{table_name}/{record_id}")
def add_attachments(
    table_name: str,
    record_id: str,
    request: Request,
    kind: list[str] = Form([]),
    photos: list[UploadFile] = File(...),
):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        t = _attach_table_name(table_name)
        try:
            rid = int(record_id)
        except Exception:
            raise HTTPException(status_code=400, detail="record_id tidak valid")
        _attach_record_exists(conn, t, rid)
        inserted = _add_attachments(conn, sess, t, rid, photos, kind)
        conn.commit()
        return {"ok": True, "inserted": inserted}


def _create_key_tx(
    conn,
    sess,
    borrower_name: str | None,
    unit: str | None,
    key_name: str,
    checkout_at: str | None,
    notes: str | None,
    force: bool,
    petugas_id: int | None,
    photo_b64: str | None,
    photo_mime: str | None,
    photo_name: str | None,
    photo_uploaded_at: str | None,
) -> int:
    borrower_name = _text_field(borrower_name, field="Nama penitip", max_len=80, default="Tidak diketahui")
    unit = _text_field(unit, field="Unit/Divisi", max_len=80, default="-")
    key_name = _text_field(key_name, field="Kunci/ruangan", max_len=80, default="")
    notes = _text_field(notes, field="Catatan", max_len=240, default="")
    checkout_at = _iso_field(checkout_at, field="Waktu titip") or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    if not key_name:
        raise HTTPException(status_code=400, detail="Kunci/ruangan wajib diisi")
    key_norm = normalize_text(key_name)
    borrower_norm = normalize_text(borrower_name)
    
    created_by_id = sess["user_id"]
    if petugas_id is not None:
        created_by_id = petugas_id

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT id, borrower_name, unit, key_name, checkout_at FROM key_transactions WHERE status='open' AND key_name_norm=%s",
            (key_norm,),
        )
        existing_open = cur.fetchone()
        if existing_open and not force:
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
        if recent_dup and not force:
            raise HTTPException(status_code=409, detail=f"Transaksi serupa sudah ada (ID {recent_dup['id']}).")

        now = utc_now_iso()
        cur.execute(
            """
            INSERT INTO key_transactions(
              borrower_name, borrower_name_norm, unit, key_name, key_name_norm, checkout_at, checkin_at, notes, status,
              created_by, created_shift, created_post, photo_b64, photo_mime, photo_name, photo_uploaded_at, created_at, updated_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
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
                created_by_id,
                sess["shift"],
                sess["post"],
                photo_b64,
                photo_mime,
                photo_name,
                photo_uploaded_at,
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
            {
                "borrower_name": borrower_name,
                "unit": unit,
                "key_name": key_name,
                "checkout_at": checkout_at,
                "notes": notes,
                "status": "open",
                "has_photo": bool(photo_b64),
                "photo_name": photo_name if photo_b64 else None,
            },
        )
    return record_id



@app.post("/api/keys")
def create_key(body: CreateKeyBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        record_id = _create_key_tx(
            conn,
            sess,
            body.borrower_name,
            body.unit,
            body.key_name,
            body.checkout_at,
            body.notes,
            bool(body.force),
            body.petugas_id,
            None,
            None,
            None,
            None,
        )
        conn.commit()
        return {"ok": True, "id": record_id}

@app.post("/api/keys_with_photo")
def create_key_with_photo(
    request: Request,
    key_name: str = Form(...),
    borrower_name: str | None = Form(None),
    unit: str | None = Form(None),
    checkout_at: str | None = Form(None),
    notes: str | None = Form(None),
    force: str | None = Form(None),
    petugas_id: str | None = Form(None),
    photo: UploadFile | None = File(None),
):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        (photo_b64, photo_mime, photo_name, photo_uploaded_at) = _read_photo_upload(photo)
        
        petugas_id_int = None
        if petugas_id and petugas_id.strip():
            try:
                petugas_id_int = int(petugas_id)
            except ValueError:
                pass
                
        record_id = _create_key_tx(
            conn,
            sess,
            borrower_name,
            unit,
            key_name,
            checkout_at,
            notes,
            _parse_truthy(force),
            petugas_id_int,
            photo_b64,
            photo_mime,
            photo_name,
            photo_uploaded_at,
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


@app.post("/api/keys/{key_id}/undo")
def undo_key(key_id: str, request: Request, body: OptionalVoidBody | None = None):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM key_transactions WHERE id=%s", (key_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if row["status"] != "open":
                raise HTTPException(status_code=400, detail="Hanya transaksi open yang bisa di-undo")
            if sess.get("role") not in ("admin", "supervisor") and int(row.get("created_by") or 0) != int(sess["user_id"]):
                raise HTTPException(status_code=403, detail="Tidak punya akses undo")
            _delete_related_and_record(conn, "key_transactions", int(key_id))
        conn.commit()
        return {"ok": True}


@app.post("/api/keys/{key_id}/delete")
def delete_key(key_id: str, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM key_transactions WHERE id=%s", (key_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses delete")
            _delete_related_and_record(conn, "key_transactions", int(key_id))
        conn.commit()
        return {"ok": True}


@app.post("/api/keys/{key_id}/void")
def void_key_compat(key_id: str, body: VoidBody, request: Request):
    return delete_key(key_id=key_id, request=request)


@app.post("/api/keys/{key_id}/reopen")
def reopen_key(key_id: str, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM key_transactions WHERE id=%s", (key_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if row["status"] != "closed":
                raise HTTPException(status_code=400, detail="Hanya transaksi closed yang bisa di-undo ambil")
            closed_by = int(row.get("closed_by") or 0)
            if sess.get("role") not in ("admin", "supervisor"):
                if int(sess["user_id"]) != closed_by:
                    raise HTTPException(status_code=403, detail="Tidak punya akses undo ambil")
                checkin_at = (row.get("checkin_at") or "").strip()
                allow = True
                try:
                    t = datetime.fromisoformat(checkin_at.replace("Z", "+00:00"))
                    if t.tzinfo is None:
                        allow = (datetime.now() - t).total_seconds() <= KEY_REOPEN_WINDOW_SECONDS
                    else:
                        allow = (datetime.now(timezone.utc) - t.astimezone(timezone.utc)).total_seconds() <= KEY_REOPEN_WINDOW_SECONDS
                except Exception:
                    allow = True
                if not allow:
                    raise HTTPException(status_code=400, detail="Undo ambil sudah melewati batas waktu")
            key_norm = str(row.get("key_name_norm") or "")
            cur.execute(
                "SELECT id FROM key_transactions WHERE status='open' AND key_name_norm=%s AND id<>%s LIMIT 1",
                (key_norm, key_id),
            )
            conflict = cur.fetchone()
            if conflict:
                raise HTTPException(status_code=409, detail="Tidak bisa undo ambil: ada transaksi open lain untuk kunci yang sama")
            before = dict(row)
            now = utc_now_iso()
            cur.execute(
                """
                UPDATE key_transactions
                SET status='open',
                    checkin_at=NULL,
                    closed_by=NULL,
                    closed_shift=NULL,
                    closed_post=NULL,
                    updated_at=%s
                WHERE id=%s
                """,
                (now, key_id),
            )
            cur.execute("SELECT * FROM key_transactions WHERE id=%s", (key_id,))
            after = dict(cur.fetchone())
            _audit(conn, sess, "key_transactions", str(key_id), "reopen", before, after)
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
            if row["status"] == "void":
                raise HTTPException(status_code=400, detail="Data sudah void")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses edit")
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
def list_mutasi(request: Request, q: str = "", kategori: str = "", sub: str = "", date: str = "", sort: str = "occurred_desc", limit: int = 200, status: str = "active", offset: int = 0):
    with db_connect() as conn:
        _require_session(conn, request)
        qn = normalize_text(q)
        kat = _text_field(kategori, field="Kategori", max_len=60, default="")
        subk = _text_field(sub, field="Sub-kategori", max_len=60, default="")
        bounds = _day_bounds(date)
        sort = (sort or "occurred_desc").strip()
        limit = max(1, min(500, int(limit or 200)))
        offset = max(0, min(100_000, int(offset or 0)))
        status = (status or "active").strip().lower()
        where = []
        params: list[Any] = []
        if status in ("active", "void"):
            where.append("COALESCE(m.status,'active') = %s")
            params.append(status)
        elif status != "all":
            where.append("COALESCE(m.status,'active') <> 'void'")
        if qn:
            where.append("(lower(kind) LIKE %s OR lower(description) LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%"])
        if kat and subk:
            if subk == "Lainnya":
                where.append("m.kind = %s")
                params.append(kat)
            else:
                where.append("m.kind = %s")
                params.append(f"{kat} - {subk}")
        elif kat:
            where.append("m.kind LIKE %s")
            params.append(f"{kat}%")
            if subk:
                where.append("m.kind LIKE %s")
                params.append(f"%{subk}%")
        elif subk:
            where.append("m.kind LIKE %s")
            params.append(f"%{subk}%")
        if bounds:
            where.append("m.occurred_at BETWEEN %s AND %s")
            params.extend([bounds[0], bounds[1]])
        order = "m.occurred_at DESC"
        if sort == "occurred_asc":
            order = "m.occurred_at ASC"
        sql = """
          SELECT m.id, m.occurred_at, m.kind, m.description,
                 COALESCE(m.status,'active') AS status,
                 m.void_reason,
                 (CASE WHEN m.photo_b64 IS NULL OR m.photo_b64='' THEN 0 ELSE 1 END + COALESCE(att.c,0))::int AS photo_count,
                 u.display_name AS created_by_name, m.shift, m.post
          FROM mutasi_entries m
          JOIN users u ON u.id = m.created_by
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS c
            FROM media_attachments ma
            WHERE ma.target_table='mutasi_entries' AND ma.target_id=m.id
          ) att ON true
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY {order} LIMIT %s OFFSET %s"
        params.append(limit)
        params.append(offset)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        for r in rows:
            r["photo_count"] = int(r.get("photo_count") or 0)
            r["has_photo"] = r["photo_count"] > 0
            if r["has_photo"]:
                r["photo_url"] = f"/api/mutasi/{int(r['id'])}/photo"
        return {"items": rows}


@app.get("/api/mutasi/{mutasi_id}/photo")
def get_mutasi_photo(mutasi_id: str, request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT photo_b64, photo_mime, photo_name FROM mutasi_entries WHERE id=%s", (mutasi_id,))
            row = cur.fetchone()
            if row and (row.get("photo_b64") or ""):
                data = base64.b64decode((row["photo_b64"] or "").encode("ascii"))
                mime = (row.get("photo_mime") or "application/octet-stream").strip()
                name = (row.get("photo_name") or "photo").strip()
                headers = {"Content-Disposition": f'inline; filename="{name}"'}
                return Response(content=data, media_type=mime, headers=headers)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT photo_b64, photo_mime, photo_name FROM media_attachments WHERE target_table='mutasi_entries' AND target_id=%s ORDER BY id ASC LIMIT 1",
                (mutasi_id,),
            )
            a = cur.fetchone()
            if not a or not (a.get("photo_b64") or ""):
                raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
            data = base64.b64decode((a["photo_b64"] or "").encode("ascii"))
            mime = (a.get("photo_mime") or "application/octet-stream").strip()
            name = (a.get("photo_name") or "photo").strip()
            headers = {"Content-Disposition": f'inline; filename="{name}"'}
            return Response(content=data, media_type=mime, headers=headers)


def _create_mutasi(
    conn,
    sess,
    kind: str | None,
    occurred_at: str | None,
    description: str | None,
    force: bool,
    photo_b64: str | None,
    photo_mime: str | None,
    photo_name: str | None,
    photo_uploaded_at: str | None,
) -> int:
    kind = (kind or "").strip() or "Lainnya"
    occurred = (occurred_at or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    desc = (description or "").strip()
    if not desc:
        raise HTTPException(status_code=400, detail="Deskripsi wajib diisi")
    now = utc_now_iso()
    with conn.cursor() as cur:
        if not force:
            cutoff = _recent_cutoff_iso(DEDUPE_WINDOW_SECONDS)
            cur.execute(
                """
                SELECT id, created_at
                FROM mutasi_entries
                WHERE COALESCE(status,'active') <> 'void'
                  AND lower(kind)=lower(%s)
                  AND lower(description)=lower(%s)
                  AND occurred_at=%s
                  AND created_at > %s
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (kind, desc, occurred, cutoff),
            )
            dup = cur.fetchone()
            if dup:
                raise HTTPException(status_code=409, detail=f"Data serupa sudah ada (ID {int(dup[0])}).")
        cur.execute(
            """
            INSERT INTO mutasi_entries(occurred_at, kind, description, created_by, shift, post, status, void_reason, voided_by, voided_at, photo_b64, photo_mime, photo_name, photo_uploaded_at, created_at, updated_at)
            VALUES (%s,%s,%s,%s,%s,%s,'active',NULL,NULL,NULL,%s,%s,%s,%s,%s,%s)
            RETURNING id
            """,
            (occurred, kind, desc, sess["user_id"], sess["shift"], sess["post"], photo_b64, photo_mime, photo_name, photo_uploaded_at, now, now),
        )
        mid = int(cur.fetchone()[0])
        _audit(
            conn,
            sess,
            "mutasi_entries",
            str(mid),
            "create",
            None,
            {"occurred_at": occurred, "kind": kind, "description": desc, "has_photo": bool(photo_b64), "photo_name": photo_name if photo_b64 else None},
        )
    return mid



@app.post("/api/mutasi")
def create_mutasi(body: CreateMutasiBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        mid = _create_mutasi(conn, sess, body.kind, body.occurred_at, body.description, bool(body.force), None, None, None, None)
        conn.commit()
        return {"ok": True, "id": mid}

@app.post("/api/mutasi_with_photo")
def create_mutasi_with_photo(
    request: Request,
    kind: str = Form(...),
    occurred_at: str | None = Form(None),
    description: str = Form(...),
    force: str | None = Form(None),
    photo: UploadFile | None = File(None),
):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        (photo_b64, photo_mime, photo_name, photo_uploaded_at) = _read_photo_upload(photo)
        mid = _create_mutasi(conn, sess, kind, occurred_at, description, _parse_truthy(force), photo_b64, photo_mime, photo_name, photo_uploaded_at)
        conn.commit()
        return {"ok": True, "id": mid}


@app.patch("/api/mutasi/{mutasi_id}")
def patch_mutasi(mutasi_id: int, body: PatchMutasiBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM mutasi_entries WHERE id=%s", (int(mutasi_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if str(row.get("status") or "active") == "void":
                raise HTTPException(status_code=400, detail="Data sudah void")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses edit")
            before = dict(row)
            updates: dict[str, Any] = {}
            if body.kind is not None:
                updates["kind"] = _text_field(body.kind, field="Jenis", max_len=80, default="Lainnya") or "Lainnya"
            if body.description is not None:
                desc = (body.description or "").strip()
                if not desc:
                    raise HTTPException(status_code=400, detail="Deskripsi wajib diisi")
                if len(desc) > 240:
                    raise HTTPException(status_code=400, detail="Deskripsi terlalu panjang")
                updates["description"] = desc
            if not updates:
                return {"ok": True}
            updates["updated_at"] = utc_now_iso()
            cols = ", ".join([f"{k}=%s" for k in updates.keys()])
            params = list(updates.values()) + [int(mutasi_id)]
            cur.execute(f"UPDATE mutasi_entries SET {cols} WHERE id=%s", tuple(params))
            cur.execute("SELECT * FROM mutasi_entries WHERE id=%s", (int(mutasi_id),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "mutasi_entries", str(mutasi_id), "update", before, after)
        conn.commit()
        return {"ok": True}


@app.post("/api/mutasi/{mutasi_id}/delete")
def delete_mutasi(mutasi_id: int, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM mutasi_entries WHERE id=%s", (int(mutasi_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses delete")
            _delete_related_and_record(conn, "mutasi_entries", int(mutasi_id))
        conn.commit()
        return {"ok": True}


@app.post("/api/mutasi/{mutasi_id}/void")
def void_mutasi_compat(mutasi_id: int, body: VoidBody, request: Request):
    return delete_mutasi(mutasi_id=mutasi_id, request=request)


@app.get("/api/guests")
def list_guests(request: Request, status: str = "in", q: str = "", date: str = "", sort: str = "checkin_desc", limit: int = 200, post: str = "", offset: int = 0):
    with db_connect() as conn:
        _require_session(conn, request)
        status = (status or "in").strip()
        qn = normalize_text(q)
        post_val = (post or "").strip()
        bounds = _day_bounds(date)
        sort = (sort or "checkin_desc").strip()
        limit = max(1, min(500, int(limit or 200)))
        offset = max(0, min(100_000, int(offset or 0)))
        where = []
        params: list[Any] = []
        if status in ("in", "out", "void"):
            where.append("g.status = %s")
            params.append(status)
        elif status != "all":
            where.append("g.status <> 'void'")
        if post_val:
            if post_val == "Pintu Utama":
                where.append("(g.post = %s OR g.post = %s)")
                params.extend(["Pintu Utama", "Lobby"])
            elif post_val == "Lobby":
                where.append("(g.post = %s OR g.post = %s)")
                params.extend(["Lobby", "Pintu Utama"])
            else:
                where.append("g.post = %s")
                params.append(post_val)
        if qn:
            where.append(
                "(lower(g.name) LIKE %s OR lower(g.instansi) LIKE %s OR lower(g.purpose) LIKE %s OR lower(COALESCE(g.destination_room,'')) LIKE %s OR lower(COALESCE(g.visitor_card_no,'')) LIKE %s)"
            )
            params.extend([f"%{qn}%", f"%{qn}%", f"%{qn}%", f"%{qn}%", f"%{qn}%"])
        if bounds:
            where.append("g.checkin_at BETWEEN %s AND %s")
            params.extend([bounds[0], bounds[1]])
        order = "g.checkin_at DESC"
        if sort == "checkin_asc":
            order = "g.checkin_at ASC"
        sql = """
          SELECT g.id, g.name, g.instansi, g.purpose, g.meet_person, g.checkin_at, g.checkout_at, g.notes, g.paraf, g.status, g.void_reason,
                 g.destination_room, g.visitor_card_no, g.ktp_exchanged,
                 (CASE WHEN g.photo_b64 IS NULL OR g.photo_b64='' THEN 0 ELSE 1 END + COALESCE(att.c,0))::int AS photo_count,
                 g.created_by, g.created_at,
                 u.display_name AS created_by_name, g.shift, g.post
          FROM guest_entries g
          JOIN users u ON u.id = g.created_by
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS c
            FROM media_attachments ma
            WHERE ma.target_table='guest_entries' AND ma.target_id=g.id
          ) att ON true
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY {order} LIMIT %s OFFSET %s"
        params.append(limit)
        params.append(offset)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        for r in rows:
            r["photo_count"] = int(r.get("photo_count") or 0)
            r["has_photo"] = r["photo_count"] > 0
            if r["has_photo"]:
                r["photo_url"] = f"/api/guests/{int(r['id'])}/photo"
        return {"items": rows}


@app.get("/api/guests/{guest_id}/photo")
def get_guest_photo(guest_id: str, request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT photo_b64, photo_mime, photo_name FROM guest_entries WHERE id=%s", (guest_id,))
            row = cur.fetchone()
            if row and (row.get("photo_b64") or ""):
                data = base64.b64decode((row["photo_b64"] or "").encode("ascii"))
                mime = (row.get("photo_mime") or "application/octet-stream").strip()
                name = (row.get("photo_name") or "photo").strip()
                headers = {"Content-Disposition": f'inline; filename="{name}"'}
                return Response(content=data, media_type=mime, headers=headers)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT photo_b64, photo_mime, photo_name FROM media_attachments WHERE target_table='guest_entries' AND target_id=%s ORDER BY id ASC LIMIT 1",
                (guest_id,),
            )
            a = cur.fetchone()
            if not a or not (a.get("photo_b64") or ""):
                raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
            data = base64.b64decode((a["photo_b64"] or "").encode("ascii"))
            mime = (a.get("photo_mime") or "application/octet-stream").strip()
            name = (a.get("photo_name") or "photo").strip()
            headers = {"Content-Disposition": f'inline; filename="{name}"'}
            return Response(content=data, media_type=mime, headers=headers)


def _create_guest(
    conn,
    sess,
    name: str | None,
    instansi: str | None,
    purpose: str | None,
    meet_person: str | None,
    checkin_at: str | None,
    notes: str | None,
    paraf: str | None,
    post_override: str | None,
    force: bool,
    destination_room: str | None,
    visitor_card_no: str | None,
    ktp_exchanged: bool | None,
    photo_b64: str | None,
    photo_mime: str | None,
    photo_name: str | None,
    photo_uploaded_at: str | None,
) -> int:
    name = _text_field(name, field="Nama", max_len=80, default="Tidak diketahui")
    instansi = _text_field(instansi, field="Instansi", max_len=80, default="")
    purpose = _text_field(purpose, field="Divisi tujuan", max_len=80, default="-")
    meet = _text_field(meet_person, field="Orang yang ditemui", max_len=80, default="-")
    notes = _text_field(notes, field="Keperluan", max_len=240, default="")
    paraf = _text_field(paraf, field="Paraf", max_len=40, default="")
    post_val = (sess.get("post") or "").strip()
    if post_override:
        pv = str(post_override).strip()
        if pv not in ("IGD", "Pintu Utama", "Lobby"):
            raise HTTPException(status_code=400, detail="Pos tidak valid")
        post_val = pv
    dest_room = _text_field(destination_room, field="Ruang tujuan", max_len=80, default="")
    card_no = _text_field(visitor_card_no, field="Kartu penunggu", max_len=40, default="")
    exchanged = bool(ktp_exchanged) if ktp_exchanged is not None else False
    if post_val in ("Pintu Utama", "Lobby"):
        instansi = ""
    if post_val == "IGD":
        if not str(instansi or "").strip():
            raise HTTPException(status_code=400, detail="Instansi wajib diisi (IGD)")
    if post_val == "Pintu Utama":
        if not dest_room:
            raise HTTPException(status_code=400, detail="Ruang tujuan wajib diisi (Pintu Utama)")
        if not card_no:
            raise HTTPException(status_code=400, detail="Nomor kartu penunggu wajib diisi (Pintu Utama)")
        exchanged = True
    checkin_at = _iso_field(checkin_at, field="Waktu masuk") or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    now = utc_now_iso()
    with conn.cursor() as cur:
        if not force:
            cutoff = _recent_cutoff_iso(DEDUPE_WINDOW_SECONDS)
            cur.execute(
                """
                SELECT id, created_at
                FROM guest_entries
                WHERE status='in'
                  AND lower(name)=lower(%s)
                  AND lower(instansi)=lower(%s)
                  AND lower(purpose)=lower(%s)
                  AND lower(meet_person)=lower(%s)
                  AND COALESCE(lower(destination_room),'')=COALESCE(lower(%s),'')
                  AND COALESCE(lower(visitor_card_no),'')=COALESCE(lower(%s),'')
                  AND post=%s
                  AND created_at > %s
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (name, instansi, purpose, meet, dest_room, card_no, post_val, cutoff),
            )
            dup = cur.fetchone()
            if dup:
                raise HTTPException(status_code=409, detail=f"Data serupa sudah ada (ID {int(dup[0])}).")
        cur.execute(
            """
            INSERT INTO guest_entries(
              name, instansi, purpose, meet_person, checkin_at, checkout_at, notes, paraf, status, created_by, shift, post,
              destination_room, visitor_card_no, ktp_exchanged,
              photo_b64, photo_mime, photo_name, photo_uploaded_at, created_at, updated_at
            )
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING id
            """,
            (
                name,
                instansi,
                purpose,
                meet,
                checkin_at,
                None,
                notes,
                paraf or None,
                "in",
                sess["user_id"],
                sess["shift"],
                post_val,
                dest_room or None,
                card_no or None,
                True if exchanged else False,
                photo_b64,
                photo_mime,
                photo_name,
                photo_uploaded_at,
                now,
                now,
            ),
        )
        gid = int(cur.fetchone()[0])
        _audit(
            conn,
            sess,
            "guest_entries",
            str(gid),
            "create",
            None,
            {
                "name": name,
                "instansi": instansi,
                "purpose": purpose,
                "meet_person": meet,
                "checkin_at": checkin_at,
                "notes": notes,
                "paraf": paraf or None,
                "status": "in",
                "destination_room": dest_room or None,
                "visitor_card_no": card_no or None,
                "ktp_exchanged": True if exchanged else False,
                "has_photo": bool(photo_b64),
                "photo_name": photo_name if photo_b64 else None,
            },
        )
    return gid



@app.post("/api/guests")
def create_guest(body: CreateGuestBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        gid = _create_guest(
            conn,
            sess,
            body.name,
            body.instansi,
            body.purpose,
            body.meet_person,
            body.checkin_at,
            body.notes,
            body.paraf,
            body.post,
            bool(body.force),
            body.destination_room,
            body.visitor_card_no,
            body.ktp_exchanged,
            None,
            None,
            None,
            None,
        )
        conn.commit()
        return {"ok": True, "id": gid}

@app.post("/api/guests_with_photo")
def create_guest_with_photo(
    request: Request,
    name: str = Form(...),
    instansi: str | None = Form(None),
    purpose: str | None = Form(None),
    meet_person: str | None = Form(None),
    checkin_at: str | None = Form(None),
    notes: str | None = Form(None),
    paraf: str | None = Form(None),
    post: str | None = Form(None),
    destination_room: str | None = Form(None),
    visitor_card_no: str | None = Form(None),
    ktp_exchanged: str | None = Form(None),
    force: str | None = Form(None),
    photo: UploadFile | None = File(None),
):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        (photo_b64, photo_mime, photo_name, photo_uploaded_at) = _read_photo_upload(photo)
        gid = _create_guest(
            conn,
            sess,
            name,
            instansi,
            purpose,
            meet_person,
            checkin_at,
            notes,
            paraf,
            post,
            _parse_truthy(force),
            destination_room,
            visitor_card_no,
            _parse_truthy(ktp_exchanged) if ktp_exchanged is not None else None,
            photo_b64,
            photo_mime,
            photo_name,
            photo_uploaded_at,
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


@app.post("/api/guests/{guest_id}/undo_checkout")
def undo_checkout_guest(guest_id: str, body: VoidBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        reason = _text_field(body.reason, field="Alasan", max_len=120)
        if not reason:
            raise HTTPException(status_code=400, detail="Alasan wajib diisi")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM guest_entries WHERE id=%s", (guest_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if row["status"] != "out":
                raise HTTPException(status_code=400, detail="Hanya tamu yang sudah checkout yang bisa di-undo")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses undo checkout")
            before = dict(row)
            now = utc_now_iso()
            cur.execute("UPDATE guest_entries SET status='in', checkout_at=NULL, updated_at=%s WHERE id=%s", (now, guest_id))
            cur.execute("SELECT * FROM guest_entries WHERE id=%s", (guest_id,))
            after = dict(cur.fetchone())
            _audit(conn, sess, "guest_entries", str(guest_id), "undo_checkout", before, {**after, "undo_reason": reason})
        conn.commit()
        return {"ok": True}


@app.post("/api/guests/{guest_id}/delete")
def delete_guest(guest_id: str, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM guest_entries WHERE id=%s", (guest_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses delete")
            _delete_related_and_record(conn, "guest_entries", int(guest_id))
        conn.commit()
        return {"ok": True}


@app.post("/api/guests/{guest_id}/void")
def void_guest_compat(guest_id: str, body: VoidBody, request: Request):
    return delete_guest(guest_id=guest_id, request=request)


@app.patch("/api/guests/{guest_id}")
def patch_guest(guest_id: str, body: PatchGuestBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM guest_entries WHERE id=%s", (guest_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if row["status"] == "void":
                raise HTTPException(status_code=400, detail="Data sudah void")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses edit")
            before = dict(row)
            post_cur = str(row.get("post") or "").strip()
            updates: dict[str, Any] = {}
            if body.name is not None:
                updates["name"] = _text_field(body.name, field="Nama", max_len=80, default="Tidak diketahui") or "Tidak diketahui"
            if post_cur in ("Pintu Utama", "Lobby"):
                updates["instansi"] = ""
            elif body.instansi is not None:
                instansi_next = _text_field(body.instansi, field="Instansi", max_len=80, default="").strip()
                if not instansi_next:
                    raise HTTPException(status_code=400, detail="Instansi wajib diisi (IGD)")
                updates["instansi"] = instansi_next
            if body.purpose is not None:
                updates["purpose"] = _text_field(body.purpose, field="Divisi tujuan", max_len=80, default="-") or "-"
            if body.meet_person is not None:
                updates["meet_person"] = _text_field(body.meet_person, field="Orang yang ditemui", max_len=80, default="-") or "-"
            if body.notes is not None:
                updates["notes"] = _text_field(body.notes, field="Keperluan", max_len=240, default="")
            if body.paraf is not None:
                updates["paraf"] = _text_field(body.paraf, field="Paraf", max_len=40, default="") or None
            if body.destination_room is not None:
                updates["destination_room"] = _text_field(body.destination_room, field="Ruang tujuan", max_len=80, default="") or None
            if body.visitor_card_no is not None:
                updates["visitor_card_no"] = _text_field(body.visitor_card_no, field="Kartu penunggu", max_len=40, default="") or None
            if body.ktp_exchanged is not None:
                updates["ktp_exchanged"] = True if bool(body.ktp_exchanged) else False
            if body.checkin_at is not None:
                updates["checkin_at"] = _iso_field(body.checkin_at, field="Waktu masuk") or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            if body.checkout_at is not None:
                if (body.checkout_at or "").strip():
                    updates["checkout_at"] = _iso_field(body.checkout_at, field="Waktu keluar")
                else:
                    updates["checkout_at"] = None
            if post_cur == "Pintu Utama":
                dest_next = updates.get("destination_room", row.get("destination_room"))
                card_next = updates.get("visitor_card_no", row.get("visitor_card_no"))
                if not str(dest_next or "").strip():
                    raise HTTPException(status_code=400, detail="Ruang tujuan wajib diisi (Pintu Utama)")
                if not str(card_next or "").strip():
                    raise HTTPException(status_code=400, detail="Nomor kartu penunggu wajib diisi (Pintu Utama)")
                updates["ktp_exchanged"] = True
            if not updates:
                return {"ok": True}
            updates["updated_at"] = utc_now_iso()
            cols = ", ".join([f"{k}=%s" for k in updates.keys()])
            params = list(updates.values()) + [guest_id]
            cur.execute(f"UPDATE guest_entries SET {cols} WHERE id=%s", tuple(params))
            cur.execute("SELECT * FROM guest_entries WHERE id=%s", (guest_id,))
            after = dict(cur.fetchone())
            _audit(conn, sess, "guest_entries", str(guest_id), "update", before, after)
        conn.commit()
        return {"ok": True}


@app.get("/api/tasks")
def list_tasks(request: Request, q: str = "", date: str = "", sort: str = "occurred_desc", limit: int = 200, status: str = "active", offset: int = 0):
    with db_connect() as conn:
        _require_session(conn, request)
        qn = normalize_text(q)
        bounds = _day_bounds(date)
        sort = (sort or "occurred_desc").strip()
        limit = max(1, min(500, int(limit or 200)))
        offset = max(0, min(100_000, int(offset or 0)))
        status = (status or "active").strip().lower()
        where = []
        params: list[Any] = []
        if status in ("active", "void"):
            where.append("COALESCE(t.status,'active') = %s")
            params.append(status)
        elif status != "all":
            where.append("COALESCE(t.status,'active') <> 'void'")
        if qn:
            where.append("(lower(t.kind) LIKE %s OR lower(t.destination) LIKE %s OR lower(t.notes) LIKE %s OR lower(COALESCE(t.extra_json,'')) LIKE %s)")
            params.extend([f"%{qn}%", f"%{qn}%", f"%{qn}%", f"%{qn}%"])
        if bounds:
            where.append("t.occurred_at BETWEEN %s AND %s")
            params.extend([bounds[0], bounds[1]])
        order = "t.occurred_at DESC"
        if sort == "occurred_asc":
            order = "t.occurred_at ASC"
        sql = """
          SELECT t.id, t.kind, t.occurred_at, t.destination, t.notes, t.extra_json,
                 COALESCE(t.status,'active') AS status,
                 t.void_reason,
                 (CASE WHEN t.photo_b64 IS NULL OR t.photo_b64='' THEN 0 ELSE 1 END + COALESCE(att.c,0))::int AS photo_count,
                 u.display_name AS created_by_name, t.shift, t.post
          FROM task_entries t
          JOIN users u ON u.id = t.created_by
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS c
            FROM media_attachments ma
            WHERE ma.target_table='task_entries' AND ma.target_id=t.id
          ) att ON true
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY {order} LIMIT %s OFFSET %s"
        params.append(limit)
        params.append(offset)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall()
        for r in rows:
            r["photo_count"] = int(r.get("photo_count") or 0)
            r["has_photo"] = r["photo_count"] > 0
            if r["has_photo"]:
                r["photo_url"] = f"/api/tasks/{int(r['id'])}/photo"
            extra_raw = (r.get("extra_json") or "").strip()
            if extra_raw:
                try:
                    r["extra"] = json.loads(extra_raw)
                except Exception:
                    pass
            r.pop("extra_json", None)
        return {"items": rows}


@app.get("/api/tasks/{task_id}/photo")
def get_task_photo(task_id: str, request: Request):
    with db_connect() as conn:
        _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT photo_b64, photo_mime, photo_name FROM task_entries WHERE id=%s", (task_id,))
            row = cur.fetchone()
            if row and (row.get("photo_b64") or ""):
                data = base64.b64decode((row["photo_b64"] or "").encode("ascii"))
                mime = (row.get("photo_mime") or "application/octet-stream").strip()
                name = (row.get("photo_name") or "photo").strip()
                headers = {"Content-Disposition": f'inline; filename="{name}"'}
                return Response(content=data, media_type=mime, headers=headers)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT photo_b64, photo_mime, photo_name FROM media_attachments WHERE target_table='task_entries' AND target_id=%s ORDER BY id ASC LIMIT 1",
                (task_id,),
            )
            a = cur.fetchone()
            if not a or not (a.get("photo_b64") or ""):
                raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
            data = base64.b64decode((a["photo_b64"] or "").encode("ascii"))
            mime = (a.get("photo_mime") or "application/octet-stream").strip()
            name = (a.get("photo_name") or "photo").strip()
            headers = {"Content-Disposition": f'inline; filename="{name}"'}
            return Response(content=data, media_type=mime, headers=headers)


def _create_task(
    conn,
    sess,
    kind: str | None,
    occurred_at: str | None,
    destination: str | None,
    notes: str | None,
    extra: Any | None,
    force: bool,
    photo_b64: str | None,
    photo_mime: str | None,
    photo_name: str | None,
    photo_uploaded_at: str | None,
) -> int:
    kind = _text_field(kind, field="Jenis tugas", max_len=80, default="Lainnya")
    occurred = _iso_field(occurred_at, field="Waktu") or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    dest = _text_field(destination, field="Tujuan", max_len=80, default="-")
    notes = _text_field(notes, field="Catatan", max_len=240, default="")
    extra_json = None
    if extra is not None:
        try:
            extra_json = json.dumps(extra, ensure_ascii=False, separators=(",", ":"))
        except Exception:
            raise HTTPException(status_code=400, detail="Data tambahan tidak valid")
        if len(extra_json) > 6000:
            raise HTTPException(status_code=400, detail="Data tambahan terlalu besar")
    now = utc_now_iso()
    with conn.cursor() as cur:
        if not force:
            cutoff = _recent_cutoff_iso(DEDUPE_WINDOW_SECONDS)
            cur.execute(
                """
                SELECT id, created_at
                FROM task_entries
                WHERE COALESCE(status,'active') <> 'void'
                  AND lower(kind)=lower(%s)
                  AND lower(destination)=lower(%s)
                  AND lower(notes)=lower(%s)
                  AND COALESCE(extra_json,'') = %s
                  AND occurred_at=%s
                  AND created_at > %s
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (kind, dest, notes, extra_json or "", occurred, cutoff),
            )
            dup = cur.fetchone()
            if dup:
                raise HTTPException(status_code=409, detail=f"Data serupa sudah ada (ID {int(dup[0])}).")
        cur.execute(
            """
            INSERT INTO task_entries(kind, occurred_at, destination, notes, extra_json, status, void_reason, voided_by, voided_at, created_by, shift, post, photo_b64, photo_mime, photo_name, photo_uploaded_at, created_at, updated_at)
            VALUES (%s,%s,%s,%s,%s,'active',NULL,NULL,NULL,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING id
            """,
            (kind, occurred, dest, notes, extra_json, sess["user_id"], sess["shift"], sess["post"], photo_b64, photo_mime, photo_name, photo_uploaded_at, now, now),
        )
        tid = int(cur.fetchone()[0])
        _audit(
            conn,
            sess,
            "task_entries",
            str(tid),
            "create",
            None,
            {"kind": kind, "occurred_at": occurred, "destination": dest, "notes": notes, "extra": extra if extra is not None else None, "has_photo": bool(photo_b64), "photo_name": photo_name if photo_b64 else None},
        )
    return tid



@app.post("/api/tasks")
def create_task(body: CreateTaskBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        tid = _create_task(conn, sess, body.kind, body.occurred_at, body.destination, body.notes, body.extra, bool(body.force), None, None, None, None)
        conn.commit()
        return {"ok": True, "id": tid}


@app.post("/api/tasks_with_photo")
def create_task_with_photo(
    request: Request,
    kind: str = Form(...),
    occurred_at: str | None = Form(None),
    destination: str = Form(...),
    notes: str | None = Form(None),
    extra_json: str | None = Form(None),
    force: str | None = Form(None),
    photo: UploadFile | None = File(None),
):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        (photo_b64, photo_mime, photo_name, photo_uploaded_at) = _read_photo_upload(photo)
        extra = None
        if extra_json and extra_json.strip():
            if len(extra_json) > 6000:
                raise HTTPException(status_code=400, detail="Data tambahan terlalu besar")
            try:
                extra = json.loads(extra_json)
            except Exception:
                raise HTTPException(status_code=400, detail="Data tambahan tidak valid")
        tid = _create_task(conn, sess, kind, occurred_at, destination, notes, extra, _parse_truthy(force), photo_b64, photo_mime, photo_name, photo_uploaded_at)
        conn.commit()
        return {"ok": True, "id": tid}


@app.patch("/api/tasks/{task_id}")
def patch_task(task_id: int, body: PatchTaskBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM task_entries WHERE id=%s", (int(task_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if str(row.get("status") or "active") == "void":
                raise HTTPException(status_code=400, detail="Data sudah void")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses edit")
            before = dict(row)
            updates: dict[str, Any] = {}
            if body.destination is not None:
                updates["destination"] = _text_field(body.destination, field="Tujuan", max_len=80, default="-") or "-"
            if body.notes is not None:
                updates["notes"] = _text_field(body.notes, field="Catatan", max_len=240, default="")
            if body.extra is not None:
                try:
                    extra_json = json.dumps(body.extra, ensure_ascii=False, separators=(",", ":"))
                except Exception:
                    raise HTTPException(status_code=400, detail="Data tambahan tidak valid")
                if len(extra_json) > 6000:
                    raise HTTPException(status_code=400, detail="Data tambahan terlalu besar")
                updates["extra_json"] = extra_json
            if not updates:
                return {"ok": True}
            updates["updated_at"] = utc_now_iso()
            cols = ", ".join([f"{k}=%s" for k in updates.keys()])
            params = list(updates.values()) + [int(task_id)]
            cur.execute(f"UPDATE task_entries SET {cols} WHERE id=%s", tuple(params))
            cur.execute("SELECT * FROM task_entries WHERE id=%s", (int(task_id),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "task_entries", str(task_id), "update", before, after)
        conn.commit()
        return {"ok": True}


@app.post("/api/tasks/{task_id}/delete")
def delete_task(task_id: int, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM task_entries WHERE id=%s", (int(task_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
            if not _can_quick_modify(sess, created_by=int(row["created_by"]), created_at_iso=str(row.get("created_at") or "")):
                raise HTTPException(status_code=403, detail="Tidak punya akses delete")
            _delete_related_and_record(conn, "task_entries", int(task_id))
        conn.commit()
        return {"ok": True}


@app.post("/api/tasks/{task_id}/void")
def void_task_compat(task_id: int, body: VoidBody, request: Request):
    return delete_task(task_id=task_id, request=request)


@app.get("/api/report/shift")
def report_shift(request: Request, date: str = "", shift: str = "", post: str = ""):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        if not date:
            date = datetime.now().strftime("%Y-%m-%d")
        start = f"{date}T00:00:00"
        end = f"{date}T23:59:59"
        f_shift = (shift or sess["shift"] or "").strip()
        f_post = (post or sess["post"] or "").strip()
        with conn.cursor() as cur:
            key_where = ["checkout_at BETWEEN %s AND %s"]
            key_params: list[Any] = [start, end]
            if f_shift:
                key_where.append("created_shift=%s")
                key_params.append(f_shift)
            if f_post:
                key_where.append("created_post=%s")
                key_params.append(f_post)
            cur.execute(f"SELECT COUNT(1) FROM key_transactions WHERE {' AND '.join(key_where)}", tuple(key_params))
            key_total = int(cur.fetchone()[0] or 0)

            key_open_where = ["status='open'"]
            key_open_params: list[Any] = []
            if f_shift:
                key_open_where.append("created_shift=%s")
                key_open_params.append(f_shift)
            if f_post:
                key_open_where.append("created_post=%s")
                key_open_params.append(f_post)
            cur.execute(f"SELECT COUNT(1) FROM key_transactions WHERE {' AND '.join(key_open_where)}", tuple(key_open_params))
            key_open = int(cur.fetchone()[0] or 0)

            guest_where = ["checkin_at BETWEEN %s AND %s"]
            guest_params: list[Any] = [start, end]
            if f_shift:
                guest_where.append("shift=%s")
                guest_params.append(f_shift)
            if f_post:
                guest_where.append("post=%s")
                guest_params.append(f_post)
            cur.execute(f"SELECT COUNT(1) FROM guest_entries WHERE {' AND '.join(guest_where)}", tuple(guest_params))
            guest_total = int(cur.fetchone()[0] or 0)

            task_where = ["occurred_at BETWEEN %s AND %s"]
            task_params: list[Any] = [start, end]
            if f_shift:
                task_where.append("shift=%s")
                task_params.append(f_shift)
            if f_post:
                task_where.append("post=%s")
                task_params.append(f_post)
            cur.execute(f"SELECT COUNT(1) FROM task_entries WHERE {' AND '.join(task_where)}", tuple(task_params))
            task_total = int(cur.fetchone()[0] or 0)

            mutasi_where = ["occurred_at BETWEEN %s AND %s"]
            mutasi_params: list[Any] = [start, end]
            if f_shift:
                mutasi_where.append("shift=%s")
                mutasi_params.append(f_shift)
            if f_post:
                mutasi_where.append("post=%s")
                mutasi_params.append(f_post)
            cur.execute(f"SELECT COUNT(1) FROM mutasi_entries WHERE {' AND '.join(mutasi_where)}", tuple(mutasi_params))
            mutasi_total = int(cur.fetchone()[0] or 0)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT id, occurred_at, kind, description, COALESCE(status, 'active') AS status, void_reason
                FROM mutasi_entries
                WHERE {' AND '.join(mutasi_where)}
                ORDER BY occurred_at DESC
                LIMIT 30
                """,
                tuple(mutasi_params),
            )
            mutasi_rows = cur.fetchall() or []

            cur.execute(
                f"""
                SELECT id, occurred_at, kind, destination, COALESCE(status, 'active') AS status, void_reason
                FROM task_entries
                WHERE {' AND '.join(task_where)}
                ORDER BY occurred_at DESC
                LIMIT 30
                """,
                tuple(task_params),
            )
            task_rows = cur.fetchall() or []
        return {
            "date": date,
            "shift": f_shift,
            "post": f_post,
            "counts": {"keys_total": key_total, "keys_open": key_open, "guests_total": guest_total, "tasks_total": task_total, "mutasi_total": mutasi_total},
            "mutasi": mutasi_rows,
            "tasks": task_rows,
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


@app.get("/api/admin/vendors/catering")
def list_admin_catering_vendors(request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name, created_at FROM catering_vendors ORDER BY name ASC")
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/admin/vendors/catering")
def create_admin_catering_vendor(body: CreateCateringVendorBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        name = _text_field(body.name, field="Nama vendor", max_len=80)
        if not name:
            raise HTTPException(status_code=400, detail="Nama vendor wajib diisi")
        norm = normalize_text(name)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id FROM catering_vendors WHERE name_norm=%s", (norm,))
            dup = cur.fetchone()
            if dup:
                raise HTTPException(status_code=409, detail="Vendor sudah ada")
            cur.execute(
                "INSERT INTO catering_vendors(name, name_norm, created_by, created_at) VALUES (%s,%s,%s,%s) RETURNING id",
                (name, norm, int(sess["user_id"]), utc_now_iso()),
            )
            vid = int(cur.fetchone()["id"])
        conn.commit()
        return {"ok": True, "id": vid}


@app.patch("/api/admin/vendors/catering/{vendor_id}")
def patch_admin_catering_vendor(vendor_id: int, body: PatchCateringVendorBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        name = _text_field(body.name, field="Nama vendor", max_len=80)
        if not name:
            raise HTTPException(status_code=400, detail="Nama vendor wajib diisi")
        norm = normalize_text(name)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name, name_norm FROM catering_vendors WHERE id=%s", (int(vendor_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Vendor tidak ditemukan")
            cur.execute("SELECT id FROM catering_vendors WHERE name_norm=%s AND id<>%s", (norm, int(vendor_id)))
            dup = cur.fetchone()
            if dup:
                raise HTTPException(status_code=409, detail="Nama vendor sudah dipakai")
            cur.execute("UPDATE catering_vendors SET name=%s, name_norm=%s WHERE id=%s", (name, norm, int(vendor_id)))
        conn.commit()
        return {"ok": True}


@app.delete("/api/admin/vendors/catering/{vendor_id}")
def delete_admin_catering_vendor(vendor_id: int, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor() as cur:
            cur.execute("DELETE FROM catering_vendors WHERE id=%s", (int(vendor_id),))
            deleted = int(cur.rowcount or 0)
        conn.commit()
        if deleted == 0:
            raise HTTPException(status_code=404, detail="Vendor tidak ditemukan")
        return {"ok": True, "deleted": deleted}


@app.get("/api/admin/keys/master")
def admin_list_key_master(request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name, is_active, created_at, updated_at FROM key_master ORDER BY name ASC")
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/admin/keys/master")
def admin_create_key_master(body: CreateKeyMasterBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        name = _text_field(body.name, field="Nama kunci", max_len=80)
        if not name:
            raise HTTPException(status_code=400, detail="Nama kunci wajib diisi")
        norm = normalize_text(name)
        now = utc_now_iso()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT id, name, is_active, created_at, updated_at FROM key_master WHERE name_norm=%s LIMIT 1", (norm,))
                existing = cur.fetchone()
                if existing:
                    if bool(existing.get("is_active")):
                        raise HTTPException(status_code=409, detail=f"Nama kunci sudah ada: {existing.get('name') or ''}".strip())
                    before = dict(existing)
                    cur.execute("UPDATE key_master SET name=%s, name_norm=%s, is_active=TRUE, updated_at=%s WHERE id=%s", (name, norm, now, int(existing["id"])))
                    cur.execute("SELECT id, name, is_active, created_at, updated_at FROM key_master WHERE id=%s", (int(existing["id"]),))
                    after = dict(cur.fetchone())
                    _audit(conn, sess, "auth", str(existing["id"]), "key_master_reactivate", before, after)
                    conn.commit()
                    return {"ok": True, "id": int(existing["id"]), "mode": "reactivated"}

                cur.execute(
                    "INSERT INTO key_master(name, name_norm, is_active, created_by, created_at, updated_at) VALUES (%s,%s,TRUE,%s,%s,%s) RETURNING id",
                    (name, norm, int(sess["user_id"]), now, now),
                )
                kid = int(cur.fetchone()["id"])
                _audit(conn, sess, "auth", str(kid), "key_master_create", None, {"id": kid, "name": name, "is_active": True})
                conn.commit()
                return {"ok": True, "id": kid}
        except psycopg2.IntegrityError:
            conn.rollback()
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT id, name, is_active FROM key_master WHERE name_norm=%s LIMIT 1", (norm,))
                existing = cur.fetchone()
                if existing:
                    if bool(existing.get("is_active")):
                        raise HTTPException(status_code=409, detail=f"Nama kunci sudah ada: {existing.get('name') or ''}".strip())
                    raise HTTPException(status_code=409, detail=f"Nama kunci sudah ada (nonaktif): {existing.get('name') or ''}".strip())
            raise HTTPException(status_code=409, detail="Nama kunci sudah ada")


@app.patch("/api/admin/keys/master/{key_id}")
def admin_patch_key_master(key_id: int, body: PatchKeyMasterBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM key_master WHERE id=%s", (int(key_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Kunci tidak ditemukan")
            before = dict(row)
            updates: dict[str, Any] = {}
            if body.name is not None:
                nm = _text_field(body.name, field="Nama kunci", max_len=80)
                if not nm:
                    raise HTTPException(status_code=400, detail="Nama kunci wajib diisi")
                updates["name"] = nm
                updates["name_norm"] = normalize_text(nm)
            if body.is_active is not None:
                updates["is_active"] = bool(body.is_active)
            if not updates:
                return {"ok": True}
            updates["updated_at"] = utc_now_iso()
            cols = ", ".join([f"{k}=%s" for k in updates.keys()])
            params = list(updates.values()) + [int(key_id)]
            try:
                cur.execute(f"UPDATE key_master SET {cols} WHERE id=%s", tuple(params))
            except psycopg2.IntegrityError:
                raise HTTPException(status_code=409, detail="Nama kunci sudah dipakai")
            cur.execute("SELECT * FROM key_master WHERE id=%s", (int(key_id),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "auth", str(key_id), "key_master_update", before, after)
        conn.commit()
        return {"ok": True}


@app.delete("/api/admin/keys/master/{key_id}")
def admin_delete_key_master(key_id: int, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM key_master WHERE id=%s", (int(key_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Kunci tidak ditemukan")
            before = dict(row)
            now = utc_now_iso()
            cur.execute("UPDATE key_master SET is_active=FALSE, updated_at=%s WHERE id=%s", (now, int(key_id)))
            cur.execute("SELECT * FROM key_master WHERE id=%s", (int(key_id),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "auth", str(key_id), "key_master_disable", before, after)
        conn.commit()
        return {"ok": True}


@app.get("/api/admin/rooms/master")
def admin_list_room_master(request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name, is_active, created_at, updated_at FROM room_master ORDER BY name ASC")
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/admin/rooms/master")
def admin_create_room_master(body: CreateRoomMasterBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        name = _text_field(body.name, field="Nama ruangan", max_len=80)
        if not name:
            raise HTTPException(status_code=400, detail="Nama ruangan wajib diisi")
        norm = normalize_text(name)
        now = utc_now_iso()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO room_master(name, name_norm, is_active, created_by, created_at, updated_at) VALUES (%s,%s,TRUE,%s,%s,%s) RETURNING id",
                    (name, norm, int(sess["user_id"]), now, now),
                )
                rid = int(cur.fetchone()[0])
                _audit(conn, sess, "auth", str(rid), "room_master_create", None, {"id": rid, "name": name, "is_active": True})
            conn.commit()
            return {"ok": True, "id": rid}
        except psycopg2.IntegrityError:
            conn.rollback()
            raise HTTPException(status_code=409, detail="Nama ruangan sudah ada")


@app.patch("/api/admin/rooms/master/{room_id}")
def admin_patch_room_master(room_id: int, body: PatchRoomMasterBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM room_master WHERE id=%s", (int(room_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Ruangan tidak ditemukan")
            before = dict(row)
            updates: dict[str, Any] = {}
            if body.name is not None:
                nm = _text_field(body.name, field="Nama ruangan", max_len=80)
                if not nm:
                    raise HTTPException(status_code=400, detail="Nama ruangan wajib diisi")
                updates["name"] = nm
                updates["name_norm"] = normalize_text(nm)
            if body.is_active is not None:
                updates["is_active"] = bool(body.is_active)
            if not updates:
                return {"ok": True}
            updates["updated_at"] = utc_now_iso()
            cols = ", ".join([f"{k}=%s" for k in updates.keys()])
            params = list(updates.values()) + [int(room_id)]
            try:
                cur.execute(f"UPDATE room_master SET {cols} WHERE id=%s", tuple(params))
            except psycopg2.IntegrityError:
                raise HTTPException(status_code=409, detail="Nama ruangan sudah dipakai")
            cur.execute("SELECT * FROM room_master WHERE id=%s", (int(room_id),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "auth", str(room_id), "room_master_update", before, after)
        conn.commit()
        return {"ok": True}


@app.delete("/api/admin/rooms/master/{room_id}")
def admin_delete_room_master(room_id: int, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM room_master WHERE id=%s", (int(room_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Ruangan tidak ditemukan")
            before = dict(row)
            now = utc_now_iso()
            cur.execute("UPDATE room_master SET is_active=FALSE, updated_at=%s WHERE id=%s", (now, int(room_id)))
            cur.execute("SELECT * FROM room_master WHERE id=%s", (int(room_id),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "auth", str(room_id), "room_master_disable", before, after)
        conn.commit()
        return {"ok": True}


@app.get("/api/admin/pom_units")
def admin_list_pom_units(request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name, sort_order, is_active, created_at, updated_at FROM pom_unit_master ORDER BY sort_order ASC, name ASC")
            rows = cur.fetchall()
        return {"items": rows}


@app.post("/api/admin/pom_units")
def admin_create_pom_unit(body: CreatePomUnitBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        name = _text_field(body.name, field="Nama unit", max_len=80)
        if not name:
            raise HTTPException(status_code=400, detail="Nama unit wajib diisi")
        try:
            order = int(body.sort_order) if body.sort_order is not None else 0
        except Exception:
            order = 0
        order = max(-10_000, min(10_000, order))
        norm = normalize_text(name)
        now = utc_now_iso()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO pom_unit_master(name, name_norm, sort_order, is_active, created_by, created_at, updated_at) VALUES (%s,%s,%s,TRUE,%s,%s,%s) RETURNING id",
                    (name, norm, int(order), int(sess["user_id"]), now, now),
                )
                pid = int(cur.fetchone()[0])
                _audit(conn, sess, "auth", str(pid), "pom_unit_master_create", None, {"id": pid, "name": name, "sort_order": order, "is_active": True})
            conn.commit()
            return {"ok": True, "id": pid}
        except psycopg2.IntegrityError:
            conn.rollback()
            raise HTTPException(status_code=409, detail="Nama unit sudah ada")


@app.patch("/api/admin/pom_units/{unit_id}")
def admin_patch_pom_unit(unit_id: int, body: PatchPomUnitBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM pom_unit_master WHERE id=%s", (int(unit_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Unit tidak ditemukan")
            before = dict(row)
            updates: dict[str, Any] = {}
            if body.name is not None:
                nm = _text_field(body.name, field="Nama unit", max_len=80)
                if not nm:
                    raise HTTPException(status_code=400, detail="Nama unit wajib diisi")
                updates["name"] = nm
                updates["name_norm"] = normalize_text(nm)
            if body.sort_order is not None:
                try:
                    updates["sort_order"] = max(-10_000, min(10_000, int(body.sort_order)))
                except Exception:
                    updates["sort_order"] = 0
            if body.is_active is not None:
                updates["is_active"] = bool(body.is_active)
            if not updates:
                return {"ok": True}
            updates["updated_at"] = utc_now_iso()
            cols = ", ".join([f"{k}=%s" for k in updates.keys()])
            params = list(updates.values()) + [int(unit_id)]
            try:
                cur.execute(f"UPDATE pom_unit_master SET {cols} WHERE id=%s", tuple(params))
            except psycopg2.IntegrityError:
                raise HTTPException(status_code=409, detail="Nama unit sudah dipakai")
            cur.execute("SELECT * FROM pom_unit_master WHERE id=%s", (int(unit_id),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "auth", str(unit_id), "pom_unit_master_update", before, after)
        conn.commit()
        return {"ok": True}


@app.delete("/api/admin/pom_units/{unit_id}")
def admin_delete_pom_unit(unit_id: int, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM pom_unit_master WHERE id=%s", (int(unit_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Unit tidak ditemukan")
            before = dict(row)
            now = utc_now_iso()
            cur.execute("UPDATE pom_unit_master SET is_active=FALSE, updated_at=%s WHERE id=%s", (now, int(unit_id)))
            cur.execute("SELECT * FROM pom_unit_master WHERE id=%s", (int(unit_id),))
            after = dict(cur.fetchone())
            _audit(conn, sess, "auth", str(unit_id), "pom_unit_master_disable", before, after)
        conn.commit()
        return {"ok": True}


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
                hashed = pbkdf2_hash_password(password)
                if _users_has_password:
                    cur.execute(
                        "INSERT INTO users(username, display_name, password, password_hash, role, is_active, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                        (username, display_name, hashed, hashed, role, 1, now),
                    )
                else:
                    cur.execute(
                        "INSERT INTO users(username, display_name, password_hash, role, is_active, created_at) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                        (username, display_name, hashed, role, 1, now),
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
            hashed = pbkdf2_hash_password(temp_password)
            if _users_has_password:
                cur.execute("UPDATE users SET password=%s, password_hash=%s WHERE id=%s", (hashed, hashed, user_id))
            else:
                cur.execute("UPDATE users SET password_hash=%s WHERE id=%s", (hashed, user_id))
            after = {**before}
            _audit(conn, sess, "users", str(user_id), "reset_password", before, after)
        conn.commit()
        return {"ok": True, "temp_password": temp_password}


@app.get("/api/admin/audit")
def admin_audit(
    request: Request,
    q: str = "",
    table_name: str = "",
    record_id: str = "",
    actor_user_id: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = 100,
):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        qn = normalize_text(q)
        tn = normalize_text(table_name)
        rid = (record_id or "").strip()
        auid = (actor_user_id or "").strip()
        b_from = _day_bounds(date_from)
        b_to = _day_bounds(date_to)
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
            CASE
              WHEN a.target_key_transaction_id IS NOT NULL THEN (
                SELECT COALESCE(k.borrower_name, '') || CASE WHEN COALESCE(k.key_name, '') <> '' THEN ' · ' || k.key_name ELSE '' END
                FROM key_transactions k
                WHERE k.id = a.target_key_transaction_id
              )
              WHEN a.target_guest_entry_id IS NOT NULL THEN (
                SELECT COALESCE(g.name, '') || CASE WHEN COALESCE(g.instansi, '') <> '' THEN ' · ' || g.instansi ELSE '' END
                FROM guest_entries g
                WHERE g.id = a.target_guest_entry_id
              )
              WHEN a.target_mutasi_entry_id IS NOT NULL THEN (
                SELECT COALESCE(m.kind, '') || CASE WHEN COALESCE(m.description, '') <> '' THEN ' · ' || m.description ELSE '' END
                FROM mutasi_entries m
                WHERE m.id = a.target_mutasi_entry_id
              )
              WHEN a.target_task_entry_id IS NOT NULL THEN (
                SELECT COALESCE(t.kind, '') || CASE WHEN COALESCE(t.destination, '') <> '' THEN ' · ' || t.destination ELSE '' END
                FROM task_entries t
                WHERE t.id = a.target_task_entry_id
              )
              WHEN a.target_user_id IS NOT NULL THEN (
                SELECT COALESCE(u2.display_name, '') || CASE WHEN COALESCE(u2.username, '') <> '' THEN ' · ' || u2.username ELSE '' END
                FROM users u2
                WHERE u2.id = a.target_user_id
              )
              ELSE NULL
            END AS target_label,
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
        if auid:
            filters.append("a.actor_user_id = CAST(%s AS BIGINT)")
            params.append(auid)
        if b_from or b_to:
            start = b_from[0] if b_from else b_to[0]
            end = b_to[1] if b_to else b_from[1]
            filters.append("a.created_at BETWEEN %s AND %s")
            params.extend([start, end])
        if qn:
            filters.append(
                """(
                  lower(a.action) LIKE %s OR
                  lower(u.display_name) LIKE %s OR
                  lower(COALESCE(
                    CASE
                      WHEN a.target_key_transaction_id IS NOT NULL THEN (SELECT COALESCE(k.borrower_name, '') || CASE WHEN COALESCE(k.key_name, '') <> '' THEN ' · ' || k.key_name ELSE '' END FROM key_transactions k WHERE k.id = a.target_key_transaction_id)
                      WHEN a.target_guest_entry_id IS NOT NULL THEN (SELECT COALESCE(g.name, '') || CASE WHEN COALESCE(g.instansi, '') <> '' THEN ' · ' || g.instansi ELSE '' END FROM guest_entries g WHERE g.id = a.target_guest_entry_id)
                      WHEN a.target_mutasi_entry_id IS NOT NULL THEN (SELECT COALESCE(m.kind, '') || CASE WHEN COALESCE(m.description, '') <> '' THEN ' · ' || m.description ELSE '' END FROM mutasi_entries m WHERE m.id = a.target_mutasi_entry_id)
                      WHEN a.target_task_entry_id IS NOT NULL THEN (SELECT COALESCE(t.kind, '') || CASE WHEN COALESCE(t.destination, '') <> '' THEN ' · ' || t.destination ELSE '' END FROM task_entries t WHERE t.id = a.target_task_entry_id)
                      WHEN a.target_user_id IS NOT NULL THEN (SELECT COALESCE(u2.display_name, '') || CASE WHEN COALESCE(u2.username, '') <> '' THEN ' · ' || u2.username ELSE '' END FROM users u2 WHERE u2.id = a.target_user_id)
                      ELSE NULL
                    END,
                    ''
                  )) LIKE %s
                )"""
            )
            params.extend([f"%{qn}%", f"%{qn}%", f"%{qn}%"])
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
                    "target_label": r.get("target_label") if isinstance(r, dict) else None,
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
                  CASE
                    WHEN a.target_key_transaction_id IS NOT NULL THEN (
                      SELECT COALESCE(k.borrower_name, '') || CASE WHEN COALESCE(k.key_name, '') <> '' THEN ' · ' || k.key_name ELSE '' END
                      FROM key_transactions k
                      WHERE k.id = a.target_key_transaction_id
                    )
                    WHEN a.target_guest_entry_id IS NOT NULL THEN (
                      SELECT COALESCE(g.name, '') || CASE WHEN COALESCE(g.instansi, '') <> '' THEN ' · ' || g.instansi ELSE '' END
                      FROM guest_entries g
                      WHERE g.id = a.target_guest_entry_id
                    )
                    WHEN a.target_mutasi_entry_id IS NOT NULL THEN (
                      SELECT COALESCE(m.kind, '') || CASE WHEN COALESCE(m.description, '') <> '' THEN ' · ' || m.description ELSE '' END
                      FROM mutasi_entries m
                      WHERE m.id = a.target_mutasi_entry_id
                    )
                    WHEN a.target_task_entry_id IS NOT NULL THEN (
                      SELECT COALESCE(t.kind, '') || CASE WHEN COALESCE(t.destination, '') <> '' THEN ' · ' || t.destination ELSE '' END
                      FROM task_entries t
                      WHERE t.id = a.target_task_entry_id
                    )
                    WHEN a.target_user_id IS NOT NULL THEN (
                      SELECT COALESCE(u2.display_name, '') || CASE WHEN COALESCE(u2.username, '') <> '' THEN ' · ' || u2.username ELSE '' END
                      FROM users u2
                      WHERE u2.id = a.target_user_id
                    )
                    ELSE NULL
                  END AS target_label,
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
                    "target_label": r.get("target_label") if isinstance(r, dict) else None,
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
        try:
            rid = int(record_id)
        except Exception:
            raise HTTPException(status_code=400, detail="id tidak valid")
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"SELECT id FROM {table_name} WHERE id=%s", (rid,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Data tidak ditemukan")
        deleted = _delete_related_and_record(conn, table_name, rid)
        conn.commit()
        return {"ok": True, "mode": "deleted", "deleted": deleted, "note": note}


@app.post("/api/admin/reset_data")
def admin_reset_data(body: ResetDataBody, request: Request):
    with db_connect() as conn:
        sess = _require_session(conn, request)
        _require_role(sess, ("admin",))
        confirm = str((body.confirm or "")).strip().upper()
        if confirm != "DELETE":
            raise HTTPException(status_code=400, detail="Konfirmasi tidak valid")
        counts: dict[str, int] = {}
        with conn.cursor() as cur:
            for t in (
                "media_attachments",
                "audit_log",
                "pom_catering_sheets",
                "task_entries",
                "mutasi_entries",
                "guest_entries",
                "key_transactions",
                "catering_vendors",
                "key_master",
                "room_master",
                "pom_unit_master",
                "sessions",
            ):
                cur.execute(f"DELETE FROM {t}")
                counts[t] = int(cur.rowcount or 0)
        conn.commit()
        return {"ok": True, "deleted": counts}


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

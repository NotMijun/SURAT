import base64
import hashlib
import hmac
import json
import os
import random
import sys
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from dotenv import load_dotenv
import os

load_dotenv()  # Memuat variabel dari file .env
DATABASE_URL = os.getenv("DATABASE_URL")

ROOT_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT_DIR / "logbook.db"
SESSION_TTL_SECONDS = 60 * 60 * 2
COOKIE_NAME = "logbook_sid"

LOGIN_RATE_WINDOW_SECONDS = 10 * 60
LOGIN_RATE_MAX_ATTEMPTS = 8


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_dumps(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


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


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def db_init() -> None:
    conn = db_connect()
    cur = conn.cursor()

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('guard','supervisor','admin')),
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          shift TEXT NOT NULL,
          post TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS login_attempts (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          first_ts INTEGER NOT NULL,
          last_ts INTEGER NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS key_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          borrower_name TEXT NOT NULL,
          borrower_name_norm TEXT NOT NULL,
          unit TEXT NOT NULL,
          key_name TEXT NOT NULL,
          key_name_norm TEXT NOT NULL,
          checkout_at TEXT NOT NULL,
          checkin_at TEXT,
          notes TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open','closed','void')),
          created_by INTEGER NOT NULL REFERENCES users(id),
          created_shift TEXT NOT NULL,
          created_post TEXT NOT NULL,
          closed_by INTEGER REFERENCES users(id),
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
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL,
          kind TEXT NOT NULL,
          description TEXT NOT NULL,
          created_by INTEGER NOT NULL REFERENCES users(id),
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
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          instansi TEXT NOT NULL,
          purpose TEXT NOT NULL,
          meet_person TEXT NOT NULL,
          checkin_at TEXT NOT NULL,
          checkout_at TEXT,
          notes TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('in','out')),
          created_by INTEGER NOT NULL REFERENCES users(id),
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
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          destination TEXT NOT NULL,
          notes TEXT NOT NULL,
          created_by INTEGER NOT NULL REFERENCES users(id),
          shift TEXT NOT NULL,
          post TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )

    cur.execute("CREATE INDEX IF NOT EXISTS idx_task_occurred ON task_entries(occurred_at)")

    # Migrate audit_log to typed target columns (Option B)
    cur.execute("PRAGMA table_info(audit_log)")
    cols = [row["name"] for row in cur.fetchall()]
    if cols and "table_name" in cols:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_log_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              actor_user_id INTEGER NOT NULL REFERENCES users(id),
              target_key_transaction_id INTEGER REFERENCES key_transactions(id),
              target_guest_entry_id INTEGER REFERENCES guest_entries(id),
              target_mutasi_entry_id INTEGER REFERENCES mutasi_entries(id),
              target_task_entry_id INTEGER REFERENCES task_entries(id),
              target_user_id INTEGER REFERENCES users(id),
              action TEXT NOT NULL,
              actor_shift TEXT NOT NULL,
              actor_post TEXT NOT NULL,
              before_json TEXT,
              after_json TEXT,
              created_at TEXT NOT NULL
            )
            """
        )
        # Backfill from old audit_log (polymorphic)
        conn.execute("PRAGMA foreign_keys=OFF")
        cur.execute("SELECT id, table_name, record_id, action, actor_user_id, actor_shift, actor_post, before_json, after_json, created_at FROM audit_log")
        rows = cur.fetchall()
        for r in rows:
            tgt = {
                "target_key_transaction_id": None,
                "target_guest_entry_id": None,
                "target_mutasi_entry_id": None,
                "target_task_entry_id": None,
                "target_user_id": None,
            }
            t = (r["table_name"] or "").strip()
            rec = r["record_id"]
            try:
                rec_int = int(rec)
            except Exception:
                rec_int = None
            if t == "key_transactions":
                tgt["target_key_transaction_id"] = rec_int
            elif t == "guest_entries":
                tgt["target_guest_entry_id"] = rec_int
            elif t == "mutasi_entries":
                tgt["target_mutasi_entry_id"] = rec_int
            elif t == "task_entries":
                tgt["target_task_entry_id"] = rec_int
            elif t in ("users", "auth"):
                tgt["target_user_id"] = rec_int
            cur.execute(
                """
                INSERT INTO audit_log_new(actor_user_id, target_key_transaction_id, target_guest_entry_id, target_mutasi_entry_id, target_task_entry_id, target_user_id,
                                          action, actor_shift, actor_post, before_json, after_json, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    r["actor_user_id"],
                    tgt["target_key_transaction_id"],
                    tgt["target_guest_entry_id"],
                    tgt["target_mutasi_entry_id"],
                    tgt["target_task_entry_id"],
                    tgt["target_user_id"],
                    r["action"],
                    r["actor_shift"],
                    r["actor_post"],
                    r["before_json"],
                    r["after_json"],
                    r["created_at"],
                ),
            )
        cur.execute("DROP TABLE audit_log")
        cur.execute("ALTER TABLE audit_log_new RENAME TO audit_log")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, created_at)")
        cur.execute(
            """
            CREATE TRIGGER IF NOT EXISTS audit_log_one_target
            BEFORE INSERT ON audit_log
            FOR EACH ROW
            BEGIN
              SELECT
                CASE
                  WHEN ((NEW.target_key_transaction_id IS NOT NULL) +
                        (NEW.target_guest_entry_id IS NOT NULL) +
                        (NEW.target_mutasi_entry_id IS NOT NULL) +
                        (NEW.target_task_entry_id IS NOT NULL) +
                        (NEW.target_user_id IS NOT NULL)) != 1
                  THEN RAISE(ABORT, 'Exactly one target_* must be NOT NULL')
                END;
            END;
            """
        )
        conn.execute("PRAGMA foreign_keys=ON")
    elif not cols:
        # Fresh create with new schema
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              actor_user_id INTEGER NOT NULL REFERENCES users(id),
              target_key_transaction_id INTEGER REFERENCES key_transactions(id),
              target_guest_entry_id INTEGER REFERENCES guest_entries(id),
              target_mutasi_entry_id INTEGER REFERENCES mutasi_entries(id),
              target_task_entry_id INTEGER REFERENCES task_entries(id),
              target_user_id INTEGER REFERENCES users(id),
              action TEXT NOT NULL,
              actor_shift TEXT NOT NULL,
              actor_post TEXT NOT NULL,
              before_json TEXT,
              after_json TEXT,
              created_at TEXT NOT NULL
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, created_at)")
        cur.execute(
            """
            CREATE TRIGGER IF NOT EXISTS audit_log_one_target
            BEFORE INSERT ON audit_log
            FOR EACH ROW
            BEGIN
              SELECT
                CASE
                  WHEN ((NEW.target_key_transaction_id IS NOT NULL) +
                        (NEW.target_guest_entry_id IS NOT NULL) +
                        (NEW.target_mutasi_entry_id IS NOT NULL) +
                        (NEW.target_task_entry_id IS NOT NULL) +
                        (NEW.target_user_id IS NOT NULL)) != 1
                  THEN RAISE(ABORT, 'Exactly one target_* must be NOT NULL')
                END;
            END;
            """
        )

    conn.commit()

    def ensure_user(username: str, display_name: str, password: str, role: str):
        row = cur.execute("SELECT id, username, display_name, role FROM users WHERE username=?", (username,)).fetchone()
        if not row:
            cur.execute(
                "INSERT INTO users(username, display_name, password_hash, role, is_active, created_at) VALUES (?,?,?,?,?,?)",
                (username, display_name, pbkdf2_hash_password(password), role, 1, utc_now_iso()),
            )
            return
        if row["display_name"] != display_name or row["role"] != role:
            cur.execute("UPDATE users SET display_name=?, role=? WHERE username=?", (display_name, role, username))

    cur.execute("SELECT COUNT(1) AS c FROM users")
    if cur.fetchone()["c"] == 0:
        ensure_user("utas", "UTAS", "utas123", "admin")
        ensure_user("ardi", "ARDI", "ardi123", "guard")
        ensure_user("nafsir", "NAFSIR", "nafsir123", "admin")
        ensure_user("marzuki", "MARZUKI", "marzuki123", "admin")
        ensure_user("admin", "ADMIN", "admin123", "admin")
    else:
        ensure_user("utas", "UTAS", "utas123", "admin")
        ensure_user("nafsir", "NAFSIR", "nafsir123", "admin")
        ensure_user("marzuki", "MARZUKI", "marzuki123", "admin")
        ensure_user("ardi", "ARDI", "ardi123", "guard")
        ensure_user("admin", "ADMIN", "admin123", "admin")

    conn.commit()

    conn.close()

def _audit_seed(conn: sqlite3.Connection, actor_user_id: int, shift: str, post: str, table_name: str, record_id: int, action: str, before, after):
    target = {
        "target_key_transaction_id": None,
        "target_guest_entry_id": None,
        "target_mutasi_entry_id": None,
        "target_task_entry_id": None,
        "target_user_id": None,
    }
    if table_name == "key_transactions":
        target["target_key_transaction_id"] = record_id
    elif table_name == "guest_entries":
        target["target_guest_entry_id"] = record_id
    elif table_name == "mutasi_entries":
        target["target_mutasi_entry_id"] = record_id
    elif table_name == "task_entries":
        target["target_task_entry_id"] = record_id
    elif table_name == "users":
        target["target_user_id"] = record_id
    conn.execute(
        """
        INSERT INTO audit_log(actor_user_id, target_key_transaction_id, target_guest_entry_id, target_mutasi_entry_id, target_task_entry_id, target_user_id,
                              action, actor_shift, actor_post, before_json, after_json, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            actor_user_id,
            target["target_key_transaction_id"],
            target["target_guest_entry_id"],
            target["target_mutasi_entry_id"],
            target["target_task_entry_id"],
            target["target_user_id"],
            action,
            shift,
            post,
            json.dumps(before, ensure_ascii=False) if before is not None else None,
            json.dumps(after, ensure_ascii=False) if after is not None else None,
            utc_now_iso(),
        ),
    )

def seed_data(conn: sqlite3.Connection, counts: dict[str, int]):
    users = conn.execute("SELECT id, username, display_name, role FROM users WHERE is_active=1").fetchall()
    if not users:
        return
    def pick_user(exclude_id: int | None = None):
        pool = [dict(u) for u in users if str(u["id"]) != str(exclude_id)]
        return random.choice(pool)
    def pick_shift():
        return random.choice(["Pagi","Sore","Malam"])
    def pick_post():
        return random.choice(["IGD","Lobby","Radiologi","Farmasi","Lab","Poli","Rawat Inap"])
    def ymd_range(days_back: int = 7):
        d = datetime.now() - timedelta(days=random.randint(0, days_back))
        return d.strftime("%Y-%m-%d")
    def hm():
        h = random.randint(6, 21)
        m = random.choice([0,5,10,15,20,25,30,35,40,45,50,55])
        return f"{str(h).zfill(2)}:{str(m).zfill(2)}"
    from datetime import timedelta

    keys_n = counts.get("keys", 40)
    guests_n = counts.get("guests", 40)
    tasks_n = counts.get("tasks", 40)
    mutasi_n = counts.get("mutasi", 40)

    key_names = ["Radiologi","Farmasi","Gudang","Keuangan","Ruang Rapat","VIP","Server","Kebersihan","Kantin","Kasir"]
    units = ["Perawat","Dokter","IT","HRD","Admin","Keamanan","Kebersihan","Tamu","Supplier"]
    borrower_names = ["BUDI","ANDI","SITI","RINA","BAMBANG","DEWI","UCOK","IWAN","FITRI","FAJAR","LINA"]
    instansis = ["Vendor","Supplier","Keluarga pasien","Kurir","Rekanan","Teknisi"]
    purposes = ["Mengantar berkas","Bertemu HRD","Perbaikan AC","Pengecekan alat","Pembayaran","Konsultasi"]
    meets = ["HRD","IT","Perawat","Kasir","Keuangan","Dokter"]
    task_kinds = ["Antar sampel","Antar surat","Pom catering","Galon","Antar berkas","Lainnya"]
    mutasi_kinds = ["Kejadian khusus","Ronda","Katering","Komplain","Lainnya"]

    for i in range(keys_n):
        cu = pick_user()
        shift = pick_shift()
        post = pick_post()
        name = random.choice(borrower_names)
        unit = random.choice(units)
        key = random.choice(key_names)
        y = ymd_range()
        checkout = f"{y}T{hm()}:00"
        now = utc_now_iso()
        cur = conn.execute(
            """
            INSERT INTO key_transactions(borrower_name, borrower_name_norm, unit, key_name, key_name_norm, checkout_at, checkin_at, notes, status,
              created_by, created_shift, created_post, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (name, normalize_text(name), unit, key, normalize_text(key), checkout, None, "", "open", cu["id"], shift, post, now, now),
        )
        kid = cur.lastrowid
        _audit_seed(conn, cu["id"], shift, post, "key_transactions", kid, "create", None, {"borrower_name": name, "unit": unit, "key_name": key, "checkout_at": checkout, "status": "open"})
        if i % 2 == 0:
            closer = pick_user(exclude_id=cu["id"])
            cshift = pick_shift()
            cpost = pick_post()
            checkin = f"{y}T{hm()}:00"
            conn.execute(
                "UPDATE key_transactions SET status='closed', checkin_at=?, closed_by=?, closed_shift=?, closed_post=?, updated_at=? WHERE id=?",
                (checkin, closer["id"], cshift, cpost, utc_now_iso(), kid),
            )
            before = None
            after = {"status": "closed", "checkin_at": checkin, "closed_by": closer["id"], "closed_shift": cshift, "closed_post": cpost}
            _audit_seed(conn, closer["id"], cshift, cpost, "key_transactions", kid, "close", before, after)

    for i in range(guests_n):
        cu = pick_user()
        shift = pick_shift()
        post = pick_post()
        name = random.choice(borrower_names)
        inst = random.choice(instansis)
        purp = random.choice(purposes)
        meetp = random.choice(meets)
        y = ymd_range()
        checkin = f"{y}T{hm()}:00"
        now = utc_now_iso()
        cur = conn.execute(
            """
            INSERT INTO guest_entries(name, instansi, purpose, meet_person, checkin_at, checkout_at, notes, status, created_by, shift, post, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (name, inst, purp, meetp, checkin, None, "", "in", cu["id"], shift, post, now, now),
        )
        gid = cur.lastrowid
        _audit_seed(conn, cu["id"], shift, post, "guest_entries", gid, "create", None, {"name": name, "instansi": inst, "purpose": purp, "meet_person": meetp, "checkin_at": checkin, "status": "in"})
        if i % 2 == 1:
            checkout = f"{y}T{hm()}:00"
            conn.execute("UPDATE guest_entries SET status='out', checkout_at=?, updated_at=? WHERE id=?", (checkout, utc_now_iso(), gid))
            _audit_seed(conn, cu["id"], shift, post, "guest_entries", gid, "checkout", None, {"status": "out", "checkout_at": checkout})

    for i in range(tasks_n):
        cu = pick_user()
        shift = pick_shift()
        post = pick_post()
        kind = random.choice(task_kinds)
        dest = random.choice(["Lab","Poli","IGD","Radiologi","Farmasi","Gudang","Keuangan"])
        y = ymd_range()
        occurred = f"{y}T{hm()}:00"
        notes = random.choice(["","Antar cepat","Perlu tanda tangan","Urgent",""])
        now = utc_now_iso()
        cur = conn.execute(
            """
            INSERT INTO task_entries(kind, occurred_at, destination, notes, created_by, shift, post, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (kind, occurred, dest, notes, cu["id"], shift, post, now, now),
        )
        tid = cur.lastrowid
        _audit_seed(conn, cu["id"], shift, post, "task_entries", tid, "create", None, {"kind": kind, "occurred_at": occurred, "destination": dest, "notes": notes})

    for i in range(mutasi_n):
        cu = pick_user()
        shift = pick_shift()
        post = pick_post()
        kind = random.choice(mutasi_kinds)
        y = ymd_range()
        occurred = f"{y}T{hm()}:00"
        desc = random.choice(["Antrean APM panjang","Kunci Radiologi belum diambil","Pemadaman listrik singkat","Barang hilang dilaporkan","Parkir penuh"])
        now = utc_now_iso()
        cur = conn.execute(
            """
            INSERT INTO mutasi_entries(occurred_at, kind, description, created_by, shift, post, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (occurred, kind, desc, cu["id"], shift, post, now, now),
        )
        mid = cur.lastrowid
        _audit_seed(conn, cu["id"], shift, post, "mutasi_entries", mid, "create", None, {"occurred_at": occurred, "kind": kind, "description": desc})

    conn.commit()

class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class AppHandler(BaseHTTPRequestHandler):
    server_version = "LogbookLocal/1.0"

    def log_message(self, fmt, *args):
        return

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, obj):
        self._send(status, json_dumps(obj), "application/json; charset=utf-8")

    def _redirect(self, location: str):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise HttpError(HTTPStatus.BAD_REQUEST, "JSON tidak valid")

    def _parse_cookies(self) -> SimpleCookie:
        c = SimpleCookie()
        if "Cookie" in self.headers:
            c.load(self.headers["Cookie"])
        return c

    def _get_session(self, conn: sqlite3.Connection):
        auth = (self.headers.get("Authorization") or "").strip()
        sid_value = ""
        if auth.lower().startswith("bearer "):
            sid_value = auth.split(None, 1)[1].strip()

        if not sid_value:
            raw_cookie = self.headers.get("Cookie") or ""
            cookie_map: dict[str, str] = {}
            for part in raw_cookie.split(";"):
                if "=" not in part:
                    continue
                k, v = part.split("=", 1)
                k = k.strip()
                v = v.strip()
                if v.startswith('"') and v.endswith('"') and len(v) >= 2:
                    v = v[1:-1]
                cookie_map[k] = v
            sid_value = cookie_map.get(COOKIE_NAME) or cookie_map.get("sid") or ""

        if not sid_value:
            return None
        now_ts = int(time.time())
        row = conn.execute(
            """
            SELECT s.id AS sid, s.user_id, s.shift, s.post, s.expires_at, s.last_seen_at,
                   u.username, u.display_name, u.role, u.is_active
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.id = ?
            """,
            (sid_value,),
        ).fetchone()
        if not row:
            return None
        if row["is_active"] != 1:
            return None
        if row["expires_at"] <= now_ts:
            conn.execute("DELETE FROM sessions WHERE id = ?", (sid_value,))
            conn.commit()
            return None
        conn.execute(
            "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
            (utc_now_iso(), now_ts + SESSION_TTL_SECONDS, sid_value),
        )
        conn.commit()
        return dict(row)

    def _require_session(self, conn: sqlite3.Connection):
        sess = self._get_session(conn)
        if not sess:
            raise HttpError(HTTPStatus.UNAUTHORIZED, "Harus login")
        return sess

    def _require_role(self, sess, allowed_roles: tuple[str, ...]):
        if sess.get("role") not in allowed_roles:
            raise HttpError(HTTPStatus.FORBIDDEN, "Tidak punya akses")
        return sess

    def _set_cookie(self, name: str, value: str, max_age: int | None = None):
        cookie = SimpleCookie()
        cookie[name] = value
        cookie[name]["path"] = "/"
        cookie[name]["httponly"] = True
        cookie[name]["samesite"] = "Lax"
        if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https":
            cookie[name]["secure"] = True
        if max_age is not None:
            cookie[name]["max-age"] = str(max_age)
        for morsel in cookie.values():
            self.send_header("Set-Cookie", morsel.OutputString())

    def _client_key(self) -> str:
        ip = (self.headers.get("X-Forwarded-For") or self.client_address[0] or "").split(",")[0].strip()
        ua = (self.headers.get("User-Agent") or "")[:120]
        raw = f"{ip}|{ua}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def _rate_limit_login(self, conn: sqlite3.Connection) -> bool:
        now_ts = int(time.time())
        key = self._client_key()
        row = conn.execute("SELECT key, count, first_ts, last_ts FROM login_attempts WHERE key = ?", (key,)).fetchone()
        if not row:
            conn.execute("INSERT INTO login_attempts(key, count, first_ts, last_ts) VALUES (?,?,?,?)", (key, 0, now_ts, now_ts))
            conn.commit()
            return False
        first_ts = int(row["first_ts"])
        if now_ts - first_ts > LOGIN_RATE_WINDOW_SECONDS:
            conn.execute("UPDATE login_attempts SET count=0, first_ts=?, last_ts=? WHERE key=?", (now_ts, now_ts, key))
            conn.commit()
            return False
        count = int(row["count"])
        return count >= LOGIN_RATE_MAX_ATTEMPTS

    def _record_login_attempt(self, conn: sqlite3.Connection, success: bool) -> None:
        now_ts = int(time.time())
        key = self._client_key()
        row = conn.execute("SELECT key, count, first_ts FROM login_attempts WHERE key=?", (key,)).fetchone()
        if not row:
            conn.execute("INSERT INTO login_attempts(key, count, first_ts, last_ts) VALUES (?,?,?,?)", (key, 0, now_ts, now_ts))
            row = conn.execute("SELECT key, count, first_ts FROM login_attempts WHERE key=?", (key,)).fetchone()
        first_ts = int(row["first_ts"])
        if now_ts - first_ts > LOGIN_RATE_WINDOW_SECONDS:
            conn.execute("UPDATE login_attempts SET count=?, first_ts=?, last_ts=? WHERE key=?", (0, now_ts, now_ts, key))
            conn.commit()
            return
        if success:
            conn.execute("UPDATE login_attempts SET count=0, last_ts=? WHERE key=?", (now_ts, key))
        else:
            conn.execute("UPDATE login_attempts SET count=count+1, last_ts=? WHERE key=?", (now_ts, key))
        conn.commit()

    def _clear_cookie(self, name: str):
        cookie = SimpleCookie()
        cookie[name] = ""
        cookie[name]["path"] = "/"
        cookie[name]["max-age"] = "0"
        for morsel in cookie.values():
            self.send_header("Set-Cookie", morsel.OutputString())

    def _serve_file(self, file_path: Path, content_type: str):
        if not file_path.exists():
            self._send(HTTPStatus.NOT_FOUND, b"Not found", "text/plain; charset=utf-8")
            return
        body = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _audit(self, conn: sqlite3.Connection, sess, table_name: str, record_id: str, action: str, before, after):
        target = {
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
        conn.execute(
            """
            INSERT INTO audit_log(actor_user_id, target_key_transaction_id, target_guest_entry_id, target_mutasi_entry_id, target_task_entry_id, target_user_id,
                                  action, actor_shift, actor_post, before_json, after_json, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
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

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")

        if path == "/" or path == "/index.html":
            self._serve_file(ROOT_DIR / "index.html", "text/html; charset=utf-8")
            return

        if path == "/styles.css":
            self._serve_file(ROOT_DIR / "styles.css", "text/css; charset=utf-8")
            return

        if path == "/react" or path == "/react/index.html":
            react_index = ROOT_DIR / "react-ui" / "dist" / "index.html"
            if react_index.exists():
                self._serve_file(react_index, "text/html; charset=utf-8")
                return
            self._send(HTTPStatus.NOT_FOUND, b"React UI belum dibuild. Jalankan: cd react-ui && npm install && npm run build", "text/plain; charset=utf-8")
            return

        if path.startswith("/react/assets/"):
            rel = path.removeprefix("/react/")
            file_path = ROOT_DIR / "react-ui" / "dist" / rel
            ext = file_path.suffix.lower()
            if ext == ".js":
                ctype = "text/javascript; charset=utf-8"
            elif ext == ".css":
                ctype = "text/css; charset=utf-8"
            elif ext == ".svg":
                ctype = "image/svg+xml"
            elif ext == ".png":
                ctype = "image/png"
            elif ext == ".jpg" or ext == ".jpeg":
                ctype = "image/jpeg"
            else:
                ctype = "application/octet-stream"
            self._serve_file(file_path, ctype)
            return

        if path == "/app.html":
            self._serve_file(ROOT_DIR / "app.html", "text/html; charset=utf-8")
            return

        if path.startswith("/api/"):
            conn = db_connect()
            try:
                self._handle_api_get(conn, path, parse_qs(parsed.query))
                return
            except HttpError as e:
                self._send_json(e.status, {"error": e.message})
                return
            except sqlite3.OperationalError as e:
                msg = str(e).lower()
                if "locked" in msg or "busy" in msg:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Database sedang sibuk. Coba ulangi."})
                    return
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Kesalahan server"})
                return
            finally:
                conn.close()

        self._send(HTTPStatus.NOT_FOUND, b"Not found", "text/plain; charset=utf-8")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")

        if not path.startswith("/api/"):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Endpoint tidak ditemukan"})
            return

        conn = db_connect()
        try:
            self._handle_api_post(conn, path)
            return
        except HttpError as e:
            self._send_json(e.status, {"error": e.message})
            return
        except sqlite3.OperationalError as e:
            msg = str(e).lower()
            if "locked" in msg or "busy" in msg:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Database sedang sibuk. Coba ulangi."})
                return
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Kesalahan server"})
            return
        finally:
            conn.close()

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")

        if not path.startswith("/api/"):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Endpoint tidak ditemukan"})
            return

        conn = db_connect()
        try:
            self._handle_api_patch(conn, path)
            return
        except HttpError as e:
            self._send_json(e.status, {"error": e.message})
            return
        except sqlite3.OperationalError as e:
            msg = str(e).lower()
            if "locked" in msg or "busy" in msg:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Database sedang sibuk. Coba ulangi."})
                return
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Kesalahan server"})
            return
        finally:
            conn.close()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")

        if not path.startswith("/api/"):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Endpoint tidak ditemukan"})
            return

        conn = db_connect()
        try:
            self._handle_api_delete(conn, path, parse_qs(parsed.query))
            return
        except HttpError as e:
            self._send_json(e.status, {"error": e.message})
            return
        except sqlite3.OperationalError as e:
            msg = str(e).lower()
            if "locked" in msg or "busy" in msg:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Database sedang sibuk. Coba ulangi."})
                return
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Kesalahan server"})
            return
        finally:
            conn.close()

    def _handle_api_get(self, conn: sqlite3.Connection, path: str, query):
        if path == "/api/health":
            self._send_json(HTTPStatus.OK, {"ok": True, "build": "admin_v1"})
            return

        if path == "/api/me":
            sess = self._require_session(conn)
            self._send_json(
                HTTPStatus.OK,
                {
                    "user": {
                        "id": sess["user_id"],
                        "username": sess["username"],
                        "display_name": sess["display_name"],
                        "role": sess["role"],
                    },
                    "shift": sess["shift"],
                    "post": sess["post"],
                },
            )
            return

        sess = self._require_session(conn)

        if path == "/api/handover":
            keys_open = conn.execute(
                """
                SELECT id, borrower_name, unit, key_name, checkout_at, notes, status
                FROM key_transactions
                WHERE status = 'open'
                ORDER BY datetime(checkout_at) DESC
                LIMIT 50
                """
            ).fetchall()
            guests_in = conn.execute(
                """
                SELECT id, name, instansi, purpose, meet_person, checkin_at, status
                FROM guest_entries
                WHERE status = 'in'
                ORDER BY datetime(checkin_at) DESC
                LIMIT 50
                """
            ).fetchall()
            self._send_json(
                HTTPStatus.OK,
                {
                    "open_keys": [dict(r) for r in keys_open],
                    "guests_in": [dict(r) for r in guests_in],
                },
            )
            return

        if path == "/api/keys":
            status = (query.get("status") or ["open"])[0]
            q = normalize_text((query.get("q") or [""])[0])
            params = []
            where = []
            if status in ("open", "closed", "void"):
                where.append("status = ?")
                params.append(status)
            if q:
                where.append("(borrower_name_norm LIKE ? OR key_name_norm LIKE ?)")
                params.append(f"%{q}%")
                params.append(f"%{q}%")
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
            sql += " ORDER BY datetime(kt.checkout_at) DESC LIMIT 200"
            rows = conn.execute(sql, tuple(params)).fetchall()
            self._send_json(HTTPStatus.OK, {"items": [dict(r) for r in rows]})
            return

        if path == "/api/mutasi":
            q = normalize_text((query.get("q") or [""])[0])
            params = []
            where = []
            if q:
                where.append("(lower(kind) LIKE ? OR lower(description) LIKE ?)")
                params.append(f"%{q}%")
                params.append(f"%{q}%")
            sql = """
              SELECT m.id, m.occurred_at, m.kind, m.description, u.display_name AS created_by_name, m.shift, m.post
              FROM mutasi_entries m
              JOIN users u ON u.id = m.created_by
            """
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY datetime(m.occurred_at) DESC LIMIT 200"
            rows = conn.execute(sql, tuple(params)).fetchall()
            self._send_json(HTTPStatus.OK, {"items": [dict(r) for r in rows]})
            return

        if path == "/api/guests":
            status = (query.get("status") or ["in"])[0]
            q = normalize_text((query.get("q") or [""])[0])
            params = []
            where = []
            if status in ("in", "out"):
                where.append("status = ?")
                params.append(status)
            if q:
                where.append("(lower(name) LIKE ? OR lower(instansi) LIKE ? OR lower(purpose) LIKE ?)")
                params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
            sql = """
              SELECT g.id, g.name, g.instansi, g.purpose, g.meet_person, g.checkin_at, g.checkout_at, g.notes, g.status,
                     u.display_name AS created_by_name, g.shift, g.post
              FROM guest_entries g
              JOIN users u ON u.id = g.created_by
            """
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY datetime(g.checkin_at) DESC LIMIT 200"
            rows = conn.execute(sql, tuple(params)).fetchall()
            self._send_json(HTTPStatus.OK, {"items": [dict(r) for r in rows]})
            return

        if path == "/api/tasks":
            q = normalize_text((query.get("q") or [""])[0])
            params = []
            where = []
            if q:
                where.append("(lower(kind) LIKE ? OR lower(destination) LIKE ? OR lower(notes) LIKE ?)")
                params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
            sql = """
              SELECT t.id, t.kind, t.occurred_at, t.destination, t.notes, u.display_name AS created_by_name, t.shift, t.post
              FROM task_entries t
              JOIN users u ON u.id = t.created_by
            """
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY datetime(t.occurred_at) DESC LIMIT 200"
            rows = conn.execute(sql, tuple(params)).fetchall()
            self._send_json(HTTPStatus.OK, {"items": [dict(r) for r in rows]})
            return

        if path == "/api/report/shift":
            params = query
            date = (params.get("date") or [""])[0]
            shift = (params.get("shift") or [""])[0]
            post = (params.get("post") or [""])[0]
            if not date:
                date = datetime.now().strftime("%Y-%m-%d")
            start = f"{date}T00:00:00"
            end = f"{date}T23:59:59"

            key_total = conn.execute(
                "SELECT COUNT(1) AS c FROM key_transactions WHERE checkout_at BETWEEN ? AND ?",
                (start, end),
            ).fetchone()["c"]
            key_open = conn.execute(
                "SELECT COUNT(1) AS c FROM key_transactions WHERE status='open'",
            ).fetchone()["c"]
            guest_total = conn.execute(
                "SELECT COUNT(1) AS c FROM guest_entries WHERE checkin_at BETWEEN ? AND ?",
                (start, end),
            ).fetchone()["c"]
            task_total = conn.execute(
                "SELECT COUNT(1) AS c FROM task_entries WHERE occurred_at BETWEEN ? AND ?",
                (start, end),
            ).fetchone()["c"]
            mutasi_total = conn.execute(
                "SELECT COUNT(1) AS c FROM mutasi_entries WHERE occurred_at BETWEEN ? AND ?",
                (start, end),
            ).fetchone()["c"]

            self._send_json(
                HTTPStatus.OK,
                {
                    "date": date,
                    "shift": shift or sess["shift"],
                    "post": post or sess["post"],
                    "counts": {
                        "keys_total": key_total,
                        "keys_open": key_open,
                        "guests_total": guest_total,
                        "tasks_total": task_total,
                        "mutasi_total": mutasi_total,
                    },
                },
            )
            return

        if path.startswith("/api/audit/"):
            record = path.split("/", 3)[3]
            if ":" not in record:
                raise HttpError(HTTPStatus.BAD_REQUEST, "Format audit salah")
            table_name, record_id = record.split(":", 1)
            rows = conn.execute(
                """
                SELECT a.id, a.action, a.created_at, u.display_name AS actor_name, a.actor_shift, a.actor_post, a.before_json, a.after_json
                FROM audit_log a
                JOIN users u ON u.id = a.actor_user_id
                WHERE
                  CASE
                    WHEN ? = 'key_transactions' THEN a.target_key_transaction_id = CAST(? AS INTEGER)
                    WHEN ? = 'guest_entries' THEN a.target_guest_entry_id = CAST(? AS INTEGER)
                    WHEN ? = 'mutasi_entries' THEN a.target_mutasi_entry_id = CAST(? AS INTEGER)
                    WHEN ? = 'task_entries' THEN a.target_task_entry_id = CAST(? AS INTEGER)
                    WHEN ? = 'users' THEN a.target_user_id = CAST(? AS INTEGER)
                    WHEN ? = 'auth' THEN a.target_user_id = CAST(? AS INTEGER)
                    ELSE 0
                  END
                ORDER BY a.id DESC
                LIMIT 50
                """,
                (table_name, record_id, table_name, record_id, table_name, record_id, table_name, record_id, table_name, record_id, table_name, record_id),
            ).fetchall()
            items = []
            for r in rows:
                items.append(
                    {
                        "id": r["id"],
                        "action": r["action"],
                        "created_at": r["created_at"],
                        "actor_name": r["actor_name"],
                        "actor_shift": r["actor_shift"],
                        "actor_post": r["actor_post"],
                        "before": json.loads(r["before_json"]) if r["before_json"] else None,
                        "after": json.loads(r["after_json"]) if r["after_json"] else None,
                    }
                )
            self._send_json(HTTPStatus.OK, {"items": items})
            return

        if path == "/api/admin/users":
            self._require_role(sess, ("admin",))
            q = normalize_text((query.get("q") or [""])[0])
            params = []
            where = []
            if q:
                where.append("(lower(username) LIKE ? OR lower(display_name) LIKE ? OR lower(role) LIKE ?)")
                params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
            sql = "SELECT id, username, display_name, role, is_active, created_at FROM users"
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY id ASC"
            rows = conn.execute(sql, tuple(params)).fetchall()
            self._send_json(HTTPStatus.OK, {"items": [dict(r) for r in rows]})
            return

        if path == "/api/admin/audit":
            self._require_role(sess, ("admin",))
            q = normalize_text((query.get("q") or [""])[0])
            table_name = normalize_text((query.get("table_name") or [""])[0])
            record_id = (query.get("record_id") or [""])[0].strip()
            limit_raw = (query.get("limit") or ["100"])[0]
            try:
                limit = max(1, min(200, int(limit_raw)))
            except Exception:
                limit = 100

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
            params = []
            if table_name:
                filters.append("lower(CASE WHEN a.target_key_transaction_id IS NOT NULL THEN 'key_transactions' WHEN a.target_guest_entry_id IS NOT NULL THEN 'guest_entries' WHEN a.target_mutasi_entry_id IS NOT NULL THEN 'mutasi_entries' WHEN a.target_task_entry_id IS NOT NULL THEN 'task_entries' WHEN a.target_user_id IS NOT NULL THEN 'users' ELSE 'unknown' END) = ?")
                params.append(table_name)
            if record_id:
                filters.append("COALESCE(a.target_key_transaction_id, a.target_guest_entry_id, a.target_mutasi_entry_id, a.target_task_entry_id, a.target_user_id) = CAST(? AS INTEGER)")
                params.append(record_id)
            if q:
                filters.append("(lower(a.action) LIKE ? OR lower(u.display_name) LIKE ?)")
                params.extend([f"%{q}%", f"%{q}%"])
            if filters:
                base += " WHERE " + " AND ".join(filters)
            base += " ORDER BY a.id DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(base, tuple(params)).fetchall()
            items = []
            for r in rows:
                items.append({
                    "id": r["id"],
                    "table_name": r["table_name"],
                    "record_id": str(r["record_id"]) if r["record_id"] is not None else "",
                    "action": r["action"],
                    "created_at": r["created_at"],
                    "actor_name": r["actor_name"],
                    "actor_shift": r["actor_shift"],
                    "actor_post": r["actor_post"],
                })
            self._send_json(HTTPStatus.OK, {"items": items})
            return

        if path == "/api/admin/security_history":
            self._require_role(sess, ("admin",))
            user_id = (query.get("user_id") or [""])[0].strip()
            if not user_id:
                raise HttpError(HTTPStatus.BAD_REQUEST, "user_id wajib")
            limit_raw = (query.get("limit") or ["120"])[0]
            try:
                limit = max(1, min(300, int(limit_raw)))
            except Exception:
                limit = 120

            rows = conn.execute(
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
                WHERE a.actor_user_id = ?
                ORDER BY a.id DESC
                LIMIT ?
                """,
                (user_id, limit),
            ).fetchall()
            items = []
            for r in rows:
                items.append(
                    {
                        "id": r["id"],
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
            self._send_json(HTTPStatus.OK, {"items": items})
            return

        raise HttpError(HTTPStatus.NOT_FOUND, "Endpoint tidak ditemukan")

    def _handle_api_post(self, conn: sqlite3.Connection, path: str):
        if path == "/api/login":
            if self._rate_limit_login(conn):
                raise HttpError(HTTPStatus.TOO_MANY_REQUESTS, "Terlalu banyak percobaan login. Coba lagi beberapa menit.")
            data = self._read_json()
            username = normalize_text(data.get("username", ""))
            password = data.get("password", "") or ""
            shift = (data.get("shift") or "").strip() or "Pagi"
            post = (data.get("post") or "").strip() or "IGD"
            if not username or not password:
                self._record_login_attempt(conn, success=False)
                raise HttpError(HTTPStatus.BAD_REQUEST, "Username dan password wajib diisi")
            user = conn.execute(
                "SELECT id, username, display_name, password_hash, role, is_active FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            if not user or user["is_active"] != 1:
                self._record_login_attempt(conn, success=False)
                raise HttpError(HTTPStatus.UNAUTHORIZED, "Login gagal")
            if not pbkdf2_verify_password(password, user["password_hash"]):
                self._record_login_attempt(conn, success=False)
                raise HttpError(HTTPStatus.UNAUTHORIZED, "Login gagal")

            sid = secrets.token_urlsafe(32)
            now_ts = int(time.time())
            conn.execute(
                "INSERT INTO sessions(id, user_id, created_at, last_seen_at, shift, post, expires_at) VALUES (?,?,?,?,?,?,?)",
                (sid, user["id"], utc_now_iso(), utc_now_iso(), shift, post, now_ts + SESSION_TTL_SECONDS),
            )
            self._audit(
                conn,
                {"user_id": user["id"], "shift": shift, "post": post},
                "auth",
                str(user["id"]),
                "login",
                None,
                {"sid": sid, "shift": shift, "post": post},
            )
            conn.commit()
            self._record_login_attempt(conn, success=True)

            self.send_response(HTTPStatus.OK)
            self._set_cookie(COOKIE_NAME, sid, max_age=SESSION_TTL_SECONDS)
            self._clear_cookie("sid")
            body = json_dumps(
                {
                    "ok": True,
                    "token": sid,
                    "user": {
                        "id": user["id"],
                        "username": user["username"],
                        "display_name": user["display_name"],
                        "role": user["role"],
                    },
                    "shift": shift,
                    "post": post,
                }
            )
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/logout":
            sess = self._get_session(conn)
            if sess:
                self._audit(conn, sess, "auth", str(sess["user_id"]), "logout", None, {"sid": sess["sid"], "shift": sess["shift"], "post": sess["post"]})
                conn.execute("DELETE FROM sessions WHERE id = ?", (sess["sid"],))
                conn.commit()
            self.send_response(HTTPStatus.OK)
            self._clear_cookie(COOKIE_NAME)
            self._clear_cookie("sid")
            body = json_dumps({"ok": True})
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        sess = self._require_session(conn)
        data = self._read_json()

        if path == "/api/admin/users":
            self._require_role(sess, ("admin",))
            username = normalize_text(data.get("username") or "")
            display_name = (data.get("display_name") or "").strip() or username.upper()
            role = (data.get("role") or "").strip() or "guard"
            password = data.get("password") or ""
            if not username:
                raise HttpError(HTTPStatus.BAD_REQUEST, "Username wajib diisi")
            if role not in ("guard", "supervisor", "admin"):
                raise HttpError(HTTPStatus.BAD_REQUEST, "Role tidak valid")
            if len(password) < 4:
                raise HttpError(HTTPStatus.BAD_REQUEST, "Password minimal 4 karakter")
            now = utc_now_iso()
            try:
                cur = conn.execute(
                    "INSERT INTO users(username, display_name, password_hash, role, is_active, created_at) VALUES (?,?,?,?,?,?)",
                    (username, display_name, pbkdf2_hash_password(password), role, 1, now),
                )
            except sqlite3.IntegrityError:
                raise HttpError(HTTPStatus.CONFLICT, "Username sudah dipakai")
            record_id = cur.lastrowid
            self._audit(
                conn,
                sess,
                "users",
                str(record_id),
                "create",
                None,
                {"id": record_id, "username": username, "display_name": display_name, "role": role, "is_active": 1, "created_at": now},
            )
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True, "id": record_id})
            return

        if path.startswith("/api/admin/users/") and path.endswith("/reset_password"):
            self._require_role(sess, ("admin",))
            parts = path.split("/")
            if len(parts) < 5:
                raise HttpError(HTTPStatus.BAD_REQUEST, "ID tidak valid")
            user_id = parts[4]
            row = conn.execute("SELECT id, username, display_name, role, is_active FROM users WHERE id=?", (user_id,)).fetchone()
            if not row:
                raise HttpError(HTTPStatus.NOT_FOUND, "User tidak ditemukan")
            temp_password = secrets.token_urlsafe(9)[:10]
            before = dict(row)
            now = utc_now_iso()
            conn.execute("UPDATE users SET password_hash=? WHERE id=?", (pbkdf2_hash_password(temp_password), user_id))
            after = {**before, "updated_at": now}
            self._audit(conn, sess, "users", str(user_id), "reset_password", before, after)
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True, "temp_password": temp_password})
            return

        if path == "/api/keys":
            borrower_name = (data.get("borrower_name") or "").strip() or "Tidak diketahui"
            unit = (data.get("unit") or "").strip() or "-"
            key_name = (data.get("key_name") or "").strip()
            checkout_at = (data.get("checkout_at") or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            notes = (data.get("notes") or "").strip()
            if not key_name:
                raise HttpError(HTTPStatus.BAD_REQUEST, "Kunci/ruangan wajib diisi")

            key_norm = normalize_text(key_name)
            borrower_norm = normalize_text(borrower_name)
            existing_open = conn.execute(
                "SELECT id, borrower_name, unit, key_name, checkout_at FROM key_transactions WHERE status='open' AND key_name_norm=?",
                (key_norm,),
            ).fetchone()
            if existing_open and not data.get("force"):
                raise HttpError(
                    HTTPStatus.CONFLICT,
                    f"Kunci '{existing_open['key_name']}' masih tercatat dipinjam (ID {existing_open['id']}).",
                )

            recent_dup = conn.execute(
                """
                SELECT id FROM key_transactions
                WHERE borrower_name_norm=? AND key_name_norm=? AND status='open'
                LIMIT 1
                """,
                (borrower_norm, key_norm),
            ).fetchone()
            if recent_dup and not data.get("force"):
                raise HttpError(HTTPStatus.CONFLICT, f"Transaksi serupa sudah ada (ID {recent_dup['id']}).")

            now = utc_now_iso()
            cur = conn.execute(
                """
                INSERT INTO key_transactions(
                  borrower_name, borrower_name_norm, unit, key_name, key_name_norm, checkout_at, checkin_at, notes, status,
                  created_by, created_shift, created_post, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
            record_id = cur.lastrowid
            self._audit(
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
                },
            )
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True, "id": record_id})
            return

        if path.startswith("/api/keys/") and path.endswith("/return"):
            parts = path.split("/")
            if len(parts) < 4:
                raise HttpError(HTTPStatus.BAD_REQUEST, "ID tidak valid")
            record_id = parts[3]
            row = conn.execute("SELECT * FROM key_transactions WHERE id = ?", (record_id,)).fetchone()
            if not row:
                raise HttpError(HTTPStatus.NOT_FOUND, "Data tidak ditemukan")
            if row["status"] != "open":
                raise HttpError(HTTPStatus.BAD_REQUEST, "Transaksi sudah ditutup")
            now = utc_now_iso()
            conn.execute(
                """
                UPDATE key_transactions
                SET status='closed', checkin_at=?, closed_by=?, closed_shift=?, closed_post=?, updated_at=?
                WHERE id = ?
                """,
                (now, sess["user_id"], sess["shift"], sess["post"], now, record_id),
            )
            self._audit(
                conn,
                sess,
                "key_transactions",
                record_id,
                "close",
                dict(row),
                {**dict(row), "status": "closed", "checkin_at": now, "closed_by": sess["user_id"], "closed_shift": sess["shift"], "closed_post": sess["post"], "updated_at": now},
            )
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if path == "/api/mutasi":
            occurred_at = (data.get("occurred_at") or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            kind = (data.get("kind") or "").strip() or "Lainnya"
            description = (data.get("description") or "").strip()
            if not description:
                raise HttpError(HTTPStatus.BAD_REQUEST, "Deskripsi wajib diisi")
            now = utc_now_iso()
            cur = conn.execute(
                """
                INSERT INTO mutasi_entries(occurred_at, kind, description, created_by, shift, post, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                (occurred_at, kind, description, sess["user_id"], sess["shift"], sess["post"], now, now),
            )
            record_id = cur.lastrowid
            self._audit(conn, sess, "mutasi_entries", str(record_id), "create", None, {"occurred_at": occurred_at, "kind": kind, "description": description})
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True, "id": record_id})
            return

        if path == "/api/guests":
            name = (data.get("name") or "").strip() or "Tidak diketahui"
            instansi = (data.get("instansi") or "").strip() or "-"
            purpose = (data.get("purpose") or "").strip() or "-"
            meet_person = (data.get("meet_person") or "").strip() or "-"
            checkin_at = (data.get("checkin_at") or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            notes = (data.get("notes") or "").strip()
            now = utc_now_iso()
            cur = conn.execute(
                """
                INSERT INTO guest_entries(name, instansi, purpose, meet_person, checkin_at, checkout_at, notes, status, created_by, shift, post, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (name, instansi, purpose, meet_person, checkin_at, None, notes, "in", sess["user_id"], sess["shift"], sess["post"], now, now),
            )
            record_id = cur.lastrowid
            self._audit(conn, sess, "guest_entries", str(record_id), "create", None, {"name": name, "instansi": instansi, "purpose": purpose, "meet_person": meet_person, "checkin_at": checkin_at, "status": "in", "notes": notes})
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True, "id": record_id})
            return

        if path.startswith("/api/guests/") and path.endswith("/checkout"):
            parts = path.split("/")
            record_id = parts[3] if len(parts) >= 4 else ""
            row = conn.execute("SELECT * FROM guest_entries WHERE id = ?", (record_id,)).fetchone()
            if not row:
                raise HttpError(HTTPStatus.NOT_FOUND, "Data tidak ditemukan")
            if row["status"] != "in":
                raise HttpError(HTTPStatus.BAD_REQUEST, "Tamu sudah checkout")
            now = utc_now_iso()
            conn.execute(
                "UPDATE guest_entries SET status='out', checkout_at=?, updated_at=? WHERE id=?",
                (now, now, record_id),
            )
            self._audit(conn, sess, "guest_entries", str(record_id), "checkout", dict(row), {**dict(row), "status": "out", "checkout_at": now, "updated_at": now})
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if path == "/api/tasks":
            kind = (data.get("kind") or "").strip() or "Lainnya"
            occurred_at = (data.get("occurred_at") or "").strip() or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            destination = (data.get("destination") or "").strip() or "-"
            notes = (data.get("notes") or "").strip()
            now = utc_now_iso()
            cur = conn.execute(
                """
                INSERT INTO task_entries(kind, occurred_at, destination, notes, created_by, shift, post, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (kind, occurred_at, destination, notes, sess["user_id"], sess["shift"], sess["post"], now, now),
            )
            record_id = cur.lastrowid
            self._audit(conn, sess, "task_entries", str(record_id), "create", None, {"kind": kind, "occurred_at": occurred_at, "destination": destination, "notes": notes})
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True, "id": record_id})
            return

        raise HttpError(HTTPStatus.NOT_FOUND, "Endpoint tidak ditemukan")

    def _handle_api_patch(self, conn: sqlite3.Connection, path: str):
        sess = self._require_session(conn)
        data = self._read_json()

        if path.startswith("/api/admin/users/") and path.count("/") == 4:
            self._require_role(sess, ("admin",))
            user_id = path.split("/")[4]
            row = conn.execute("SELECT id, username, display_name, role, is_active, created_at FROM users WHERE id=?", (user_id,)).fetchone()
            if not row:
                raise HttpError(HTTPStatus.NOT_FOUND, "User tidak ditemukan")
            if str(row["id"]) == str(sess["user_id"]) and "is_active" in data and int(data.get("is_active") or 0) == 0:
                raise HttpError(HTTPStatus.BAD_REQUEST, "Tidak bisa menonaktifkan akun sendiri")

            before = dict(row)
            updates = {}
            if "display_name" in data:
                updates["display_name"] = (data.get("display_name") or "").strip() or row["display_name"]
            if "role" in data:
                role = (data.get("role") or "").strip()
                if role not in ("guard", "supervisor", "admin"):
                    raise HttpError(HTTPStatus.BAD_REQUEST, "Role tidak valid")
                updates["role"] = role
            if "is_active" in data:
                updates["is_active"] = 1 if int(data.get("is_active") or 0) == 1 else 0

            if not updates:
                self._send_json(HTTPStatus.OK, {"ok": True})
                return

            cols = ", ".join([f"{k}=?" for k in updates.keys()])
            params = list(updates.values()) + [user_id]
            conn.execute(f"UPDATE users SET {cols} WHERE id=?", params)
            after = dict(conn.execute("SELECT id, username, display_name, role, is_active, created_at FROM users WHERE id=?", (user_id,)).fetchone())
            self._audit(conn, sess, "users", str(user_id), "update", before, after)
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if path.startswith("/api/keys/") and path.count("/") == 3:
            record_id = path.split("/")[3]
            row = conn.execute("SELECT * FROM key_transactions WHERE id=?", (record_id,)).fetchone()
            if not row:
                raise HttpError(HTTPStatus.NOT_FOUND, "Data tidak ditemukan")

            if row["status"] != "open":
                if sess["role"] not in ("supervisor", "admin"):
                    raise HttpError(HTTPStatus.FORBIDDEN, "Transaksi sudah ditutup")

            allowed = set()
            if sess["role"] in ("supervisor", "admin"):
                allowed = {"borrower_name", "unit", "key_name", "checkout_at", "notes"}
            else:
                if row["created_by"] == sess["user_id"]:
                    allowed = {"notes"}

            updates = {}
            for k in allowed:
                if k in data:
                    updates[k] = (data.get(k) or "").strip()

            if not updates:
                self._send_json(HTTPStatus.OK, {"ok": True})
                return

            before = dict(row)
            if "borrower_name" in updates:
                updates["borrower_name_norm"] = normalize_text(updates["borrower_name"] or "Tidak diketahui")
            if "key_name" in updates:
                if not updates["key_name"]:
                    raise HttpError(HTTPStatus.BAD_REQUEST, "Kunci/ruangan tidak boleh kosong")
                updates["key_name_norm"] = normalize_text(updates["key_name"])

            if "borrower_name" in updates and not updates["borrower_name"]:
                updates["borrower_name"] = "Tidak diketahui"
            if "unit" in updates and not updates["unit"]:
                updates["unit"] = "-"

            updates["updated_at"] = utc_now_iso()
            cols = ", ".join([f"{k}=?" for k in updates.keys()])
            params = list(updates.values()) + [record_id]
            conn.execute(f"UPDATE key_transactions SET {cols} WHERE id=?", params)
            after = dict(conn.execute("SELECT * FROM key_transactions WHERE id=?", (record_id,)).fetchone())
            self._audit(conn, sess, "key_transactions", record_id, "update", before, after)
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        raise HttpError(HTTPStatus.NOT_FOUND, "Endpoint tidak ditemukan")

    def _handle_api_delete(self, conn: sqlite3.Connection, path: str, query):
        sess = self._require_session(conn)
        self._require_role(sess, ("admin",))

        if path == "/api/admin/security_history":
            user_id = (query.get("user_id") or [""])[0].strip()
            if not user_id:
                raise HttpError(HTTPStatus.BAD_REQUEST, "user_id wajib")
            keep_raw = (query.get("keep") or ["0"])[0]
            try:
                keep = max(0, min(500, int(keep_raw)))
            except Exception:
                keep = 0

            if keep > 0:
                conn.execute(
                    """
                    DELETE FROM audit_log
                    WHERE actor_user_id = ?
                      AND id NOT IN (
                        SELECT id FROM audit_log
                        WHERE actor_user_id = ?
                        ORDER BY id DESC
                        LIMIT ?
                      )
                    """,
                    (user_id, user_id, keep),
                )
            else:
                conn.execute("DELETE FROM audit_log WHERE actor_user_id = ?", (user_id,))
            deleted = conn.execute("SELECT changes() AS c").fetchone()["c"]
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True, "deleted": deleted, "kept": keep})
            return

        if path.startswith("/api/admin/records/") and path.count("/") == 4:
            table_name = path.split("/")[4]
            allowed = {"key_transactions", "mutasi_entries", "guest_entries", "task_entries"}
            if table_name not in allowed:
                raise HttpError(HTTPStatus.BAD_REQUEST, "Table tidak diizinkan")
            record_id = (query.get("id") or [""])[0].strip()
            note = (query.get("note") or [""])[0].strip()
            if not record_id:
                raise HttpError(HTTPStatus.BAD_REQUEST, "id wajib")

            if table_name == "key_transactions":
                row = conn.execute("SELECT * FROM key_transactions WHERE id=?", (record_id,)).fetchone()
                if not row:
                    raise HttpError(HTTPStatus.NOT_FOUND, "Data tidak ditemukan")
                if row["status"] == "void":
                    self._send_json(HTTPStatus.OK, {"ok": True})
                    return
                before = dict(row)
                now = utc_now_iso()
                conn.execute(
                    "UPDATE key_transactions SET status='void', void_reason=?, updated_at=? WHERE id=?",
                    (note or f"void oleh admin {sess['user_id']}", now, record_id),
                )
                after = dict(conn.execute("SELECT * FROM key_transactions WHERE id=?", (record_id,)).fetchone())
                self._audit(conn, sess, "key_transactions", str(record_id), "void", before, after)
                conn.commit()
                self._send_json(HTTPStatus.OK, {"ok": True, "mode": "void"})
                return

            row = conn.execute(f"SELECT * FROM {table_name} WHERE id=?", (record_id,)).fetchone()
            if not row:
                raise HttpError(HTTPStatus.NOT_FOUND, "Data tidak ditemukan")
            before = dict(row)
            conn.execute(f"DELETE FROM {table_name} WHERE id=?", (record_id,))
            self._audit(conn, sess, table_name, str(record_id), "delete", before, {"note": note} if note else None)
            conn.commit()
            self._send_json(HTTPStatus.OK, {"ok": True, "mode": "deleted"})
            return

        if path.startswith("/api/admin/users/") and path.endswith("/delete"):
            parts = path.split("/")
            if len(parts) < 6:
                raise HttpError(HTTPStatus.BAD_REQUEST, "ID tidak valid")
            user_id = parts[4]
            row = conn.execute("SELECT id, username, display_name, role, is_active, created_at FROM users WHERE id=?", (user_id,)).fetchone()
            if not row:
                raise HttpError(HTTPStatus.NOT_FOUND, "User tidak ditemukan")
            if str(row["id"]) == str(sess["user_id"]):
                raise HttpError(HTTPStatus.BAD_REQUEST, "Tidak bisa menghapus akun sendiri")

            before = dict(row)
            try:
                conn.execute("DELETE FROM users WHERE id=?", (user_id,))
                self._audit(conn, sess, "users", str(user_id), "delete", before, None)
                conn.commit()
                self._send_json(HTTPStatus.OK, {"ok": True, "mode": "deleted"})
                return
            except sqlite3.IntegrityError:
                conn.execute("UPDATE users SET is_active=0 WHERE id=?", (user_id,))
                after = {**before, "is_active": 0}
                self._audit(conn, sess, "users", str(user_id), "deactivate", before, after)
                conn.commit()
                self._send_json(HTTPStatus.OK, {"ok": True, "mode": "deactivated"})
                return

        raise HttpError(HTTPStatus.NOT_FOUND, "Endpoint tidak ditemukan")


def main():
    db_init()
    if "--seed" in sys.argv[1:]:
        conn = db_connect()
        seed_data(conn, {"keys": 80, "guests": 80, "tasks": 80, "mutasi": 80})
        conn.close()
    server = ThreadingHTTPServer(("127.0.0.1", 5173), AppHandler)
    try:
        import hashlib

        sha1 = hashlib.sha1(Path(__file__).read_bytes()).hexdigest()[:10]
    except Exception:
        sha1 = "unknown"
    print(f"Logbook lokal berjalan di http://localhost:5173/ (build=admin_v1, sha1={sha1})")
    server.serve_forever()


if __name__ == "__main__":
    main()

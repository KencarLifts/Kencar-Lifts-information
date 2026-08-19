#!/usr/bin/env python3
"""LiftOps multi-user server.

Standard-library-only HTTP + SQLite backend for the LiftOps PWA.
Run: python3 server.py --host 0.0.0.0 --port 8080
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import sys
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
DB_PATH = Path(os.environ.get("LIFTOPS_DB", DATA_DIR / "liftops.db"))
SESSION_SECONDS = int(os.environ.get("LIFTOPS_SESSION_SECONDS", "1800"))
PBKDF2_ITERATIONS = int(os.environ.get("LIFTOPS_PBKDF2_ITERATIONS", "310000"))
COOKIE_NAME = "liftops_session"
ALLOWED_ROLES = {"Administrator", "Manager", "Technician"}
ALLOWED_STATUS = {"Approved", "Pending", "Rejected"}
STATE_DATASETS = {"elevators", "orders", "installations", "maintenance"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def now_epoch() -> int:
    return int(time.time())


def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:18]}"


def json_dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_b64, digest_b64 = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def seed_data() -> dict[str, list]:
    return {
        "elevators": [
            {"id":"elv_001","factoryNO":"F-2024-001","address":"18 Harbour Road","gpsLongitude":"14.5146","gpsLatitude":"35.8997","location":"Valletta Tower A","inUsedYear":"2024","elevatorModel":"LX-1000","elevatorType":"Passenger","floorStationDoor":"12 / 12 / 1","ratedLoadKg":"1000","ratedSpeedMs":"1.75","fullCertificateDate":"2024-02-20","certificateNumber":"CERT-00124","inspectionOrganization":"National Lift Inspection","useOccasion":"Office","useType":"Commercial","lastAnnualInspectionDate":"2026-02-12","nextAnnualInspectionDate":"2026-08-12","manufacturerName":"LiftWorks","firstUpkeepDate":"2024-03-15","propertyContact":"Facilities Desk","scheduleInstallTime":"2023-11-06","installationEndDate":"2024-01-22","commissioningDate":"2024-02-05","handoverDate":"2024-02-27","quotationNumber":"Q-23091","contractNumber":"C-23104","orderDate":"2023-08-18","productionScheduleTime":"2023-09-11","shaftWidth":"2100","shaftDepth":"2200","cabinWidth":"1600","cabinDepth":"1500","pitDepth":"1600","overhead":"4200","travelDistance":"38","ratedPowerKw":"12.5","doorWidthMm":"900","iotCode":"IOT-1001","remoteCall":"","elevatorStatus":"Online","lastUpdatePerson":"Site Administrator","lastUpdateTime":"2026-08-18T10:15","servicesPerYear":"6","lastMaintenanceContractDate":"2026-01-01"},
            {"id":"elv_002","factoryNO":"F-2023-117","address":"42 Central Avenue","gpsLongitude":"14.4860","gpsLatitude":"35.8950","location":"Central Mall - East","inUsedYear":"2023","elevatorModel":"FX-1600","elevatorType":"Freight","floorStationDoor":"6 / 6 / 2","ratedLoadKg":"1600","ratedSpeedMs":"1.0","certificateNumber":"CERT-00981","manufacturerName":"Elevatec","iotCode":"IOT-1002","remoteCall":"","elevatorStatus":"Offline","lastUpdatePerson":"Technician One","lastUpdateTime":"2026-08-18T08:42","servicesPerYear":"12","useType":"Commercial","lastAnnualInspectionDate":"2026-04-21","nextAnnualInspectionDate":"2026-10-21"},
            {"id":"elv_003","factoryNO":"F-2025-032","address":"7 Marina Street","gpsLongitude":"14.4982","gpsLatitude":"35.8898","location":"Marina Residence","inUsedYear":"2025","elevatorModel":"HX-800","elevatorType":"Passenger","floorStationDoor":"8 / 8 / 1","ratedLoadKg":"800","ratedSpeedMs":"1.5","manufacturerName":"LiftWorks","useType":"Domestic","iotCode":"IOT-1003","remoteCall":"","elevatorStatus":"Online","lastUpdatePerson":"Manager One","lastUpdateTime":"2026-08-17T15:12","servicesPerYear":"6"}
        ],
        "orders": [
            {"id":"ord_1","elevatorId":"elv_003","quotationNumber":"Q-25032","contractNumber":"C-25041","orderDate":"2025-01-12","productionScheduleTime":"2025-02-05","status":"Completed","notes":"Released to installation."}
        ],
        "installations": [
            {"id":"ins_1","elevatorId":"elv_003","scheduleInstallTime":"2025-05-01","installationEndDate":"2025-06-10","commissioningDate":"2025-06-18","handoverDate":"2025-06-25","status":"Completed","notes":"Customer handover complete."}
        ],
        "maintenance": [
            {"id":"mnt_1","elevatorId":"elv_001","serviceDate":"2026-07-15","serviceType":"Preventive inspection","technician":"Technician One","result":"Completed","nextServiceDate":"2026-09-15","notes":"Door operator adjusted and safety chain tested."}
        ],
    }


def init_db() -> None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                status TEXT NOT NULL,
                remote_call_access INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                approved_by TEXT,
                approved_at TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_state (
                dataset TEXT PRIMARY KEY,
                data_json TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                csrf_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
            CREATE TABLE IF NOT EXISTS activity_log (
                id TEXT PRIMARY KEY,
                time TEXT NOT NULL,
                user_id TEXT,
                user_name TEXT NOT NULL,
                role TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT,
                detail TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(time DESC);
            """
        )

        count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        if count == 0:
            users = [
                ("usr_admin","Site Administrator","admin@liftops.local","admin123","Administrator","Approved",0,"2026-01-01T09:00:00Z"),
                ("usr_manager","Manager One","manager@liftops.local","manager123","Manager","Approved",0,"2026-01-05T09:00:00Z"),
                ("usr_tech","Technician One","tech@liftops.local","tech123","Technician","Approved",0,"2026-01-10T09:00:00Z"),
                ("usr_pending","Technician Pending","pending.tech@liftops.local","tech123","Technician","Pending",0,"2026-08-16T10:30:00Z"),
            ]
            for user_id, name, email, password, role, status, remote, created in users:
                conn.execute(
                    "INSERT INTO users(id,name,email,password_hash,role,status,remote_call_access,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (user_id,name,email,hash_password(password),role,status,remote,created,now_iso()),
                )
            conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('users_version','1')")

        for dataset, data in seed_data().items():
            if conn.execute("SELECT 1 FROM app_state WHERE dataset=?", (dataset,)).fetchone() is None:
                conn.execute(
                    "INSERT INTO app_state(dataset,data_json,version,updated_at) VALUES(?,?,1,?)",
                    (dataset, json_dumps(data), now_iso()),
                )

        # v10 migration: automatically generated work is never assigned to a technician.
        row = conn.execute("SELECT data_json,version FROM app_state WHERE dataset='maintenance'").fetchone()
        if row:
            records = json.loads(row["data_json"])
            migrated = []
            changed = False
            for rec in records:
                if rec.get("sourceJobId") and rec.get("result") != "Completed":
                    # Previously accepted/assigned generated work returns to the generated queue.
                    changed = True
                    continue
                cleaned = dict(rec)
                for key in ("assignedUserId","assignedUserName","assignedAt","generatedJobDueDate"):
                    if key in cleaned:
                        cleaned.pop(key, None)
                        changed = True
                migrated.append(cleaned)
            if changed:
                conn.execute(
                    "UPDATE app_state SET data_json=?,version=version+1,updated_at=? WHERE dataset='maintenance'",
                    (json_dumps(migrated), now_iso()),
                )

        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_epoch(),))
        conn.commit()


def public_user(row: sqlite3.Row | dict) -> dict:
    get = row.__getitem__ if isinstance(row, sqlite3.Row) else row.get
    return {
        "id": get("id"),
        "name": get("name"),
        "email": get("email"),
        "role": get("role"),
        "status": get("status"),
        "remoteCallAccess": bool(get("remote_call_access")),
        "createdAt": get("created_at"),
        "approvedBy": get("approved_by"),
        "approvedAt": get("approved_at"),
    }


def get_state_row(conn: sqlite3.Connection, dataset: str):
    return conn.execute("SELECT data_json,version,updated_at FROM app_state WHERE dataset=?", (dataset,)).fetchone()


def get_meta_int(conn: sqlite3.Connection, key: str, default=1) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return int(row["value"]) if row else default


def bump_meta(conn: sqlite3.Connection, key: str) -> int:
    current = get_meta_int(conn, key, 0) + 1
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(current)))
    return current


def record_activity(conn: sqlite3.Connection, user: dict | None, action: str, target="", detail="") -> None:
    conn.execute(
        "INSERT INTO activity_log(id,time,user_id,user_name,role,action,target,detail) VALUES(?,?,?,?,?,?,?,?)",
        (uid("log"), now_iso(), user.get("id") if user else None, user.get("name") if user else "System", user.get("role") if user else "System", str(action)[:180], str(target or "")[:250], str(detail or "")[:1000]),
    )
    conn.execute("DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY time DESC LIMIT 5000)")


def sanitize_state_for_user(dataset: str, data: list, user: dict) -> list:
    if dataset in {"orders", "installations"} and user["role"] == "Technician":
        return []
    if dataset == "elevators" and user["role"] == "Technician" and not user.get("remoteCallAccess"):
        return [{k: v for k, v in item.items() if k != "remoteCall"} for item in data]
    return data


class LiftOpsHandler(SimpleHTTPRequestHandler):
    server_version = "LiftOps/10"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api_get(parsed.path)
        if parsed.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        return self.handle_api_post(path)

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        return self.handle_api_put(path)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        return self.handle_api_delete(path)

    def json_body(self, max_bytes=2_000_000):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > max_bytes:
            raise ValueError("Invalid request size")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def send_json(self, status: int, payload: dict, extra_headers: dict | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def cookie_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = cookies.SimpleCookie()
        try:
            jar.load(raw)
        except cookies.CookieError:
            return None
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def token_hash(self, token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def auth(self, touch=False) -> tuple[dict | None, dict | None]:
        token = self.cookie_token()
        if not token:
            return None, None
        with connect() as conn:
            row = conn.execute(
                """SELECT s.token_hash,s.csrf_token,s.expires_at,s.last_seen,u.*
                   FROM sessions s JOIN users u ON u.id=s.user_id
                   WHERE s.token_hash=?""",
                (self.token_hash(token),),
            ).fetchone()
            if not row or row["expires_at"] <= now_epoch() or row["status"] != "Approved":
                if row:
                    conn.execute("DELETE FROM sessions WHERE token_hash=?", (row["token_hash"],))
                return None, None
            expires = row["expires_at"]
            if touch:
                expires = now_epoch() + SESSION_SECONDS
                conn.execute("UPDATE sessions SET expires_at=?,last_seen=? WHERE token_hash=?", (expires, now_epoch(), row["token_hash"]))
            user = public_user(row)
            session = {"token_hash": row["token_hash"], "csrf": row["csrf_token"], "expiresAt": expires}
            return user, session

    def require_auth(self, mutation=False, touch=False):
        user, session = self.auth(touch=touch)
        if not user:
            self.send_json(401, {"error":"Authentication required"})
            return None, None
        if mutation:
            token = self.headers.get("X-CSRF-Token", "")
            if not token or not hmac.compare_digest(token, session["csrf"]):
                self.send_json(403, {"error":"Invalid CSRF token"})
                return None, None
        return user, session

    def secure_cookie(self) -> bool:
        if os.environ.get("LIFTOPS_SECURE_COOKIE") == "1":
            return True
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    def session_cookie_header(self, token: str, max_age=SESSION_SECONDS) -> str:
        parts = [f"{COOKIE_NAME}={token}", "Path=/", "HttpOnly", "SameSite=Strict", f"Max-Age={max_age}"]
        if self.secure_cookie():
            parts.append("Secure")
        return "; ".join(parts)

    def handle_api_get(self, path: str):
        if path == "/api/session":
            user, session = self.auth(touch=False)
            if not user:
                return self.send_json(200, {"authenticated":False})
            return self.send_json(200, {"authenticated":True,"user":user,"csrfToken":session["csrf"],"expiresAt":session["expiresAt"]*1000})

        if path == "/api/state":
            user, session = self.require_auth()
            if not user:
                return
            with connect() as conn:
                datasets = {}
                versions = {}
                for dataset in STATE_DATASETS:
                    row = get_state_row(conn, dataset)
                    data = json.loads(row["data_json"]) if row else []
                    datasets[dataset] = sanitize_state_for_user(dataset, data, user)
                    versions[dataset] = int(row["version"]) if row else 0

                if user["role"] in {"Administrator", "Manager"}:
                    user_rows = conn.execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
                else:
                    user_rows = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchall()
                datasets["users"] = [public_user(r) for r in user_rows]
                versions["users"] = get_meta_int(conn, "users_version", 1)

                if user["role"] != "Technician":
                    logs = conn.execute("SELECT id,time,user_name AS user,role,action,target,detail FROM activity_log ORDER BY time DESC LIMIT 1000").fetchall()
                    datasets["activity"] = [dict(r) for r in logs]
                else:
                    datasets["activity"] = []
                versions["activity"] = 0
            return self.send_json(200, {"datasets":datasets,"versions":versions,"serverTime":now_iso()})

        return self.send_json(404, {"error":"API endpoint not found"})

    def handle_api_post(self, path: str):
        if path == "/api/login":
            try:
                body = self.json_body(50_000)
            except Exception:
                return self.send_json(400, {"error":"Invalid JSON request"})
            email = str(body.get("email", "")).strip().lower()
            password = str(body.get("password", ""))
            with connect() as conn:
                row = conn.execute("SELECT * FROM users WHERE lower(email)=?", (email,)).fetchone()
                if not row or not verify_password(password, row["password_hash"]):
                    return self.send_json(401, {"error":"Invalid email or password."})
                if row["status"] != "Approved":
                    return self.send_json(403, {"error":f"Account is {row['status'].lower()} and cannot sign in yet."})
                token = secrets.token_urlsafe(32)
                csrf = secrets.token_urlsafe(24)
                expires = now_epoch() + SESSION_SECONDS
                conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_epoch(),))
                conn.execute(
                    "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen,created_at) VALUES(?,?,?,?,?,?)",
                    (self.token_hash(token), row["id"], csrf, expires, now_epoch(), now_epoch()),
                )
                user = public_user(row)
                record_activity(conn, user, "Signed in", "Session", row["email"])
            return self.send_json(200, {"user":user,"csrfToken":csrf,"expiresAt":expires*1000}, {"Set-Cookie":self.session_cookie_header(token)})

        if path == "/api/logout":
            user, session = self.require_auth(mutation=True)
            if not user:
                return
            with connect() as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (session["token_hash"],))
                record_activity(conn, user, "Signed out", "Session", user["email"])
            return self.send_json(200, {"ok":True}, {"Set-Cookie":self.session_cookie_header("deleted", 0)})

        if path == "/api/session/touch":
            user, session = self.require_auth(mutation=True, touch=True)
            if not user:
                return
            token = self.cookie_token()
            headers = {"Set-Cookie": self.session_cookie_header(token)} if token else None
            return self.send_json(200, {"expiresAt":session["expiresAt"]*1000}, headers)

        if path == "/api/activity":
            user, session = self.require_auth(mutation=True)
            if not user:
                return
            try:
                body = self.json_body(100_000)
            except Exception:
                return self.send_json(400, {"error":"Invalid JSON request"})
            with connect() as conn:
                record_activity(conn, user, body.get("action","Activity"), body.get("target",""), body.get("detail",""))
            return self.send_json(201, {"ok":True})

        return self.send_json(404, {"error":"API endpoint not found"})

    def handle_api_put(self, path: str):
        if not path.startswith("/api/state/"):
            return self.send_json(404, {"error":"API endpoint not found"})
        dataset = path.removeprefix("/api/state/")
        user, session = self.require_auth(mutation=True)
        if not user:
            return
        try:
            body = self.json_body(4_000_000)
        except Exception:
            return self.send_json(400, {"error":"Invalid JSON request"})
        data = body.get("data")
        expected = body.get("expectedVersion")
        if not isinstance(data, list) or not isinstance(expected, int):
            return self.send_json(400, {"error":"data must be an array and expectedVersion must be an integer"})

        if dataset == "users":
            return self.sync_users(user, data, expected)
        if dataset not in STATE_DATASETS:
            return self.send_json(404, {"error":"Unknown dataset"})
        if user["role"] == "Technician" and dataset != "maintenance":
            return self.send_json(403, {"error":"Technicians can edit only Maintenance & Service."})

        # Hard server-side safety: automatic generated jobs are not assignable.
        if dataset == "maintenance":
            cleaned = []
            for item in data:
                if not isinstance(item, dict):
                    return self.send_json(400, {"error":"Every maintenance record must be an object"})
                record = dict(item)
                for key in ("assignedUserId","assignedUserName","assignedAt","generatedJobDueDate"):
                    record.pop(key, None)
                # Do not allow a pending automatically generated/assigned record to be stored.
                if record.get("sourceJobId") and record.get("result") != "Completed":
                    continue
                cleaned.append(record)
            data = cleaned

        with connect() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                row = get_state_row(conn, dataset)
                current_version = int(row["version"]) if row else 0
                if current_version != expected:
                    conn.rollback()
                    current = json.loads(row["data_json"]) if row else []
                    current = sanitize_state_for_user(dataset, current, user)
                    return self.send_json(409, {"error":"This data changed on another device. The latest server version was loaded.","data":current,"version":current_version})
                new_version = current_version + 1
                conn.execute(
                    "INSERT INTO app_state(dataset,data_json,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(dataset) DO UPDATE SET data_json=excluded.data_json,version=excluded.version,updated_at=excluded.updated_at",
                    (dataset, json_dumps(data), new_version, now_iso()),
                )
                record_activity(conn, user, "Updated shared data", dataset, f"{len(data)} record(s) · version {new_version}")
                conn.commit()
            except Exception as exc:
                conn.rollback()
                return self.send_json(500, {"error":f"Database update failed: {exc}"})
        return self.send_json(200, {"data":sanitize_state_for_user(dataset,data,user),"version":new_version})

    def sync_users(self, actor: dict, incoming: list, expected: int):
        if actor["role"] == "Technician":
            return self.send_json(403, {"error":"Technicians cannot manage users."})
        with connect() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                current_version = get_meta_int(conn, "users_version", 1)
                if current_version != expected:
                    conn.rollback()
                    rows = conn.execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
                    return self.send_json(409, {"error":"User accounts changed on another device. The latest server version was loaded.","data":[public_user(r) for r in rows],"version":current_version})

                existing_rows = conn.execute("SELECT * FROM users").fetchall()
                existing = {r["id"]: r for r in existing_rows}
                incoming_by_id = {}
                seen_emails = set()
                for raw in incoming:
                    if not isinstance(raw, dict):
                        raise ValueError("Every user must be an object")
                    user_id = str(raw.get("id") or uid("usr"))
                    name = str(raw.get("name", "")).strip()
                    email = str(raw.get("email", "")).strip().lower()
                    role = str(raw.get("role", ""))
                    status = str(raw.get("status", "Pending"))
                    password = str(raw.get("password", ""))
                    if not name or not email or "@" not in email:
                        raise ValueError("Every user needs a valid name and email")
                    if role not in ALLOWED_ROLES or status not in ALLOWED_STATUS:
                        raise ValueError("Invalid role or account status")
                    if email in seen_emails:
                        raise ValueError("Duplicate email in submitted user list")
                    seen_emails.add(email)
                    old = existing.get(user_id)
                    if actor["role"] == "Manager" and role != "Technician":
                        if not old or old["role"] != role or old["name"] != name or old["email"].lower() != email or old["status"] != status or bool(old["remote_call_access"]) != bool(raw.get("remoteCallAccess")) or password:
                            raise PermissionError("Managers can manage Technician accounts only")
                        continue
                    if old and actor["role"] == "Manager" and old["role"] != "Technician":
                        raise PermissionError("Managers cannot modify non-Technician accounts")
                    if not old and not password:
                        raise ValueError(f"A password is required for new account {email}")
                    incoming_by_id[user_id] = (raw, name, email, role, status, password, old)

                # Managers synchronize only technicians; administrators synchronize all users.
                managed_existing_ids = {r["id"] for r in existing_rows if actor["role"] == "Administrator" or r["role"] == "Technician"}
                delete_ids = managed_existing_ids - set(incoming_by_id)
                if actor["id"] in delete_ids:
                    raise PermissionError("You cannot delete your own account")

                for delete_id in delete_ids:
                    conn.execute("DELETE FROM users WHERE id=?", (delete_id,))

                for user_id, (raw, name, email, role, status, password, old) in incoming_by_id.items():
                    if old:
                        pwd_hash = hash_password(password) if password else old["password_hash"]
                        created = old["created_at"]
                    else:
                        pwd_hash = hash_password(password)
                        created = str(raw.get("createdAt") or now_iso())
                    remote = 1 if role == "Technician" and bool(raw.get("remoteCallAccess")) else 0
                    approved_by = raw.get("approvedBy") or (actor["name"] if status == "Approved" and (not old or old["status"] != "Approved") else (old["approved_by"] if old else None))
                    approved_at = raw.get("approvedAt") or (now_iso() if status == "Approved" and (not old or old["status"] != "Approved") else (old["approved_at"] if old else None))
                    conn.execute(
                        """INSERT INTO users(id,name,email,password_hash,role,status,remote_call_access,created_at,approved_by,approved_at,updated_at)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?)
                           ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,password_hash=excluded.password_hash,role=excluded.role,status=excluded.status,remote_call_access=excluded.remote_call_access,approved_by=excluded.approved_by,approved_at=excluded.approved_at,updated_at=excluded.updated_at""",
                        (user_id,name,email,pwd_hash,role,status,remote,created,approved_by,approved_at,now_iso()),
                    )

                approved_admins = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='Administrator' AND status='Approved'").fetchone()["c"]
                if approved_admins < 1:
                    raise ValueError("At least one approved Administrator account is required")
                new_version = bump_meta(conn, "users_version")
                record_activity(conn, actor, "Updated user accounts", "User Management", f"version {new_version}")
                conn.commit()
            except PermissionError as exc:
                conn.rollback()
                return self.send_json(403, {"error":str(exc)})
            except sqlite3.IntegrityError:
                conn.rollback()
                return self.send_json(400, {"error":"Email address already exists."})
            except Exception as exc:
                conn.rollback()
                return self.send_json(400, {"error":str(exc)})

            rows = conn.execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
            return self.send_json(200, {"data":[public_user(r) for r in rows],"version":new_version})

    def handle_api_delete(self, path: str):
        if path != "/api/activity":
            return self.send_json(404, {"error":"API endpoint not found"})
        user, session = self.require_auth(mutation=True)
        if not user:
            return
        if user["role"] != "Administrator":
            return self.send_json(403, {"error":"Only Administrator can clear the activity log."})
        with connect() as conn:
            conn.execute("DELETE FROM activity_log")
            record_activity(conn, user, "Cleared activity log", "Activity", "")
        return self.send_json(200, {"ok":True})


def main():
    parser = argparse.ArgumentParser(description="LiftOps multi-user PWA server")
    parser.add_argument("--host", default=os.environ.get("LIFTOPS_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("LIFTOPS_PORT", "8080")))
    args = parser.parse_args()
    init_db()
    server = ThreadingHTTPServer((args.host, args.port), LiftOpsHandler)
    print(f"LiftOps server running on http://{args.host}:{args.port}")
    print(f"SQLite database: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping LiftOps server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

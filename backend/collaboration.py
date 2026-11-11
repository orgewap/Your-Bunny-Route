"""Local user accounts, project memberships and revision-safe OSM merging.

No external identity provider or third-party service is needed for LAN testing.
Secrets (session tokens, password hashes) never appear in API responses.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from xml.etree import ElementTree as ET

from .osm_merge import OsmError, parse_osm

COOKIE_NAME = "road_editor_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
USER_RE = re.compile(r"^[a-z0-9_.-]{3,48}$")
ENTITY_TYPES = ("node", "way", "relation")


def init_security(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
            salt TEXT NOT NULL, password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','editor')),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
        CREATE TABLE IF NOT EXISTS project_members (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
            PRIMARY KEY (project_id, user_id)
        );
    """)


def username(value: str) -> str:
    name = value.strip().lower()
    if not USER_RE.fullmatch(name):
        raise ValueError("Логин: 3–48 символов (a-z, цифры, точка, дефис, _).")
    return name


def password_digest(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 390_000).hex()


def create_user(conn: sqlite3.Connection, user_id: str, name: str, password: str, role: str, timestamp: str) -> dict:
    name = username(name)
    if len(password) < 12 or len(password) > 256:
        raise ValueError("Пароль должен содержать от 12 до 256 символов.")
    if role not in ("admin", "editor"):
        raise ValueError("Неизвестная роль.")
    salt = secrets.token_bytes(16)
    conn.execute("INSERT INTO users VALUES (?,?,?,?,?,?)",
                 (user_id, name, salt.hex(), password_digest(password, salt), role, timestamp))
    return {"id": user_id, "username": name, "role": role}


def verify_password(conn: sqlite3.Connection, name: str, password: str) -> sqlite3.Row | None:
    user = conn.execute("SELECT * FROM users WHERE username=?", (name.strip().lower(),)).fetchone()
    if user and hmac.compare_digest(password_digest(password, bytes.fromhex(user["salt"])), user["password_hash"]):
        return user
    # Make timing less dependent on account existence.
    if not user:
        password_digest(password, b"\x00" * 16)
    return None


def make_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute("INSERT INTO sessions VALUES (?,?,?)",
                 (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time() + SESSION_SECONDS))
    return token


def user_from_cookie(conn: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    hashed = hashlib.sha256(token.encode()).hexdigest()
    return conn.execute("""SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
                          WHERE sessions.token_hash=? AND sessions.expires_at>?""", (hashed, time.time())).fetchone()


def revoke_session(conn: sqlite3.Connection, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))


def entity_signature(element: ET.Element | None):
    """Stable entity signature ignoring indentation, not road/node order or tags."""
    if element is None:
        return None
    return (element.tag, tuple(sorted(element.attrib.items())),
            tuple(entity_signature(child) for child in element))


def index_entities(root: ET.Element) -> dict[tuple[str, str], ET.Element]:
    indexed = {}
    for element in root:
        if element.tag not in ENTITY_TYPES:
            continue
        key = (element.tag, element.attrib.get("id", ""))
        if not key[1] or key in indexed:
            raise OsmError("Найдены повторяющиеся или пустые OSM ID.")
        indexed[key] = element
    return indexed


def merge_disjoint_changes(baseline: str, changed: str, current: str) -> tuple[str, list[str]]:
    """Optimistic three-way merge. Any common node/way/relation edit conflicts.

    Baseline MUST be loaded by the server from immutable history, never trusted
    from the browser. This prevents clients from forging conflict-free ancestry.
    """
    import copy

    base_root, edit_root, current_root = map(parse_osm, (baseline, changed, current))
    base, edited, live = map(index_entities, (base_root, edit_root, current_root))
    touched = [key for key in set(base) | set(edited)
               if entity_signature(base.get(key)) != entity_signature(edited.get(key))]
    conflicts = [f"{kind}/{key}" for kind, key in touched
                 if entity_signature(live.get((kind, key))) not in
                 (entity_signature(base.get((kind, key))), entity_signature(edited.get((kind, key))))]
    if conflicts:
        return "", sorted(conflicts)[:20]

    # All disjoint edits apply to current, preserving its unknown tags, other
    # users' changes and XML root metadata.
    for kind, key in sorted(touched, key=lambda item: (ENTITY_TYPES.index(item[0]), item[1])):
        old = live.get((kind, key))
        new = edited.get((kind, key))
        if old is not None:
            offset = list(current_root).index(old)
            current_root.remove(old)
        else:
            # Keep OSM's conventional node → way → relation ordering.
            later = ENTITY_TYPES[ENTITY_TYPES.index(kind) + 1:]
            offset = next((i for i, obj in enumerate(current_root) if obj.tag in later), len(current_root))
        if new is not None:
            current_root.insert(offset, copy.deepcopy(new))

    # Do not let a deletion silently break a road/route added by a colleague.
    node_ids = {node.attrib["id"] for node in current_root.findall("node")}
    way_ids = {way.attrib["id"] for way in current_root.findall("way")}
    relation_ids = {rel.attrib["id"] for rel in current_root.findall("relation")}
    removed = [key for key in touched if key in base and key not in edited]
    removed_set = set(removed)
    for way in current_root.findall("way"):
        if any(("node", nd.attrib.get("ref", "")) in removed_set for nd in way.findall("nd")):
            return "", [f"way/{way.attrib['id']}: удалён общий узел"]
    for relation in current_root.findall("relation"):
        if any((member.attrib.get("type", ""), member.attrib.get("ref", "")) in removed_set
               for member in relation.findall("member")):
            return "", [f"relation/{relation.attrib['id']}: удалён связанный объект"]
    for way in current_root.findall("way"):
        if any(nd.attrib.get("ref") not in node_ids for nd in way.findall("nd")):
            # Do not introduce new dangling geometry. Older imported extracts
            # may already have missing nodes; reject only if this way was edited.
            if ("way", way.attrib["id"]) in touched:
                return "", [f"way/{way.attrib['id']}: отсутствует OSM-узел"]
    return ET.tostring(current_root, encoding="unicode"), []

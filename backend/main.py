"""Local FastAPI persistence for OSM projects and multiple source files."""
from __future__ import annotations

import json
import gzip
import os
import shutil
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Depends, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
from typing import Literal

from .osm_merge import EMPTY_OSM, OsmError, OsmOverlapReviewRequired, merge_xml, parse_osm, remove_source_xml
from .osm_overlap import analyze_overlap
from .webots_extras import export_bundle, WebotsExportError
from .collaboration import (
    COOKIE_NAME, SESSION_SECONDS, create_user, init_security, make_session,
    merge_disjoint_changes, revoke_session, user_from_cookie, verify_password,
)

_LOCK = threading.RLock()
DEFAULT_DATA = Path(os.environ.get('ROAD_EDITOR_DATA_DIR', str(Path(__file__).resolve().parent / 'data')))


class Login(BaseModel):
    username: str
    password: str


class CreateUser(BaseModel):
    username: str
    password: str


class AddMember(BaseModel):
    username: str
    role: Literal['editor', 'viewer'] = 'editor'


class CreateProject(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class UploadSource(BaseModel):
    filename: str = Field(min_length=1, max_length=240)
    xml: str
    policy: Literal['keep_existing', 'keep_both', 'new_tags'] | None = None
    expected_revision: int | None = Field(default=None, ge=0)


class SaveWorkspace(BaseModel):
    xml: str
    expected_revision: int = Field(ge=0)


class ExportWebots(BaseModel):
    xml: str
    base_world: str | None = None


def _id(value: str) -> str:
    try:
        item = str(uuid.UUID(value))
    except ValueError:
        raise HTTPException(404, 'Проект или источник не найден.')
    return item


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        temp.write_text(content, encoding='utf-8')
        temp.replace(path)
    finally:
        if temp.exists():
            temp.unlink()


def create_app(data_dir: Path | None = None) -> FastAPI:
    directory = (data_dir or DEFAULT_DATA).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    db_path = directory / 'projects.sqlite3'

    @contextmanager
    def db() -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(db_path)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    with db() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                filename TEXT NOT NULL, sha256 TEXT NOT NULL, refs_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_source_project ON sources(project_id);
        ''')

    with db() as conn:
        init_security(conn)

    # Serve the compiled Vue application and the API from ONE origin when
    # published via a tunnel. Never send a Vite development server to the web.
    serve_frontend = os.environ.get('ROAD_EDITOR_SERVE_FRONTEND') == '1'
    public_host = os.environ.get('ROAD_EDITOR_PUBLIC_HOST', '').strip().lower()
    if serve_frontend:
        import re
        if not re.fullmatch(r'(?=.{4,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+', public_host):
            raise RuntimeError('Для защищённого запуска задайте ROAD_EDITOR_PUBLIC_HOST (например, edit.example.com).')
        if os.environ.get('ROAD_EDITOR_SECURE_COOKIES') != '1':
            raise RuntimeError('Для внешнего HTTPS-доступа требуется ROAD_EDITOR_SECURE_COOKIES=1.')

    app = FastAPI(title='Road Editor Projects API', version='0.2.0',
                  docs_url=None if serve_frontend else '/docs',
                  redoc_url=None if serve_frontend else '/redoc',
                  openapi_url=None if serve_frontend else '/openapi.json')
    if serve_frontend:
        # Also validates Host on WebSocket upgrades. No wildcard hosts, no
        # public port on localhost:8000, and no access through Vite's dev port.
        app.add_middleware(TrustedHostMiddleware,
                           allowed_hosts=[public_host, 'localhost', '127.0.0.1'])

    # Deliberately one Uvicorn worker: WebSocket presence and file operations
    # share an in-process lock. Do not expose this service without auth/TLS.
    rooms: dict[str, dict[WebSocket, tuple[str, str]]] = {}
    async def publish(pid: str, message: dict) -> None:
        for ws, (user_id, token) in list(rooms.get(pid, {}).items()):
            try:
                if message.get('type') == 'project_deleted':
                    await ws.send_json(message)
                    rooms.get(pid, {}).pop(ws, None)
                    await ws.close(code=1000)
                    continue
                with db() as conn:
                    session_user = user_from_cookie(conn, token)
                    member = conn.execute('SELECT users.role AS global_role, project_members.role AS membership FROM users LEFT JOIN project_members ON users.id=project_members.user_id AND project_members.project_id=? WHERE users.id=?', (pid, user_id)).fetchone() if session_user else None
                if not member or (member['global_role'] != 'admin' and not member['membership']):
                    rooms.get(pid, {}).pop(ws, None)
                    await ws.close(code=1008)
                    continue
                await ws.send_json(message)
            except Exception:
                rooms.get(pid, {}).pop(ws, None)

    @app.middleware('http')
    async def update_events(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path.split('/')
        # After a committed write, send only metadata, never complete source XML.
        if response.status_code in (200, 201, 204) and len(path) >= 4 and path[:3] == ['', 'api', 'projects']:
            pid = path[3]
            if request.method in ('PUT', 'POST', 'DELETE') and (len(path) == 4 or len(path) >= 5 and path[4] in ('workspace', 'sources', 'members')):
                try:
                    with db() as conn:
                        row = conn.execute('SELECT revision FROM projects WHERE id=?', (pid,)).fetchone()
                    if row:
                        await publish(pid, {'type': 'members_updated' if len(path) > 4 and path[4] == 'members' else 'workspace_updated',
                                            'revision': row['revision'], 'actor': getattr(request.state, 'user_id', None)})
                    else:
                        await publish(pid, {'type': 'project_deleted'})
                except Exception:
                    # A WebSocket failure must never fail a successfully committed save.
                    pass
        return response

    def current_user(request: Request) -> sqlite3.Row:
        with db() as conn:
            user = user_from_cookie(conn, request.cookies.get(COOKIE_NAME))
        if not user:
            raise HTTPException(401, 'Войдите в учётную запись.')
        request.state.user_id = user['id']
        return user

    @app.post('/api/auth/login')
    def login(payload: Login, request: Request, response: Response) -> dict:
        # Small in-process throttle against password guessing; production uses
        # a reverse proxy rate limiter as well.
        key = (request.client.host if request.client else 'unknown', payload.username.strip().lower())
        now = __import__('time').monotonic()
        if len(failed_logins) > 1000:
            failed_logins.clear()
        attempts = failed_logins.get(key, [])
        attempts = [item for item in attempts if now - item < 60]
        if len(attempts) >= 5:
            raise HTTPException(429, 'Слишком много попыток входа. Повторите через минуту.')
        with db() as conn:
            user = verify_password(conn, payload.username, payload.password)
            if not user:
                failed_logins[key] = attempts + [now]
                raise HTTPException(401, 'Неверный логин или пароль.')
            token = make_session(conn, user['id'])
        failed_logins.pop(key, None)
        secure = request.url.scheme == 'https' or os.environ.get('ROAD_EDITOR_SECURE_COOKIES') == '1'
        response.set_cookie(COOKIE_NAME, token, httponly=True, secure=secure,
                            samesite='lax', max_age=SESSION_SECONDS, path='/api')
        return {'id': user['id'], 'username': user['username'], 'role': user['role']}

    @app.post('/api/webots/export')
    def export_webots(payload: ExportWebots, user: sqlite3.Row = Depends(current_user)) -> Response:
        """A downloadable addon bundle; never writes project files or the DB."""
        if payload.base_world is not None and len(payload.base_world) > 35_000_000:
            raise HTTPException(413, 'Слишком большой файл Webots .wbt.')
        try:
            result = export_bundle(payload.xml, payload.base_world)
        except WebotsExportError as exc:
            raise HTTPException(422, str(exc)) from exc
        return Response(content=result, media_type='application/zip',
                        headers={'Content-Disposition': 'attachment; filename="webots-infrastructure.zip"',
                                 'Cache-Control': 'no-store'})

    @app.get('/api/auth/me')
    def me(user: sqlite3.Row = Depends(current_user)) -> dict:
        return {'id': user['id'], 'username': user['username'], 'role': user['role']}

    @app.post('/api/auth/logout', status_code=204)
    def logout(request: Request, response: Response) -> None:
        with db() as conn:
            revoke_session(conn, request.cookies.get(COOKIE_NAME))
        response.delete_cookie(COOKIE_NAME, path='/api')

    @app.post('/api/auth/users', status_code=201)
    def new_user(payload: CreateUser, user: sqlite3.Row = Depends(current_user)) -> dict:
        if user['role'] != 'admin':
            raise HTTPException(403, 'Создавать пользователей может только администратор.')
        try:
            with db() as conn:
                return create_user(conn, str(uuid.uuid4()), payload.username, payload.password, 'editor', _now())
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        except sqlite3.IntegrityError:
            raise HTTPException(409, 'Такой логин уже существует.')

    @app.get('/api/auth/users')
    def list_users(user: sqlite3.Row = Depends(current_user)) -> list[dict]:
        if user['role'] != 'admin':
            raise HTTPException(403, 'Доступно только администратору.')
        with db() as conn:
            return [dict(row) for row in conn.execute('SELECT id,username,role,created_at FROM users ORDER BY username')]

    @app.websocket('/api/projects/{project_id}/live')
    async def live(ws: WebSocket, project_id: str):
        origin = ws.headers.get('origin', '')
        host = ws.headers.get('host', '')
        allowed = {f'http://localhost:5173', 'http://127.0.0.1:5173'}
        allowed.update(v.strip() for v in os.environ.get('ROAD_EDITOR_ALLOWED_ORIGINS', '').split(',') if v.strip())
        if host.split(':')[0].lower() not in ('localhost', '127.0.0.1', 'testserver'):
            allowed.difference_update({'http://localhost:5173', 'http://127.0.0.1:5173'})
        if not origin or (urlsplit(origin).netloc != host and origin not in allowed):
            await ws.close(code=1008)
            return
        with db() as conn:
            user = user_from_cookie(conn, ws.cookies.get(COOKIE_NAME))
            if not user:
                await ws.close(code=1008)
                return
            try:
                lookup(conn, project_id, user)
            except HTTPException:
                await ws.close(code=1008)
                return
        await ws.accept()
        room = rooms.setdefault(project_id, {})
        room[ws] = (user['id'], ws.cookies[COOKIE_NAME])
        try:
            await publish(project_id, {'type': 'presence', 'count': len(room)})
            while True:
                text = await ws.receive_text()
                if text == 'ping':
                    await ws.send_json({'type': 'pong'})
        except WebSocketDisconnect:
            pass
        finally:
            room.pop(ws, None)
            if not room:
                rooms.pop(project_id, None)
            await publish(project_id, {'type': 'presence', 'count': len(room)})

    failed_logins: dict[tuple[str, str], list[float]] = {}

    def snapshots(project_id: str) -> Path:
        return folder(project_id) / 'revisions'

    def save_snapshot(project_id: str, revision: int, xml: str) -> None:
        home = snapshots(project_id)
        home.mkdir(parents=True, exist_ok=True)
        path = home / f'{revision}.osm.gz'
        if not path.exists():
            temp = home / f'.{revision}.{uuid.uuid4().hex}.tmp'
            try:
                with gzip.open(temp, 'wt', encoding='utf-8', compresslevel=5) as f:
                    f.write(xml)
                temp.replace(path)
            finally:
                temp.unlink(missing_ok=True)
        # Bound disk usage; an expired base revision is safely rejected with 409.
        for old in sorted(home.glob('*.osm.gz'), key=lambda p: int(p.name.split('.')[0]))[:-24]:
            old.unlink(missing_ok=True)

    def historic(project_id: str, revision: int) -> str | None:
        path = snapshots(project_id) / f'{revision}.osm.gz'
        if not path.is_file():
            return None
        with gzip.open(path, 'rt', encoding='utf-8') as f:
            return f.read()


    def folder(project_id: str) -> Path:
        return directory / 'projects' / _id(project_id)

    def project_role(conn: sqlite3.Connection, project_id: str, user: sqlite3.Row) -> str | None:
        if user['role'] == 'admin':
            return 'owner'
        row = conn.execute('SELECT role FROM project_members WHERE project_id=? AND user_id=?',
                           (project_id, user['id'])).fetchone()
        return row['role'] if row else None

    def lookup(conn: sqlite3.Connection, project_id: str, user: sqlite3.Row,
               required: str = 'viewer') -> sqlite3.Row:
        item = conn.execute('SELECT * FROM projects WHERE id=?', (_id(project_id),)).fetchone()
        if not item:
            raise HTTPException(404, 'Проект не найден.')
        role = project_role(conn, item['id'], user)
        if role is None or (required == 'editor' and role == 'viewer') or (required == 'owner' and role != 'owner'):
            raise HTTPException(403, 'Нет доступа к проекту.')
        return item

    def metadata(conn: sqlite3.Connection, item: sqlite3.Row, user: sqlite3.Row) -> dict:
        sources = conn.execute('SELECT id, filename, created_at FROM sources WHERE project_id=? ORDER BY created_at, rowid',
                               (item['id'],)).fetchall()
        return dict(item) | {'sources': [dict(source) for source in sources], 'source_count': len(sources), 'role': project_role(conn, item['id'], user)}

    @app.get('/api/health')
    def health() -> dict:
        return {'ok': True}

    @app.get('/api/projects')
    def list_projects(user: sqlite3.Row = Depends(current_user)) -> list[dict]:
        with db() as conn:
            return [metadata(conn, item, user) for item in conn.execute('SELECT * FROM projects ORDER BY updated_at DESC')
                    if project_role(conn, item['id'], user)]

    @app.post('/api/projects', status_code=201)
    def create_project(payload: CreateProject, user: sqlite3.Row = Depends(current_user)) -> dict:
        name = payload.name.strip()
        if not name:
            raise HTTPException(422, 'Введите название проекта.')
        project_id = str(uuid.uuid4())
        timestamp = _now()
        with _LOCK, db() as conn:
            conn.execute('INSERT INTO projects VALUES (?,?,?,?,?)', (project_id, name, 0, timestamp, timestamp))
            conn.execute('INSERT INTO project_members VALUES (?,?,?)', (project_id, user['id'], 'owner'))
            _write_atomic(folder(project_id) / 'workspace.osm', EMPTY_OSM)
            save_snapshot(project_id, 0, EMPTY_OSM)
            return metadata(conn, lookup(conn, project_id, user), user)

    @app.get('/api/projects/{project_id}')
    def get_project(project_id: str, user: sqlite3.Row = Depends(current_user)) -> dict:
        with db() as conn:
            return metadata(conn, lookup(conn, project_id, user), user)

    @app.get('/api/projects/{project_id}/workspace')
    def read_workspace(project_id: str, user: sqlite3.Row = Depends(current_user)) -> dict:
        with db() as conn:
            item = lookup(conn, project_id, user)
            return {'xml': (folder(project_id) / 'workspace.osm').read_text(encoding='utf-8'),
                    'revision': item['revision']}

    @app.put('/api/projects/{project_id}/workspace')
    def save_workspace(project_id: str, payload: SaveWorkspace, user: sqlite3.Row = Depends(current_user)) -> dict:
        try:
            parse_osm(payload.xml)
        except OsmError as exc:
            raise HTTPException(422, str(exc))
        with _LOCK, db() as conn:
            item = lookup(conn, project_id, user, 'editor')
            previous = (folder(project_id) / 'workspace.osm').read_text(encoding='utf-8')
            merged = payload.expected_revision != item['revision']
            xml = payload.xml
            if merged:
                baseline = historic(project_id, payload.expected_revision)
                if baseline is None:
                    raise HTTPException(409, 'Версия проекта слишком старая. Сохраните свою копию OSM и откройте проект заново.')
                try:
                    xml, conflicts = merge_disjoint_changes(baseline, payload.xml, previous)
                except OsmError as exc:
                    raise HTTPException(422, str(exc))
                if conflicts:
                    raise HTTPException(409, 'Конфликт совместного редактирования: ' + ', '.join(conflicts))
            revision = item['revision'] + 1
            save_snapshot(project_id, item['revision'], previous)
            _write_atomic(folder(project_id) / 'workspace.osm', xml)
            save_snapshot(project_id, revision, xml)
            conn.execute('UPDATE projects SET revision=?, updated_at=? WHERE id=?', (revision, _now(), item['id']))
            return {'revision': revision, 'merged': merged}

    @app.get('/api/projects/{project_id}/overlaps')
    def audit_existing_sources(project_id: str, user: sqlite3.Row = Depends(current_user)) -> dict:
        # Read only. Existing edited workspace data must never be auto-replaced.
        with _LOCK, db() as conn:
            item = lookup(conn, project_id, user)
            sources = conn.execute(
                'SELECT id, filename FROM sources WHERE project_id=? ORDER BY created_at, rowid',
                (item['id'],),
            ).fetchall()
            if len(sources) > 20:
                raise HTTPException(422, 'Для проверки наложений допускается до 20 источников за раз.')
            documents = [parse_osm((folder(project_id) / f"{source['id']}.osm").read_text(encoding='utf-8'))
                         for source in sources]
            pairs = []
            # Identical positive OSM IDs are shared objects, not geometry
            # conflicts. Still display their overlap instead of reporting that
            # the two files have no common content at all.
            object_ids = [{kind: {e.get('id') for e in doc.findall(kind)
                                  if e.get('id', '').isdigit() and int(e.get('id', '0')) > 0}
                           for kind in ('node', 'way', 'relation')}
                          for doc in documents]
            for i, left in enumerate(sources):
                for j in range(i + 1, len(sources)):
                    report = analyze_overlap(documents[i], documents[j])
                    shared = {kind: len(object_ids[i][kind] & object_ids[j][kind])
                              for kind in ('node', 'way', 'relation')}
                    if not report['review_needed'] and not any(shared.values()):
                        continue
                    pairs.append({
                        'left': left['filename'], 'right': sources[j]['filename'],
                        'counts': report['counts'], 'examples': report['examples'],
                        'shared_ids': shared,
                    })
            return {'sources': len(sources), 'pairs': pairs, 'revision': item['revision']}

    @app.post('/api/projects/{project_id}/sources/preview')
    def preview_source(project_id: str, payload: UploadSource, user: sqlite3.Row = Depends(current_user)) -> dict:
        try:
            incoming = parse_osm(payload.xml)
        except OsmError as exc:
            raise HTTPException(422, str(exc))
        with _LOCK, db() as conn:
            item = lookup(conn, project_id, user)
            previous = parse_osm((folder(project_id) / 'workspace.osm').read_text(encoding='utf-8'))
            report = analyze_overlap(previous, incoming)
            # The complete geometry mapping remains server-side; the dialog
            # needs only counts and a small set of concrete examples.
            return {key: value for key, value in report.items() if key != 'duplicate_matches'} | {
                'revision': item['revision'],
            }

    @app.post('/api/projects/{project_id}/sources', status_code=201)
    def add_source(project_id: str, payload: UploadSource, user: sqlite3.Row = Depends(current_user)) -> dict:
        import hashlib
        name = Path(payload.filename.replace('\\', '/')).name.strip()
        if not name or not name.lower().endswith(('.osm', '.xml')):
            raise HTTPException(422, 'Выберите OSM XML-файл.')
        try:
            parse_osm(payload.xml)
        except OsmError as exc:
            raise HTTPException(422, str(exc))
        digest = hashlib.sha256(payload.xml.encode('utf-8')).hexdigest()
        with _LOCK, db() as conn:
            item = lookup(conn, project_id, user, 'editor')
            if payload.expected_revision is not None and item['revision'] != payload.expected_revision:
                raise HTTPException(409, 'Проект изменился после проверки наложений. Проверьте файл снова.')
            if conn.execute('SELECT 1 FROM sources WHERE project_id=? AND sha256=?', (project_id, digest)).fetchone():
                raise HTTPException(409, 'Этот OSM-файл уже добавлен.')
            prior = (folder(project_id) / 'workspace.osm').read_text(encoding='utf-8')
            try:
                merged, owned = merge_xml(prior, payload.xml, payload.policy)
            except OsmOverlapReviewRequired as exc:
                raise HTTPException(409, str(exc))
            except OsmError as exc:
                raise HTTPException(422, str(exc))
            sid = str(uuid.uuid4())
            _write_atomic(folder(project_id) / f'{sid}.osm', payload.xml)
            save_snapshot(project_id, item['revision'], prior)
            _write_atomic(folder(project_id) / 'workspace.osm', merged)
            save_snapshot(project_id, item['revision'] + 1, merged)
            conn.execute('INSERT INTO sources VALUES (?,?,?,?,?,?)',
                         (sid, item['id'], name, digest, json.dumps(owned), _now()))
            conn.execute('UPDATE projects SET revision=revision+1, updated_at=? WHERE id=?', (_now(), item['id']))
            return metadata(conn, lookup(conn, project_id, user, 'editor'), user)

    @app.delete('/api/projects/{project_id}/sources/{source_id}')
    def delete_source(project_id: str, source_id: str, user: sqlite3.Row = Depends(current_user)) -> dict:
        with _LOCK, db() as conn:
            item = lookup(conn, project_id, user, 'editor')
            sid = _id(source_id)
            source = conn.execute('SELECT * FROM sources WHERE id=? AND project_id=?', (sid, item['id'])).fetchone()
            if not source:
                raise HTTPException(404, 'Источник не найден.')
            other = conn.execute('SELECT * FROM sources WHERE project_id=? AND id!=?', (item['id'], sid)).fetchall()
            original = (folder(project_id) / 'workspace.osm').read_text(encoding='utf-8')
            removal_report: dict[str, int] = {}
            try:
                rewritten = remove_source_xml(original, json.loads(source['refs_json']),
                                              [json.loads(other_item['refs_json']) for other_item in other],
                                              report=removal_report)
            except OsmError as exc:
                raise HTTPException(409, str(exc))
            save_snapshot(project_id, item['revision'], original)
            _write_atomic(folder(project_id) / 'workspace.osm', rewritten)
            save_snapshot(project_id, item['revision'] + 1, rewritten)
            conn.execute('DELETE FROM sources WHERE id=?', (sid,))
            conn.execute('UPDATE projects SET revision=revision+1, updated_at=? WHERE id=?', (_now(), item['id']))
            (folder(project_id) / f'{sid}.osm').unlink(missing_ok=True)
            return metadata(conn, lookup(conn, project_id, user, 'editor'), user) | {
                'removal': removal_report,
            }

    @app.get('/api/projects/{project_id}/members')
    def list_members(project_id: str, user: sqlite3.Row = Depends(current_user)) -> list[dict]:
        with db() as conn:
            lookup(conn, project_id, user)
            return [dict(row) for row in conn.execute('''SELECT users.id, users.username, project_members.role
                 FROM project_members JOIN users ON project_members.user_id=users.id
                 WHERE project_members.project_id=? ORDER BY users.username''', (project_id,))]

    @app.post('/api/projects/{project_id}/members', status_code=201)
    def invite(project_id: str, payload: AddMember, user: sqlite3.Row = Depends(current_user)) -> dict:
        with _LOCK, db() as conn:
            lookup(conn, project_id, user, 'owner')
            target = conn.execute('SELECT id,username FROM users WHERE username=?',
                                  (payload.username.strip().lower(),)).fetchone()
            if not target:
                raise HTTPException(404, 'Такого пользователя нет. Администратор должен сначала создать учётную запись.')
            existing = conn.execute('SELECT role FROM project_members WHERE project_id=? AND user_id=?',
                                    (project_id, target['id'])).fetchone()
            if existing and existing['role'] == 'owner':
                raise HTTPException(409, 'Нельзя изменить роль владельца проекта.')
            conn.execute('''INSERT INTO project_members VALUES (?,?,?) ON CONFLICT(project_id,user_id)
                 DO UPDATE SET role=excluded.role''', (project_id, target['id'], payload.role))
            return {'id': target['id'], 'username': target['username'], 'role': payload.role}

    @app.delete('/api/projects/{project_id}/members/{member_id}', status_code=204)
    def remove_member(project_id: str, member_id: str,
                      user: sqlite3.Row = Depends(current_user)) -> None:
        with _LOCK, db() as conn:
            lookup(conn, project_id, user, 'owner')
            row = conn.execute('SELECT role FROM project_members WHERE project_id=? AND user_id=?',
                               (project_id, _id(member_id))).fetchone()
            if not row:
                raise HTTPException(404, 'Участник не найден.')
            if row['role'] == 'owner':
                raise HTTPException(409, 'Владелец не может удалить себя из проекта.')
            conn.execute('DELETE FROM project_members WHERE project_id=? AND user_id=?', (project_id, member_id))

    @app.delete('/api/projects/{project_id}', status_code=204)
    def delete_project(project_id: str, user: sqlite3.Row = Depends(current_user)) -> None:
        with _LOCK, db() as conn:
            lookup(conn, project_id, user, 'owner')
            conn.execute('DELETE FROM projects WHERE id=?', (_id(project_id),))
            shutil.rmtree(folder(project_id), ignore_errors=True)

    if serve_frontend:
        dist = Path(os.environ.get('ROAD_EDITOR_DIST_DIR',
                   str(Path(__file__).resolve().parent.parent / 'dist'))).resolve()
        if not (dist / 'index.html').is_file():
            raise RuntimeError('Нет сборки frontend: выполните npm run build (должен появиться dist/index.html).')
        # Registered last so that /api/* and /api/projects/*/live always take
        # precedence, including the WebSocket handshake.
        app.mount('/', StaticFiles(directory=str(dist), html=True), name='frontend')

    return app


app = create_app()

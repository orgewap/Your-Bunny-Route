"""Production hosting security checks without requiring Cloudflare credentials."""
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.collaboration import create_user
from backend.main import create_app

PASSWORD = 'TestTeamPassword!2026'


class RemoteHostingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.dist = self.root / 'dist'
        (self.dist / 'assets').mkdir(parents=True)
        (self.dist / 'index.html').write_text('<html><div id="app"></div></html>', encoding='utf-8')
        (self.dist / 'assets' / 'ui.js').write_text('console.log("ok")', encoding='utf-8')
        self.env = {'ROAD_EDITOR_SERVE_FRONTEND': '1',
                    'ROAD_EDITOR_SECURE_COOKIES': '1',
                    'ROAD_EDITOR_PUBLIC_HOST': 'edit.example.com',
                    'ROAD_EDITOR_DIST_DIR': str(self.dist)}

    def tearDown(self):
        self.temp.cleanup()

    @contextmanager
    def client(self):
        with patch.dict('os.environ', self.env):
            app = create_app(self.root / 'data')
        with TestClient(app, base_url='https://edit.example.com') as client:
            yield client

    def test_public_mode_requires_public_hostname_and_secure_cookies(self):
        for missing in ['ROAD_EDITOR_PUBLIC_HOST', 'ROAD_EDITOR_SECURE_COOKIES']:
            env = self.env.copy(); env.pop(missing)
            with patch.dict('os.environ', env, clear=True):
                with self.assertRaises(RuntimeError):
                    create_app(self.root / f'missing-{missing}')

    def test_public_mode_requires_compiled_frontend(self):
        env = self.env | {'ROAD_EDITOR_DIST_DIR': str(self.root / 'not-built')}
        with patch.dict('os.environ', env):
            with self.assertRaisesRegex(RuntimeError, 'npm run build'):
                create_app(self.root / 'data')

    def test_single_origin_serves_vue_api_and_not_secret_files(self):
        with self.client() as client:
            home = client.get('/')
            self.assertEqual(home.status_code, 200)
            self.assertIn('id="app"', home.text)
            self.assertEqual(client.get('/assets/ui.js').status_code, 200)
            self.assertEqual(client.get('/api/health').json(), {'ok': True})
            self.assertEqual(client.get('/api/projects').status_code, 401)
            self.assertEqual(client.get('/api/this-does-not-exist').status_code, 404)
            self.assertEqual(client.get('/backend/data/projects.sqlite3').status_code, 404)
            self.assertEqual(client.get('/docs').status_code, 404)

    def test_public_host_check_blocks_unknown_host(self):
        with self.client() as client:
            response = client.get('/api/health', headers={'host': 'unauthorized.example.net'})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(client.get('/api/health').status_code, 200)

    def test_https_login_sets_secure_cookie_and_remote_websocket_works(self):
        with self.client() as client:
            with sqlite3.connect(self.root / 'data' / 'projects.sqlite3') as db:
                create_user(db, str(uuid.uuid4()), 'teamlead', PASSWORD, 'admin', datetime.now(timezone.utc).isoformat())
            logged_in = client.post('/api/auth/login', json={'username': 'teamlead', 'password': PASSWORD})
            self.assertEqual(logged_in.status_code, 200)
            cookie = logged_in.headers['set-cookie'].lower()
            self.assertIn('secure', cookie)
            self.assertIn('httponly', cookie)
            self.assertEqual(client.get('/api/auth/me').json()['username'], 'teamlead')
            pid = client.post('/api/projects', json={'name': 'Cloudflare test'}).json()['id']
            with client.websocket_connect(f'wss://edit.example.com/api/projects/{pid}/live',
                                          headers={'origin': 'https://edit.example.com'}) as ws:
                received = ws.receive_json()
                self.assertEqual(received['type'], 'presence')
                self.assertEqual(received['count'], 1)
                ws.send_text('ping')
                self.assertEqual(ws.receive_json()['type'], 'pong')
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect(f'wss://edit.example.com/api/projects/{pid}/live',
                                              headers={'origin': 'https://attack.example.org'}):
                    pass

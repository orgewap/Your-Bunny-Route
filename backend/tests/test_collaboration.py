import sqlite3
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from fastapi.testclient import TestClient

from backend.collaboration import create_user, merge_disjoint_changes
from backend.main import create_app

PASSWORD = 'TransportTeamPassword!2026'
BASE = '''<osm version="0.6"><node id="1" lat="52.0" lon="104.0"/>
 <node id="2" lat="52.1" lon="104.1"/><node id="3" lat="52.2" lon="104.2"/>
 <node id="4" lat="52.3" lon="104.3"/>
 <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="first"/></way>
 <way id="200"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/><tag k="name" v="second"/></way></osm>'''


def update_tag(xml, wid, value):
    root = ET.fromstring(xml)
    way = root.find(f"way[@id='{wid}']")
    name = way.find("tag[@k='name']")
    name.set('v', value)
    return ET.tostring(root, encoding='unicode')


class CollaborationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.app = create_app(self.data)
        self.a = TestClient(self.app)
        self.b = TestClient(self.app)
        self.viewer = TestClient(self.app)
        db = sqlite3.connect(self.data / 'projects.sqlite3')
        try:
            for name, role in [('admin', 'admin'), ('planner', 'editor'), ('viewer', 'editor'), ('stranger', 'editor')]:
                create_user(db, str(uuid.uuid4()), name, PASSWORD, role, datetime.now(timezone.utc).isoformat())
            db.commit()
        finally:
            db.close()
        for client, name in [(self.a, 'admin'), (self.b, 'planner'), (self.viewer, 'viewer')]:
            response = client.post('/api/auth/login', json={'username': name, 'password': PASSWORD})
            self.assertEqual(response.status_code, 200, response.text)
        self.pid = self.a.post('/api/projects', json={'name': 'Shared'}).json()['id']
        self.assertEqual(self.a.post(f'/api/projects/{self.pid}/members', json={'username': 'planner', 'role': 'editor'}).status_code, 201)
        self.assertEqual(self.a.post(f'/api/projects/{self.pid}/members', json={'username': 'viewer', 'role': 'viewer'}).status_code, 201)
        self.assertEqual(self.a.post(f'/api/projects/{self.pid}/sources', json={'filename': 'demo.osm', 'xml': BASE}).status_code, 201)

    def tearDown(self):
        self.a.close(); self.b.close(); self.viewer.close(); self.tmp.cleanup()

    def test_authentication_is_required_for_projects_and_workspace(self):
        anon = TestClient(self.app)
        self.assertEqual(anon.get('/api/projects').status_code, 401)
        self.assertEqual(anon.get(f'/api/projects/{self.pid}/workspace').status_code, 401)
        self.assertEqual(anon.put(f'/api/projects/{self.pid}/workspace', json={'xml': BASE, 'expected_revision': 1}).status_code, 401)
        self.assertEqual(anon.post('/api/auth/login', json={'username': 'admin', 'password': 'bad'}).status_code, 401)
        anon.close()

    def test_session_logout_revokes_cookie_and_later_calls(self):
        self.assertEqual(self.b.get('/api/auth/me').status_code, 200)
        self.assertEqual(self.b.post('/api/auth/logout').status_code, 204)
        self.assertEqual(self.b.get('/api/projects').status_code, 401)

    def test_project_access_is_restricted_to_members(self):
        outsider = TestClient(self.app)
        self.assertEqual(outsider.post('/api/auth/login', json={'username': 'stranger', 'password': PASSWORD}).status_code, 200)
        self.assertEqual(outsider.get('/api/projects').json(), [])
        self.assertEqual(outsider.get(f'/api/projects/{self.pid}/workspace').status_code, 403)
        self.assertEqual(outsider.get(f'/api/projects/{self.pid}/overlaps').status_code, 403)
        self.assertEqual(outsider.get(f'/api/projects/{self.pid}/members').status_code, 403)
        outsider.close()

    def test_role_enforcement(self):
        current = self.a.get(f'/api/projects/{self.pid}/workspace').json()
        self.assertEqual(self.viewer.get(f'/api/projects/{self.pid}/workspace').status_code, 200)
        self.assertEqual(self.viewer.put(f'/api/projects/{self.pid}/workspace', json={'xml': BASE, 'expected_revision': current['revision']}).status_code, 403)
        self.assertEqual(self.viewer.delete(f'/api/projects/{self.pid}').status_code, 403)
        self.assertEqual(self.b.delete(f'/api/projects/{self.pid}').status_code, 403)
        self.assertEqual(self.b.post(f'/api/projects/{self.pid}/members', json={'username': 'stranger'}).status_code, 403)
        self.assertEqual(self.b.post('/api/auth/users', json={'username': 'other', 'password': PASSWORD}).status_code, 403)

    def test_team_creation_requires_admin_and_owner_assignment(self):
        response = self.a.post('/api/auth/users', json={'username': 'planner5', 'password': PASSWORD})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.b.post(f'/api/projects/{self.pid}/members', json={'username': 'planner5'}).status_code, 403)
        self.assertEqual(self.a.post(f'/api/projects/{self.pid}/members', json={'username': 'planner5'}).status_code, 201)
        members = self.a.get(f'/api/projects/{self.pid}/members').json()
        self.assertTrue(any(x['username'] == 'planner5' for x in members))
        self.assertNotIn('password_hash', str(members))
        self.assertEqual(self.a.delete(f'/api/projects/{self.pid}/members/{response.json()["id"]}').status_code, 204)

    def test_two_clients_edit_different_roads_and_merge_without_loss(self):
        base = self.a.get(f'/api/projects/{self.pid}/workspace').json()
        rev = base['revision']
        a = update_tag(base['xml'], 100, 'Mira')
        b = update_tag(base['xml'], 200, 'Trofim')
        result_a = self.a.put(f'/api/projects/{self.pid}/workspace', json={'xml': a, 'expected_revision': rev})
        self.assertEqual(result_a.status_code, 200)
        result_b = self.b.put(f'/api/projects/{self.pid}/workspace', json={'xml': b, 'expected_revision': rev})
        self.assertEqual(result_b.status_code, 200, result_b.text)
        self.assertTrue(result_b.json()['merged'])
        latest = self.a.get(f'/api/projects/{self.pid}/workspace').json()['xml']
        self.assertIn('v="Mira"', latest)
        self.assertIn('v="Trofim"', latest)
        self.assertEqual(len(ET.fromstring(latest).findall('way')), 2)

    def test_five_transport_planners_save_five_independent_roads(self):
        initial = self.a.get(f'/api/projects/{self.pid}/workspace').json()
        root = ET.fromstring(initial['xml'])
        for i in range(300, 303):
            way = ET.Element('way', {'id': str(i)})
            ET.SubElement(way, 'nd', {'ref': '1'})
            ET.SubElement(way, 'nd', {'ref': '3'})
            ET.SubElement(way, 'tag', {'k': 'highway', 'v': 'residential'})
            ET.SubElement(way, 'tag', {'k': 'name', 'v': str(i)})
            root.append(way)
        inserted = ET.tostring(root, encoding='unicode')
        self.assertEqual(self.a.put(f'/api/projects/{self.pid}/workspace', json={
            'xml': inserted, 'expected_revision': initial['revision'],
        }).status_code, 200)
        baseline = self.a.get(f'/api/projects/{self.pid}/workspace').json()
        clients = [self.a, self.b]
        for index in range(3):
            name = f'engineer{index+3}'
            created = self.a.post('/api/auth/users', json={'username': name, 'password': PASSWORD})
            self.assertEqual(created.status_code, 201)
            invited = self.a.post(f'/api/projects/{self.pid}/members', json={'username': name})
            self.assertEqual(invited.status_code, 201)
            cli = TestClient(self.app)
            self.assertEqual(cli.post('/api/auth/login', json={'username': name, 'password': PASSWORD}).status_code, 200)
            clients.append(cli)
        try:
            for client, road_id in zip(clients, [100, 200, 300, 301, 302]):
                changed = update_tag(baseline['xml'], road_id, f'Planner-{road_id}') if road_id in (100,200) else baseline['xml'].replace(
                    f'k="name" v="{road_id}"', f'k="name" v="Planner-{road_id}"')
                response = client.put(f'/api/projects/{self.pid}/workspace', json={
                    'xml': changed, 'expected_revision': baseline['revision']})
                self.assertEqual(response.status_code, 200, response.text)
            latest = self.a.get(f'/api/projects/{self.pid}/workspace').json()['xml']
            for road_id in [100,200,300,301,302]:
                self.assertIn(f'v="Planner-{road_id}"', latest)
        finally:
            for cli in clients[2:]: cli.close()

    def test_two_clients_edit_same_road_returns_409_and_does_not_overwrite(self):
        base = self.a.get(f'/api/projects/{self.pid}/workspace').json()
        rev = base['revision']
        first = self.a.put(f'/api/projects/{self.pid}/workspace', json={
            'xml': update_tag(base['xml'], 100, 'A'), 'expected_revision': rev})
        self.assertEqual(first.status_code, 200)
        second = self.b.put(f'/api/projects/{self.pid}/workspace', json={
            'xml': update_tag(base['xml'], 100, 'B'), 'expected_revision': rev})
        self.assertEqual(second.status_code, 409)
        self.assertIn('way/100', second.json()['detail'])
        latest = self.a.get(f'/api/projects/{self.pid}/workspace').json()['xml']
        self.assertIn('v="A"', latest)
        self.assertNotIn('v="B"', latest)

    def test_stale_unknown_revision_is_rejected_without_overwrite(self):
        current = self.a.get(f'/api/projects/{self.pid}/workspace').json()
        response = self.b.put(f'/api/projects/{self.pid}/workspace', json={
            'xml': update_tag(current['xml'], 200, 'Missing'), 'expected_revision': 0})
        # Revision 0 does exist in the immutable history; it is empty, so both
        # ways are additions with already used IDs and must conflict safely.
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.b.put(f'/api/projects/{self.pid}/workspace', json={
            'xml': update_tag(current['xml'], 200, 'Missing'), 'expected_revision': 500}).status_code, 409)

    def test_websocket_reports_presence_and_committed_updates(self):
        with self.a.websocket_connect(f'/api/projects/{self.pid}/live', headers={'origin': 'http://testserver'}) as w1:
            self.assertEqual(w1.receive_json(), {'type': 'presence', 'count': 1})
            with self.b.websocket_connect(f'/api/projects/{self.pid}/live', headers={'origin': 'http://testserver'}) as w2:
                self.assertEqual(w1.receive_json(), {'type': 'presence', 'count': 2})
                self.assertEqual(w2.receive_json(), {'type': 'presence', 'count': 2})
                data = self.a.get(f'/api/projects/{self.pid}/workspace').json()
                response = self.b.put(f'/api/projects/{self.pid}/workspace', json={
                    'xml': update_tag(data['xml'], 200, 'Updated'), 'expected_revision': data['revision']})
                self.assertEqual(response.status_code, 200)
                event = w1.receive_json()
                self.assertEqual(event['type'], 'workspace_updated')
                self.assertGreater(event['revision'], data['revision'])
                self.assertIsNotNone(event['actor'])
            self.assertEqual(w1.receive_json(), {'type': 'presence', 'count': 1})

    def test_cross_site_or_unauthenticated_websocket_denied(self):
        anon = TestClient(self.app)
        with self.assertRaises(Exception):
            with anon.websocket_connect(f'/api/projects/{self.pid}/live', headers={'origin': 'http://testserver'}):
                pass
        anon.close()
        with self.assertRaises(Exception):
            with self.a.websocket_connect(f'/api/projects/{self.pid}/live', headers={'origin': 'https://untrusted.example'}):
                pass


class MergeUnitTests(unittest.TestCase):
    def test_node_conflict_on_shared_junction_is_blocked(self):
        shifted = BASE.replace('lat="52.0"', 'lat="52.01"')
        other = BASE.replace('lat="52.0"', 'lat="52.02"')
        result, problems = merge_disjoint_changes(BASE, shifted, other)
        self.assertEqual(result, '')
        self.assertIn('node/1', problems)

    def test_two_new_ways_with_same_negative_id_cannot_replace_each_other(self):
        first = BASE.replace('</osm>', '<way id="-1"><nd ref="1"/><nd ref="2"/></way></osm>')
        other = BASE.replace('</osm>', '<way id="-1"><nd ref="3"/><nd ref="4"/></way></osm>')
        result, problems = merge_disjoint_changes(BASE, first, other)
        self.assertIn('way/-1', problems)
        self.assertFalse(result)

    def test_delete_of_node_used_by_colleague_is_blocked(self):
        local = BASE.replace('<node id="4" lat="52.3" lon="104.3"/>', '').replace('<nd ref="4"/>', '')
        remote = BASE.replace('</osm>', '<way id="300"><nd ref="4"/><nd ref="1"/></way></osm>')
        result, problems = merge_disjoint_changes(BASE, local, remote)
        self.assertFalse(result)
        self.assertTrue(any('300' in p for p in problems))


if __name__ == '__main__':
    unittest.main()

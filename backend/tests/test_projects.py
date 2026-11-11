import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.tests.helpers import login_admin
from backend.osm_merge import EMPTY_OSM, merge_xml, parse_osm, remove_source_xml

OSM_A = '''<osm version="0.6">
  <node id="1" lat="52.1" lon="104.1" /><node id="2" lat="52.2" lon="104.2" />
  <way id="101"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="lanes" v="2"/></way>
  <relation id="301"><member type="way" ref="101" role="from"/><tag k="type" v="route"/></relation>
</osm>'''
OSM_B = '''<osm version="0.6">
  <node id="2" lat="52.2" lon="104.2"/><node id="3" lat="52.3" lon="104.3"/>
  <way id="102"><nd ref="2"/><nd ref="3"/><tag k="highway" v="secondary"/></way>
</osm>'''
NEG_A = '''<osm version="0.6"><node id="-1" lat="1" lon="2"/><node id="-2" lat="2" lon="3"/>
  <way id="-1"><nd ref="-1"/><nd ref="-2"/><tag k="highway" v="residential"/></way></osm>'''
NEG_B = '''<osm version="0.6"><node id="-1" lat="3" lon="4"/><node id="-2" lat="4" lon="5"/>
  <way id="-1"><nd ref="-1"/><nd ref="-2"/><tag k="highway" v="residential"/></way>
  <relation id="-1"><member type="way" ref="-1" role="from"/></relation></osm>'''


class MergeTests(unittest.TestCase):
    def test_shared_node_and_new_road_do_not_duplicate(self):
        merged, refs_a = merge_xml(EMPTY_OSM, OSM_A)
        merged, refs_b = merge_xml(merged, OSM_B)
        root = parse_osm(merged)
        self.assertEqual(len(root.findall('node')), 3)
        self.assertEqual(len(root.findall('way')), 2)
        self.assertEqual(len(root.findall('relation')), 1)
        self.assertEqual(refs_a['way'], ['101'])
        self.assertEqual(refs_b['node'], ['2', '3'])
        self.assertEqual([nd.get('ref') for nd in root.find("way[@id='102']").findall('nd')], ['2', '3'])

    def test_negative_collisions_are_remapped_recursively(self):
        base, _ = merge_xml(EMPTY_OSM, NEG_A)
        merged, refs = merge_xml(base, NEG_B)
        root = parse_osm(merged)
        self.assertEqual(len(root.findall('node')), 4)
        self.assertEqual(len(root.findall('way')), 2)
        self.assertEqual(len(root.findall('relation')), 1)
        self.assertEqual(len({node.get('id') for node in root.findall('node')}), 4)
        new_way = root.find(f"way[@id='{refs['way'][0]}']")
        self.assertEqual([nd.get('ref') for nd in new_way.findall('nd')], refs['node'])
        member = root.find('relation/member')
        self.assertEqual(member.get('ref'), refs['way'][0])

    def test_negative_remap_does_not_steal_a_different_incoming_id(self):
        base, _ = merge_xml(EMPTY_OSM, '''<osm version="0.6"><node id="-1" lat="1" lon="1"/></osm>''')
        newer = '''<osm version="0.6"><node id="-1" lat="2" lon="2"/>
        <node id="-2" lat="3" lon="3"/><way id="-1"><nd ref="-1"/><nd ref="-2"/></way></osm>'''
        merged, refs = merge_xml(base, newer)
        root = parse_osm(merged)
        ids = [n.get('id') for n in root.findall('node')]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotEqual(refs['node'][0], '-2')
        new_way = root.find("way[@id='-1']")
        self.assertEqual([n.get('ref') for n in new_way.findall('nd')], refs['node'])

    def test_delete_one_source_preserves_other_and_existing_changes(self):
        base, a = merge_xml(EMPTY_OSM, OSM_A)
        merged, b = merge_xml(base, OSM_B)
        root = ET.fromstring(merged)
        root.find("way[@id='102']").append(ET.Element('tag', {'k': 'name', 'v': 'Edited'}))
        edited = ET.tostring(root, encoding='unicode')
        reduced = parse_osm(remove_source_xml(edited, a, [b]))
        self.assertIsNone(reduced.find("way[@id='101']"))
        self.assertIsNotNone(reduced.find("way[@id='102']"))
        self.assertEqual(reduced.find("way[@id='102']/tag[@k='name']").get('v'), 'Edited')
        self.assertIsNotNone(reduced.find("node[@id='2']"))
        self.assertIsNone(reduced.find("node[@id='1']"))
        self.assertIsNone(reduced.find("relation[@id='301']"))

    def test_rejects_doctype_and_malformed_xml(self):
        with self.assertRaises(ValueError):
            parse_osm('<!DOCTYPE foo [<!ENTITY exploit "lots">]><osm version="0.6"/>')
        with self.assertRaises(ValueError):
            parse_osm('<osm><way></osm>')


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.client = TestClient(create_app(Path(self.folder.name)))
        login_admin(self.client, Path(self.folder.name))

    def tearDown(self):
        self.client.close()
        self.folder.cleanup()

    def test_full_project_cycle_and_reopen(self):
        self.assertEqual(self.client.get('/api/health').json(), {'ok': True})
        create = self.client.post('/api/projects', json={'name': 'Иркутск'});
        self.assertEqual(create.status_code, 201)
        pid = create.json()['id']
        a = self.client.post(f'/api/projects/{pid}/sources', json={'filename': 'one.osm', 'xml': OSM_A})
        self.assertEqual(a.status_code, 201)
        b = self.client.post(f'/api/projects/{pid}/sources', json={'filename': 'two.osm', 'xml': OSM_B})
        self.assertEqual(b.status_code, 201)
        self.assertEqual(b.json()['source_count'], 2)
        self.assertEqual(len(self.client.get('/api/projects').json()), 1)
        document = self.client.get(f'/api/projects/{pid}/workspace').json()
        self.assertEqual(len(parse_osm(document['xml']).findall('way')), 2)
        modified = document['xml'].replace('v="2"', 'v="4"')
        saved = self.client.put(f'/api/projects/{pid}/workspace', json={'xml': modified, 'expected_revision': document['revision']})
        self.assertEqual(saved.status_code, 200)
        same = self.client.put(f'/api/projects/{pid}/workspace', json={
            'xml': modified, 'expected_revision': document['revision'],
        })
        self.assertEqual(same.status_code, 200, 'same entity content is an idempotent merge')
        self.assertTrue(same.json()['merged'])
        reopened = self.client.get(f'/api/projects/{pid}/workspace').json()
        self.assertIn('v="4"', reopened['xml'])
        first_source_id = b.json()['sources'][0]['id']
        delete = self.client.delete(f'/api/projects/{pid}/sources/{first_source_id}')
        self.assertEqual(delete.status_code, 200)
        self.assertEqual(delete.json()['source_count'], 1)
        self.assertEqual(len(parse_osm(self.client.get(f'/api/projects/{pid}/workspace').json()['xml']).findall('way')), 1)
        self.assertEqual(self.client.delete(f'/api/projects/{pid}').status_code, 204)
        self.assertEqual(self.client.get('/api/projects').json(), [])
        self.assertEqual(self.client.get(f'/api/projects/{pid}').status_code, 404)

    def test_duplicate_and_invalid_sources_never_damage_workspace(self):
        project_id = self.client.post('/api/projects', json={'name': 'A'}).json()['id']
        first = self.client.post(f'/api/projects/{project_id}/sources', json={'filename': 'a.osm', 'xml': OSM_A})
        self.assertEqual(first.status_code, 201)
        old = self.client.get(f'/api/projects/{project_id}/workspace').json()
        same = self.client.post(f'/api/projects/{project_id}/sources', json={'filename': 'a.osm', 'xml': OSM_A})
        self.assertEqual(same.status_code, 409)
        invalid = self.client.post(f'/api/projects/{project_id}/sources', json={'filename': 'bad.osm', 'xml': '<osm><bad>'})
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(self.client.get(f'/api/projects/{project_id}/workspace').json(), old)

    def test_multiple_negative_way_ids_do_not_collide(self):
        pid = self.client.post('/api/projects', json={'name': 'X'}).json()['id']
        for name, xml in [('negativeA.osm', NEG_A), ('negativeB.osm', NEG_B)]:
            self.assertEqual(self.client.post(f'/api/projects/{pid}/sources', json={'filename': name, 'xml': xml}).status_code, 201)
        root = parse_osm(self.client.get(f'/api/projects/{pid}/workspace').json()['xml'])
        self.assertEqual(len(root.findall('way')), 2)
        self.assertEqual(len({w.get('id') for w in root.findall('way')}), 2)


if __name__ == '__main__':
    unittest.main()

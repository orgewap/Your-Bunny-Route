"""Regression coverage for source deletion in shared OSM projects."""
import sqlite3
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.osm_merge import EMPTY_OSM, merge_xml, parse_osm, remove_source_xml
from backend.tests.helpers import login_admin

BASE = '''<osm version="0.6">
  <node id="1" lat="52.1" lon="104.1"/><node id="2" lat="52.1" lon="104.2"/>
  <node id="3" lat="52.1" lon="104.3"/><node id="4" lat="52.1" lon="104.4"/>
  <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
  <way id="200"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>
  <relation id="300"><member type="way" ref="100" role="from"/><tag k="type" v="route"/></relation>
</osm>'''
# The next source shares a route/way from the original but does not claim way 200.
# Importer does not automatically claim all referenced way members of relations.
FOLLOW = '''<osm version="0.6">
  <node id="3" lat="52.1" lon="104.3"/><node id="4" lat="52.1" lon="104.4"/>
  <relation id="301"><member type="way" ref="200" role=""/><tag k="type" v="route"/></relation>
</osm>'''

class SourceDependencyTests(unittest.TestCase):
    def test_keep_source_exclusive_way_if_another_relation_references_it(self):
        first, ra = merge_xml(EMPTY_OSM, BASE)
        both, rb = merge_xml(first, FOLLOW)
        report = {}
        result = parse_osm(remove_source_xml(both, ra, [rb], report=report))
        self.assertIsNotNone(result.find("way[@id='200']"))
        self.assertIsNone(result.find("way[@id='100']"))
        self.assertIsNotNone(result.find("relation[@id='301']"))
        self.assertIsNone(result.find("relation[@id='300']"))
        self.assertIsNotNone(result.find("node[@id='3']"))
        self.assertEqual(report['retained_ways'], 1)
        self.assertEqual(report['removed_ways'], 1)

    def test_nested_relation_and_hand_created_way_survive(self):
        a, ra = merge_xml(EMPTY_OSM, BASE)
        root = parse_osm(a)
        root.append(ET.fromstring('<relation id="-100"><member type="relation" ref="300"/></relation>'))
        root.append(ET.fromstring('<way id="-101"><nd ref="1"/><nd ref="2"/></way>'))
        updated = ET.tostring(root, encoding='unicode')
        report = {}
        result = parse_osm(remove_source_xml(updated, ra, [], report=report))
        self.assertIsNotNone(result.find("relation[@id='300']"))
        self.assertIsNotNone(result.find("way[@id='100']"))
        self.assertIsNotNone(result.find("way[@id='-101']"))
        self.assertIsNotNone(result.find("node[@id='1']"))
        self.assertEqual(report['retained_relations'], 1)

    def test_delete_a_source_when_remaining_one_claims_everything(self):
        both, ra = merge_xml(EMPTY_OSM, BASE)
        both, rb = merge_xml(both, BASE)
        report = {}
        result = parse_osm(remove_source_xml(both, ra, [rb], report=report))
        self.assertEqual(len(result.findall('way')), 2)
        self.assertEqual(report['removed_ways'], 0)

    def test_api_removal_preserves_surviving_relation_and_reports(self):
        with tempfile.TemporaryDirectory() as d:
            client = TestClient(create_app(Path(d)))
            login_admin(client, Path(d))
            project_id = client.post('/api/projects', json={'name': 'Shared'}).json()['id']
            url = f'/api/projects/{project_id}/sources'
            first = client.post(url, json={'filename': 'a.osm', 'xml': BASE})
            self.assertEqual(first.status_code, 201, first.text)
            second = client.post(url, json={'filename': 'b.osm', 'xml': FOLLOW})
            self.assertEqual(second.status_code, 201, second.text)
            first_id = first.json()['sources'][0]['id']
            deletion = client.delete(f'{url}/{first_id}')
            self.assertEqual(deletion.status_code, 200, deletion.text)
            self.assertEqual(deletion.json()['source_count'], 1)
            self.assertEqual(deletion.json()['removal']['retained_ways'], 1)
            xml = client.get(f'/api/projects/{project_id}/workspace').json()['xml']
            parsed = parse_osm(xml)
            self.assertIsNotNone(parsed.find("relation[@id='301']"))
            self.assertIsNotNone(parsed.find("way[@id='200']"))
            self.assertIsNone(parsed.find("way[@id='100']"))
            client.close()

    def test_existing_source_overlap_reports_shared_way_ids(self):
        with tempfile.TemporaryDirectory() as d:
            client = TestClient(create_app(Path(d)))
            login_admin(client, Path(d))
            project_id = client.post('/api/projects', json={'name': 'Overlap'}).json()['id']
            url = f'/api/projects/{project_id}/sources'
            first = client.post(url, json={'filename': 'a.osm', 'xml': BASE})
            self.assertEqual(first.status_code, 201)
            incoming = '''<osm version="0.6"><node id="1" lat="52.1" lon="104.1"/>
              <node id="2" lat="52.1" lon="104.2"/>
              <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></osm>'''
            response = client.post(url, json={'filename': 'b.osm', 'xml': incoming})
            self.assertEqual(response.status_code, 201, response.text)
            audit = client.get(f'/api/projects/{project_id}/overlaps')
            self.assertEqual(audit.status_code, 200, audit.text)
            self.assertEqual(audit.json()['pairs'][0]['shared_ids']['way'], 1)
            self.assertEqual(audit.json()['pairs'][0]['shared_ids']['node'], 2)
            client.close()

if __name__ == '__main__':
    unittest.main()

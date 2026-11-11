import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.tests.helpers import login_admin
from backend.osm_merge import EMPTY_OSM, merge_xml, parse_osm, remove_source_xml
from backend.osm_overlap import analyze_overlap


def make_xml(way_id, points, *, lanes='2', name='Main', oneway='', relation=False, start_node=100):
    nodes = ''.join(f'<node id="{start_node+i}" lon="{lon:.8f}" lat="{lat:.8f}"/>' for i, (lon, lat) in enumerate(points))
    refs = ''.join(f'<nd ref="{start_node+i}"/>' for i in range(len(points)))
    tags = f'<tag k="highway" v="residential"/><tag k="lanes" v="{lanes}"/><tag k="name" v="{name}"/>'
    if oneway:
        tags += f'<tag k="oneway" v="{oneway}"/>'
    rel = f'<relation id="5678"><member type="way" ref="{way_id}" role="from"/><tag k="type" v="route"/></relation>' if relation else ''
    return f'<osm version="0.6">{nodes}<way id="{way_id}">{refs}{tags}</way>{rel}</osm>'


GEO = [(104.0, 52.0), (104.001, 52.0)]


class OverlapGeometryTests(unittest.TestCase):
    def test_different_ids_exact_geometry_review_and_dedupe(self):
        a = make_xml(10, GEO, start_node=1)
        b = make_xml(11, GEO, start_node=9, relation=True)
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['duplicate'], 1)
        self.assertTrue(report['review_needed'])
        with self.assertRaises(ValueError):
            merge_xml(a, b)  # import can't silently accept overlap
        merged, refs = merge_xml(a, b, 'keep_existing')
        root = parse_osm(merged)
        self.assertEqual([w.get('id') for w in root.findall('way')], ['10'])
        self.assertEqual(refs['way'], ['10'])
        self.assertEqual(root.find('relation/member').get('ref'), '10')

    def test_choose_both_keeps_distinct_ids_and_positions(self):
        a = make_xml(10, GEO, start_node=1)
        b = make_xml(11, GEO, start_node=9)
        merged, refs = merge_xml(a, b, 'keep_both')
        self.assertEqual(len(parse_osm(merged).findall('way')), 2)
        self.assertEqual(refs['way'], ['11'])

    def test_update_tags_only_preserves_existing_geometry_and_relation_identity(self):
        a = make_xml(10, GEO, start_node=1, lanes='2')
        b = make_xml(11, GEO, start_node=9, lanes='4', relation=True)
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['attribute_conflict'], 1)
        merged, refs = merge_xml(a, b, 'new_tags')
        root = parse_osm(merged)
        self.assertEqual(len(root.findall('way')), 1)
        old = root.find("way[@id='10']")
        self.assertEqual([n.get('ref') for n in old.findall('nd')], ['1', '2'])
        self.assertEqual(old.find("tag[@k='lanes']").get('v'), '4')
        self.assertEqual(root.find('relation/member').get('ref'), '10')
        self.assertEqual(refs['way'], ['10'])

    def test_parallel_separate_road_is_not_deduped(self):
        a = make_xml(10, GEO, start_node=1, oneway='yes')
        b = make_xml(11, [(lon, lat + .000030) for lon, lat in GEO], start_node=9, oneway='yes')
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['duplicate'], 0)
        self.assertEqual(report['counts']['attribute_conflict'], 0)
        merged, _ = merge_xml(a, b, 'keep_existing')
        self.assertEqual(len(parse_osm(merged).findall('way')), 2)

    def test_partial_overlap_is_detected_but_never_truncated(self):
        a = make_xml(10, GEO, start_node=1)
        b = make_xml(11, [(104.0005, 52.0), (104.0015, 52.0)], start_node=9)
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['partial'], 1)
        merged, _ = merge_xml(a, b, 'keep_existing')
        self.assertEqual(len(parse_osm(merged).findall('way')), 2)

    def test_coincident_opposing_one_way_traffic_is_never_deduped(self):
        a = make_xml(10, GEO, start_node=1, oneway='yes')
        b = make_xml(11, list(reversed(GEO)), start_node=9, oneway='yes')
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['direction_conflict'], 1)
        self.assertEqual(report['counts']['duplicate'], 0)
        merged, _ = merge_xml(a, b, 'keep_existing')
        self.assertEqual(len(parse_osm(merged).findall('way')), 2)

    def test_bridged_road_above_surface_is_not_deduped(self):
        a = make_xml(10, GEO, start_node=1)
        b = make_xml(11, GEO, start_node=9)
        b = b.replace('</way>', '<tag k="bridge" v="yes"/><tag k="layer" v="1"/></way>')
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['duplicate'], 0)
        merged, _ = merge_xml(a, b, 'keep_existing')
        self.assertEqual(len(parse_osm(merged).findall('way')), 2)

    def test_oneway_vs_two_way_is_not_silently_collapsed(self):
        a = make_xml(10, GEO, start_node=1, oneway='yes')
        b = make_xml(11, GEO, start_node=9)
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['direction_conflict'], 1)
        merged, _ = merge_xml(a, b, 'keep_existing')
        self.assertEqual(len(parse_osm(merged).findall('way')), 2)

    def test_crossing_has_no_false_match(self):
        a = make_xml(10, GEO, start_node=1)
        b = make_xml(11, [(104.0005, 51.9995), (104.0005, 52.0005)], start_node=9)
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertFalse(report['review_needed'])

    def test_shared_positive_node_far_apart_is_remapped_not_moved(self):
        a = make_xml(10, GEO, start_node=1)
        b = make_xml(11, [(104.01, 52.01), (104.011, 52.01)], start_node=1)
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['node_id_conflict'], 2)
        merged, refs = merge_xml(a, b, 'keep_existing')
        root = parse_osm(merged)
        self.assertEqual(len(root.findall('node')), 4)
        self.assertEqual(len(set(n.get('id') for n in root.findall('node'))), 4)
        self.assertTrue(all(int(nid) < 0 for nid in refs['node']))
        new = root.find("way[@id='11']")
        self.assertEqual([n.get('ref') for n in new.findall('nd')], refs['node'])

    def test_conflicting_positive_way_id_can_fork_if_explicitly_keeping_both(self):
        a = make_xml(10, GEO, start_node=1)
        b = make_xml(10, [(104.003, 52), (104.004, 52)], start_node=9)
        report = analyze_overlap(parse_osm(a), parse_osm(b))
        self.assertEqual(report['counts']['id_conflict'], 1)
        merged, refs = merge_xml(a, b, 'keep_both')
        root = parse_osm(merged)
        self.assertEqual(len(root.findall('way')), 2)
        self.assertEqual(root.find("way[@id='10']").find('nd').get('ref'), '1')
        self.assertTrue(int(refs['way'][0]) < 0)

    def test_deleting_sources_in_either_order_does_not_leave_orphan_canonical_nodes(self):
        first = make_xml(10, GEO, start_node=1)
        second = make_xml(11, GEO, start_node=9)
        merged_a, refs_a = merge_xml(EMPTY_OSM, first)
        combined, refs_b = merge_xml(merged_a, second, 'keep_existing')
        self.assertIn('1', refs_b['node'])
        self.assertIn('2', refs_b['node'])
        after_a = remove_source_xml(combined, refs_a, [refs_b])
        after_b = parse_osm(remove_source_xml(after_a, refs_b, []))
        self.assertEqual(len(after_b.findall('way')), 0)
        self.assertEqual(len(after_b.findall('node')), 0)

    def test_deleting_original_source_keeps_deduped_way_claimed_by_second(self):
        a, refs_a = merge_xml(EMPTY_OSM, make_xml(10, GEO, start_node=1))
        merged, refs_b = merge_xml(a, make_xml(11, GEO, start_node=9), 'keep_existing')
        after = parse_osm(remove_source_xml(merged, refs_a, [refs_b]))
        self.assertIsNotNone(after.find("way[@id='10']"))


class OverlapApiTests(unittest.TestCase):
    def setUp(self):
        self.data = tempfile.TemporaryDirectory()
        self.client = TestClient(create_app(Path(self.data.name)))
        login_admin(self.client, Path(self.data.name))
        self.pid = self.client.post('/api/projects', json={'name': 'Network'}).json()['id']
        self.first = make_xml(10, GEO, start_node=1)
        self.second = make_xml(11, GEO, start_node=9)
        self.assertEqual(self.client.post(f'/api/projects/{self.pid}/sources', json={
            'filename': 'first.osm', 'xml': self.first,
        }).status_code, 201)

    def tearDown(self):
        self.client.close()
        self.data.cleanup()

    def test_preview_read_only_requires_policy_and_revision(self):
        api = f'/api/projects/{self.pid}/sources'
        before = self.client.get(f'/api/projects/{self.pid}/workspace').json()
        preview = self.client.post(api+'/preview', json={'filename':'second.osm','xml':self.second})
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json()['counts']['duplicate'], 1)
        self.assertEqual(self.client.get(f'/api/projects/{self.pid}/workspace').json(), before)
        self.assertEqual(self.client.post(api, json={'filename':'second.osm','xml':self.second}).status_code, 409)
        self.assertEqual(self.client.post(api, json={'filename':'second.osm','xml':self.second,
            'policy':'keep_existing','expected_revision':before['revision']+1}).status_code, 409)
        result = self.client.post(api, json={'filename':'second.osm','xml':self.second,
            'policy':'keep_existing','expected_revision':before['revision']})
        self.assertEqual(result.status_code, 201)
        self.assertEqual(len(parse_osm(self.client.get(f'/api/projects/{self.pid}/workspace').json()['xml']).findall('way')), 1)

    def test_audit_existing_sources_is_read_only(self):
        api = f'/api/projects/{self.pid}/sources'
        self.assertEqual(self.client.post(api, json={
            'filename': 'other.osm', 'xml': self.second, 'policy': 'keep_both',
        }).status_code, 201)
        before = self.client.get(f'/api/projects/{self.pid}/workspace').json()
        audit = self.client.get(f'/api/projects/{self.pid}/overlaps')
        self.assertEqual(audit.status_code, 200)
        payload = audit.json()
        self.assertEqual(payload['sources'], 2)
        self.assertEqual(len(payload['pairs']), 1)
        self.assertEqual(payload['pairs'][0]['counts']['duplicate'], 1)
        self.assertEqual(self.client.get(f'/api/projects/{self.pid}/workspace').json(), before)

    def test_keep_both_in_api_keeps_two(self):
        api=f'/api/projects/{self.pid}/sources'
        rev = self.client.post(api+'/preview',json={'filename':'b.osm','xml':self.second}).json()['revision']
        result = self.client.post(api,json={'filename':'b.osm','xml':self.second,
            'policy':'keep_both','expected_revision':rev})
        self.assertEqual(result.status_code, 201)
        self.assertEqual(len(parse_osm(self.client.get(f'/api/projects/{self.pid}/workspace').json()['xml']).findall('way')), 2)


if __name__ == '__main__':
    unittest.main()

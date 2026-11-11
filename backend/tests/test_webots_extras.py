"""Regression cases for the non-invasive Webots infrastructure exporter."""
from __future__ import annotations

import io
import json
import unittest
import zipfile
from backend.webots_extras import (BEGIN, END, Projection, Builder, ExportSettings,
                                   WebotsExportError, export_bundle, merge_world, osm_with_bounds, read_osm)

OSM = '''<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="52.0000" lon="104.0000"/>
  <node id="2" lat="52.0000" lon="104.0006">
    <tag k="highway" v="traffic_signals"/>
    <tag k="road_editor:road" v="5"/>
    <tag k="road_editor:lanes" v="2,3"/>
  </node>
  <node id="3" lat="52.0000" lon="104.0012"/>
  <node id="4" lat="52.00003" lon="104.0006"><tag k="highway" v="crossing"/><tag k="crossing:markings" v="zebra"/></node>
  <node id="5" lat="52.0003" lon="104.0002"/>
  <node id="6" lat="52.0003" lon="104.0009"/>
  <node id="7" lat="52.0000" lon="104.0003"/>
  <node id="8" lat="52.0000" lon="104.0005"/>
  <way id="5"><nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="primary"/><tag k="lanes" v="4"/><tag k="sidewalk" v="both"/>
    <tag k="road_editor:centre_marking" v="double"/>
  </way>
  <way id="6"><nd ref="5"/><nd ref="6"/>
    <tag k="highway" v="secondary"/><tag k="bridge" v="yes"/><tag k="layer" v="1"/>
    <tag k="road_editor:support_spacing" v="15"/><tag k="road_editor:guard_rail" v="both"/>
  </way>
  <way id="7"><nd ref="7"/><nd ref="8"/><tag k="barrier" v="kerb"/><tag k="height" v="0.2"/></way>
  <relation id="17"><member type="way" ref="5" role="from"/><tag k="type" v="restriction"/></relation>
</osm>'''


class TestWebotsExtras(unittest.TestCase):
    def test_importer_bounds_added_without_losing_osm_nodes_ways_relations(self):
        model = read_osm(OSM)
        source = osm_with_bounds(OSM, model.bounds)
        self.assertEqual(source.count('<bounds'), 1)
        self.assertIn('relation id="17"', source)
        self.assertEqual(len(read_osm(source).nodes), len(model.nodes))
        self.assertEqual(osm_with_bounds(source, model.bounds), source)

    def test_real_world_utm_projection_matches_local_offset(self):
        model = read_osm(OSM)
        projection = Projection(model.bounds)
        south,west,north,east = model.bounds
        xa,ya = projection.project(west,south)
        xb,yb = projection.project(east,north)
        xa -= projection.x_offset
        ya -= projection.y_offset
        xb -= projection.x_offset
        yb -= projection.y_offset
        self.assertAlmostEqual((xa + xb) / 2, 0, delta=0.1)
        self.assertAlmostEqual((ya + yb) / 2, 0, delta=0.1)
        self.assertTrue(projection.proj_string.startswith('+proj=utm'))

    def test_shapes_include_signal_poles_kerbs_rails_piers_crossings_and_lines(self):
        model = read_osm(OSM)
        builder = Builder(model, ExportSettings(), Projection(model.bounds))
        result = builder.generate()
        for kind in ('kerbs', 'markings', 'crossings', 'signals', 'supports', 'guardrails'):
            self.assertGreater(builder.counts[kind], 0, kind)
        self.assertIn('bridge-pier-6', result)
        self.assertGreater(builder.counts['crossings'], 0)
        self.assertIn('signal-stop-2-1', result)
        self.assertIn('signal-stop-2-2', result)
        self.assertNotIn('signal-stop-2-0', result)
        self.assertNotIn('signal-stop-2-3', result)
        self.assertEqual(result.count(BEGIN), 1)

    def test_merge_idempotent_and_header_validated(self):
        block = BEGIN + '\nTransform {}\n' + END + '\n'
        world = '#VRML_SIM R2025a utf8\nWorldInfo {}\n'
        once = merge_world(world, block)
        twice = merge_world(once, block)
        self.assertEqual(once, twice)
        with self.assertRaises(WebotsExportError):
            merge_world('not a world', block)

    def test_bundle_contains_ready_world_when_supplied(self):
        bundle = export_bundle(OSM, '#VRML_SIM R2025a utf8\nWorldInfo {}')
        with zipfile.ZipFile(io.BytesIO(bundle)) as z:
            names = set(z.namelist())
            self.assertIn('webots-ready.wbt', names)
            self.assertIn('webots-source.osm', names)
            self.assertIn('extras-to-merge.txt', names)
            self.assertIn('report.json', names)
            report = json.loads(z.read('report.json'))
            self.assertGreater(report['counts']['signals'], 0)
            self.assertIn(BEGIN, z.read('webots-ready.wbt').decode())

    def test_project_xml_is_not_rewritten_except_bounds_copy(self):
        original = OSM
        export_bundle(original)
        self.assertEqual(original, OSM)

    def test_invalid_document_is_rejected(self):
        with self.assertRaises(WebotsExportError):
            read_osm('<html/>')
        with self.assertRaises(WebotsExportError):
            read_osm('<osm><way></osm>')

    def test_standard_osm_turn_lanes_generates_arrows(self):
        changed=OSM.replace('<tag k="sidewalk" v="both"/>',
            '<tag k="sidewalk" v="both"/><tag k="oneway" v="yes"/>'
            '<tag k="turn:lanes" v="left|through|through;right|right"/>')
        model=read_osm(changed)
        builder=Builder(model,ExportSettings(),Projection(model.bounds))
        result=builder.generate()
        self.assertIn('turn-5-forward-0-left-shaft',result)
        self.assertIn('turn-5-forward-1-through-shaft',result)
        self.assertIn('turn-5-forward-3-right-shaft',result)

    def test_road_supports_can_be_disabled(self):
        disabled = OSM.replace('<tag k="road_editor:support_spacing" v="15"/>', '<tag k="road_editor:bridge_support" v="none"/>')
        model = read_osm(disabled)
        builder = Builder(model,ExportSettings(),Projection(model.bounds))
        builder.generate()
        self.assertEqual(builder.counts['supports'],0)


if __name__ == '__main__':
    unittest.main()

class TestWebotsApi(unittest.TestCase):
    def test_download_requires_auth_but_does_not_change_project_database(self):
        import tempfile
        import sqlite3
        from pathlib import Path
        from fastapi.testclient import TestClient
        from backend.main import create_app
        from backend.tests.helpers import login_admin
        with tempfile.TemporaryDirectory() as tmp:
            client = TestClient(create_app(Path(tmp)))
            req = {'xml': OSM}
            self.assertEqual(client.post('/api/webots/export', json=req).status_code, 401)
            login_admin(client, Path(tmp))
            old = sqlite3.connect(Path(tmp) / 'projects.sqlite3').execute('SELECT COUNT(*) FROM projects').fetchone()[0]
            response = client.post('/api/webots/export', json=req)
            self.assertEqual(response.status_code, 200, response.text[:200])
            self.assertEqual(response.headers['content-type'], 'application/zip')
            self.assertIn('webots-source.osm', zipfile.ZipFile(io.BytesIO(response.content)).namelist())
            newer = sqlite3.connect(Path(tmp) / 'projects.sqlite3').execute('SELECT COUNT(*) FROM projects').fetchone()[0]
            self.assertEqual(old, newer)
            client.close()

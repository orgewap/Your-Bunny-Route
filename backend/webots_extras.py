"""Webots 3D infrastructure companion for Road Editor OSM projects.

The Cyberbotics OSM importer generates the BASE world. This module adds
visual (and optional static collision) street infrastructure from the SAME
OSM. The geographic projection / bounds are matched to the importer.
No Webots, SUMO, or PyQt process is started by the API.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

BEGIN = '# ROAD_EDITOR_WEBOTS_EXTRAS_BEGIN'
END = '# ROAD_EDITOR_WEBOTS_EXTRAS_END'
LEVEL_HEIGHT = 5.0
LANE_WIDTH = 3.5


@dataclass(frozen=True)
class Node:
    lon: float
    lat: float
    tags: dict[str, str]


@dataclass(frozen=True)
class Way:
    osm_id: str
    refs: tuple[str, ...]
    tags: dict[str, str]


@dataclass(frozen=True)
class Model:
    nodes: dict[str, Node]
    ways: tuple[Way, ...]
    bounds: tuple[float, float, float, float]  # south, west, north, east


@dataclass(frozen=True)
class ExportSettings:
    layer_height: float = LEVEL_HEIGHT
    support_spacing: float = 22.0
    include_markings: bool = True
    include_crossings: bool = True
    include_signals: bool = True
    max_objects: int = 12000


class WebotsExportError(ValueError):
    pass


def read_osm(xml: str) -> Model:
    if len(xml) > 40_000_000:
        raise WebotsExportError('OSM XML слишком большой (максимум 40 МБ).')
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise WebotsExportError('Некорректный OSM XML.') from exc
    if root.tag != 'osm':
        raise WebotsExportError('Ожидается файл OSM XML 0.6.')
    nodes: dict[str, Node] = {}
    for el in root.findall('node'):
        try:
            lon, lat = float(el.attrib['lon']), float(el.attrib['lat'])
        except (KeyError, ValueError):
            continue
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            continue
        nodes[el.attrib.get('id', '')] = Node(lon, lat, {t.get('k', ''): t.get('v', '') for t in el.findall('tag')})
    if not nodes:
        raise WebotsExportError('В OSM нет узлов с координатами.')
    ways = tuple(Way(el.attrib.get('id', ''), tuple(n.get('ref', '') for n in el.findall('nd')),
                     {t.get('k', ''): t.get('v', '') for t in el.findall('tag')})
                 for el in root.findall('way'))
    bound = root.find('bounds')
    try:
        if bound is None:
            raise KeyError('bounds')
        bounds = (float(bound.attrib['minlat']), float(bound.attrib['minlon']),
                  float(bound.attrib['maxlat']), float(bound.attrib['maxlon']))
        if not (bounds[0] < bounds[2] and bounds[1] < bounds[3]):
            raise ValueError('bounds')
    except (KeyError, ValueError):
        # The official importer needs a bounds tag, so we also add it to the
        # OSM copy distributed in the Webots export bundle.
        lats = [v.lat for v in nodes.values()]
        lons = [v.lon for v in nodes.values()]
        bounds = (min(lats), min(lons), max(lats), max(lons))
        if bounds[0] == bounds[2]:
            bounds = (bounds[0] - 0.00001, bounds[1], bounds[2] + 0.00001, bounds[3])
        if bounds[1] == bounds[3]:
            bounds = (bounds[0], bounds[1] - 0.00001, bounds[2], bounds[3] + 0.00001)
    return Model(nodes, ways, bounds)


def osm_with_bounds(xml: str, bounds: tuple[float, float, float, float]) -> str:
    """Insert a bounds tag without rewriting original OSM tags/relations."""
    if re.search(r'<bounds(?:\s|/?>)', xml):
        return xml
    match = re.search(r'<osm(?:\s[^<>]*?)?>', xml)
    if not match:
        raise WebotsExportError('Не найден корневой элемент osm.')
    south, west, north, east = bounds
    tag = f'<bounds minlat="{south:.9f}" minlon="{west:.9f}" maxlat="{north:.9f}" maxlon="{east:.9f}"/>'
    return xml[:match.end()] + '\n  ' + tag + xml[match.end():]


class Projection:
    def __init__(self, bounds: tuple[float, float, float, float], custom: str | None = None):
        try:
            from pyproj import Proj
        except ImportError as exc:
            raise WebotsExportError('Для Webots-экспорта установите: python -m pip install pyproj') from exc
        s, w, n, e = bounds
        lon0, lat0 = (w + e) / 2, (s + n) / 2
        zone = max(1, min(60, math.floor((lon0 + 180) / 6) + 1))
        self.proj_string = (custom or
            f'+proj=utm +{"south" if lat0 < 0 else "north"} +zone={zone} '
            f'+lon_0={lon0:.6f} +lat_0={lat0:.6f} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs')
        self.project = Proj(self.proj_string)
        xa, ya = self.project(w, s)
        xb, yb = self.project(e, n)
        self.x_offset, self.y_offset = (xa + xb) / 2, (ya + yb) / 2

    def pt(self, node: Node) -> tuple[float, float]:
        x, y = self.project(node.lon, node.lat)
        return x - self.x_offset, y - self.y_offset


def clamp_float(value: str | None, default: float, low: float, high: float) -> float:
    try:
        number = float(value) if value else default
        if math.isfinite(number):
            return min(high, max(low, number))
    except ValueError:
        pass
    return default


def label(value: str) -> str:
    return re.sub(r'[^\w.:-]', '_', value)[:70]


def number(value: float) -> str:
    return f'{value:.4f}'


def tags_direction(tags: dict[str, str], key: str) -> str:
    value = tags.get(key, 'auto').strip().lower()
    return value if value in ('left', 'right', 'both', 'yes', 'no', 'auto') else 'auto'


def segment_lengths(points: list[tuple[float, float]]) -> Iterable[tuple[tuple[float, float], tuple[float, float], float]]:
    for a, b in zip(points, points[1:]):
        length = math.dist(a, b)
        if length > 0.05:
            yield a, b, length


def sample(points: list[tuple[float, float]], distance: float) -> tuple[float, float] | None:
    for a, b, length in segment_lengths(points):
        if distance <= length:
            t = max(0.0, distance / length)
            return a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t
        distance -= length
    return points[-1] if points else None


class Builder:
    def __init__(self, model: Model, opts: ExportSettings, proj: Projection):
        self.model, self.opts, self.proj = model, opts, proj
        self.parts: list[str] = []
        self.counts: dict[str, int] = {key: 0 for key in ('kerbs', 'markings', 'crossings', 'signals', 'supports', 'guardrails')}
        self.total = 0
        self.warnings: list[str] = []

    def add_shape(self, kind: str, name: str, x: float, y: float, z: float,
                  length: float, width: float, height: float, yaw: float,
                  rgb: tuple[float, float, float], collidable: bool = False):
        if self.total >= self.opts.max_objects:
            return
        if not all(math.isfinite(v) for v in (x, y, z, length, width, height, yaw)):
            return
        if min(length, width, height) <= 0:
            return
        if collidable:
            start = 'Solid'
            bounding = f'  boundingObject Box {{ size {number(length)} {number(width)} {number(height)} }}\n'
        else:
            start = 'Transform'
            bounding = ''
        clean = label(name)
        self.parts.append(
            f'# infrastructure:{kind} id:{clean}\n{start} {{\n  translation {number(x)} {number(y)} {number(z)}\n'
            f'  rotation 0 0 1 {number(yaw)}\n'
            f'{f"  name \"{clean}\"\n" if collidable else ""}'
            '  children [ Shape {\n'
            f'    appearance PBRAppearance {{ baseColor {number(rgb[0])} {number(rgb[1])} {number(rgb[2])} roughness 1 }}\n'
            f'    geometry Box {{ size {number(length)} {number(width)} {number(height)} }}\n'
            '  } ]\n' + bounding + '}\n')
        self.total += 1
        self.counts[kind] += 1

    def beam(self, kind: str, name: str, a: tuple[float, float], b: tuple[float, float],
             z: float, width: float, height: float, color: tuple[float, float, float],
             collidable: bool = False):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length < 0.10:
            return
        self.add_shape(kind, name, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z,
                       length, width, height, math.atan2(dy, dx), color, collidable)

    def polyline(self, kind: str, way: Way, pts: list[tuple[float, float]],
                 z: float, width: float, height: float, color: tuple[float, float, float],
                 collidable: bool = False):
        for index, (a, b, _) in enumerate(segment_lengths(pts)):
            self.beam(kind, f'{kind}-{way.osm_id}-{index}', a, b, z, width, height, color, collidable)

    def edge_polyline(self, kind: str, way: Way, pts: list[tuple[float, float]],
                      offset: float, z: float, width: float, height: float,
                      color: tuple[float, float, float], collidable: bool):
        # Every input segment independently offset; avoids giant joins at
        # sharp bends while keeping a geometric road edge on straight roads.
        for index, (a, b, length) in enumerate(segment_lengths(pts)):
            nx, ny = -(b[1] - a[1]) / length, (b[0] - a[0]) / length
            shift = (nx * offset, ny * offset)
            self.beam(kind, f'{kind}-{way.osm_id}-{number(offset)}-{index}',
                      (a[0] + shift[0], a[1] + shift[1]),
                      (b[0] + shift[0], b[1] + shift[1]), z, width, height, color, collidable)

    def crossing(self, node_id: str, node: Node, road: Way, pts: list[tuple[float, float]], distance: float):
        if len(pts) < 2:
            return
        best: tuple[float, tuple[float, float], tuple[float, float], tuple[float, float]] | None = None
        x, y = self.proj.pt(node)
        for a, b, length in segment_lengths(pts):
            t = max(0, min(1, ((x-a[0])*(b[0]-a[0])+(y-a[1])*(b[1]-a[1])) / (length*length)))
            q = (a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t)
            d = math.dist((x,y),q)
            if best is None or d < best[0]:
                best = (d,a,b,q)
        if not best or best[0] > distance:
            return
        _, a, b, q = best
        length = math.dist(a,b)
        tx, ty = ((b[0]-a[0])/length, (b[1]-a[1])/length)
        nx, ny = -ty, tx
        lanes = int(clamp_float(road.tags.get('lanes'), 2, 1, 10))
        width = clamp_float(road.tags.get('width'), lanes*LANE_WIDTH, 2, 40)
        # Zebra stripes are elongated along direction of car travel and
        # distributed across road width. 2.5m crossing length along road.
        spacing = 0.75
        count = max(2, int(width/spacing))
        stripe_width = min(0.45, width / count * 0.65)
        for k in range(count):
            offset = (k + .5) * width / count - width/2
            sx, sy = q[0] + nx*offset, q[1] + ny*offset
            self.add_shape('crossings', f'zebra-{node_id}-{k}', sx, sy, 0.043,
                           2.6, stripe_width, 0.012, math.atan2(ty,tx), (0.95,0.95,0.92))

    def nearby_road(self, at: tuple[float, float], roads: list[tuple[Way, list[tuple[float, float]]]],
                    road_ref: str | None = None) -> tuple[Way, tuple[float,float], tuple[float,float], tuple[float,float], float] | None:
        """Find road segment, optionally bound to the explicit road_editor:road OSM way ID."""
        result = None
        for road,points in roads:
            if road_ref and road.osm_id != road_ref:
                continue
            for a,b,length in segment_lengths(points):
                t = max(0,min(1,((at[0]-a[0])*(b[0]-a[0])+(at[1]-a[1])*(b[1]-a[1]))/(length*length)))
                q = (a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t)
                d = math.dist(q,at)
                if result is None or d < result[-1]:
                    result=(road,a,b,q,d)
        return result if result and result[-1] <= 12 else None

    def traffic_stop_line(self, node_id: str, node: Node, near, index_prefix: str):
        road,a,b,q,_=near
        dx,dy = b[0]-a[0], b[1]-a[1]
        length = math.hypot(dx,dy)
        tx,ty=dx/length,dy/length
        nx,ny=-ty,tx
        count=int(clamp_float(road.tags.get('lanes'),2,1,10))
        selected=node.tags.get('road_editor:lanes','')
        try:
            lanes={int(item)-1 for item in selected.split(',')} if selected else set(range(count))
        except ValueError:
            lanes=set(range(count))
        lanes={item for item in lanes if 0 <= item < count}
        if not lanes:
            return
        # A small local supplement, no mutation of road shape/OSM connections.
        for lane in sorted(lanes):
            start=(lane-count/2)*LANE_WIDTH
            finish=start+LANE_WIDTH
            p1=(q[0]+nx*start,q[1]+ny*start)
            p2=(q[0]+nx*finish,q[1]+ny*finish)
            self.beam('markings',f'{index_prefix}-stop-{node_id}-{lane}',p1,p2,.05,.25,.013,(.97,.97,.93))

    def lane_turn_arrows(self, road: Way, points: list[tuple[float,float]], level: float):
        """Compact painted arrows from standard OSM turn:lanes tags."""
        tags=road.tags
        lane_count=int(clamp_float(tags.get('lanes'),2,1,10))
        if tags.get('oneway') in ('yes','1','true'):
            directions=[('forward',tags.get('turn:lanes') or tags.get('turn:lanes:forward',''),lane_count)]
        elif tags.get('oneway') == '-1':
            directions=[('backward',tags.get('turn:lanes') or tags.get('turn:lanes:backward',''),lane_count)]
        else:
            forward=int(clamp_float(tags.get('lanes:forward'),max(1,lane_count//2),0,10))
            backward=int(clamp_float(tags.get('lanes:backward'),max(0,lane_count-forward),0,10))
            directions=[('forward',tags.get('turn:lanes:forward',''),forward),
                        ('backward',tags.get('turn:lanes:backward',''),backward)]
        total=sum(length for _,_,length in segment_lengths(points))
        if total < 10:
            return
        for flow,pattern,available in directions:
            if not pattern or available <= 0:
                continue
            tokens=pattern.split('|')[:available]
            target=total-7 if flow=='forward' else 7
            start=sample(points,max(0,target-.5))
            end=sample(points,min(total,target+.5))
            center=sample(points,target)
            if not start or not end or not center:
                continue
            mag=math.dist(start,end)
            if mag < 0.1:
                continue
            dx,dy=(end[0]-start[0])/mag,(end[1]-start[1])/mag
            if flow=='backward':
                dx,dy=-dx,-dy
            nx,ny=-dy,dx
            for index, token in enumerate(tokens):
                if tags.get('oneway') in ('yes','1','true','-1'):
                    offset=(lane_count/2-index-.5)*LANE_WIDTH
                else:
                    # Right-hand OSM two-way lane split. Forward lanes occupy
                    # the right (negative OSM normal), backward the left.
                    offset=(-index-.5 if flow=='forward' else index+.5)*LANE_WIDTH
                    if flow=='backward':
                        offset=-offset # the normal already uses reverse travel
                cx,cy=center[0]+nx*offset,center[1]+ny*offset
                at=(cx,cy)
                for turn in token.split(';'):
                    if turn not in ('through','left','right','reverse'):
                        continue
                    p0=(at[0]-dx*1.1,at[1]-dy*1.1)
                    p1=(at[0]+dx*.35,at[1]+dy*.35)
                    if turn=='through':
                        tip=(p1[0]+dx*1.0,p1[1]+dy*1.0)
                    elif turn=='reverse':
                        tip=(p1[0]+nx*1.0-dx*.3,p1[1]+ny*1.0-dy*.3)
                    else:
                        side=1 if turn=='left' else -1
                        tip=(p1[0]+nx*side*1.1,p1[1]+ny*side*1.1)
                    self.beam('markings',f'turn-{road.osm_id}-{flow}-{index}-{turn}-shaft',p0,p1,level+.055,.12,.012,(.97,.97,.95))
                    self.beam('markings',f'turn-{road.osm_id}-{flow}-{index}-{turn}-head',p1,tip,level+.055,.12,.012,(.97,.97,.95))
                    ux,uy=tip[0]-p1[0],tip[1]-p1[1]
                    step=math.hypot(ux,uy)
                    if step > 0.1:
                        ux,uy=ux/step,uy/step
                        for side in (-1,1):
                            wing=(tip[0]-ux*.45+side*(-uy)*.3,tip[1]-uy*.45+side*ux*.3)
                            self.beam('markings',f'turn-{road.osm_id}-{index}-{turn}-{side}',wing,tip,level+.056,.12,.012,(.97,.97,.95))

    def generate(self) -> str:
        # Reuse official importer UTM projection and centred coordinates.
        projected = {key: self.proj.pt(node) for key, node in self.model.nodes.items()}
        traffic_types = {'motorway','trunk','primary','secondary','tertiary','residential','unclassified','service',
                         'living_street','motorway_link','trunk_link','primary_link','secondary_link','tertiary_link'}
        road_segments: list[tuple[Way, list[tuple[float, float]]]] = [
            (way,[projected[n] for n in way.refs if n in projected])
            for way in self.model.ways if way.tags.get('highway') in traffic_types and
            sum(1 for n in way.refs if n in projected) >= 2
        ]
        for way in self.model.ways:
            t = way.tags
            pts = [projected[n] for n in way.refs if n in projected]
            if len(pts) < 2:
                continue
            if t.get('highway') in traffic_types:
                count = int(clamp_float(t.get('lanes'), 2, 1, 10))
                road_width = clamp_float(t.get('width'), count*LANE_WIDTH, 2, 40)
                edge = road_width / 2 + .15
                kerb = tags_direction(t, 'road_editor:kerb')
                if kerb == 'auto' and t.get('sidewalk') in ('both','left','right','yes'):
                    kerb = 'both' if t.get('sidewalk') in ('both','yes') else t['sidewalk']
                kerb_h = clamp_float(t.get('road_editor:kerb_height'), .15, .03, .45)
                if kerb in ('both','yes','left'):
                    self.edge_polyline('kerbs', way, pts, edge, kerb_h/2, .15, kerb_h, (.58,.58,.55), True)
                if kerb in ('both','yes','right'):
                    self.edge_polyline('kerbs', way, pts, -edge, kerb_h/2, .15, kerb_h, (.58,.58,.55), True)
                support = t.get('road_editor:bridge_support','auto')
                is_bridge = t.get('bridge') in ('yes','viaduct') or (t.get('layer', '0').lstrip('+-').isdigit() and int(t.get('layer','0')) > 0)
                if is_bridge and support != 'none':
                    level = int(clamp_float(t.get('layer'),1,1,10))
                    deck = level*self.opts.layer_height
                    space = clamp_float(t.get('road_editor:support_spacing'),self.opts.support_spacing,8,100)
                    total_length = sum(length for _,_,length in segment_lengths(pts))
                    for d in (space*i for i in range(1, int(total_length//space)+1) if space*i < total_length-3):
                        pt = sample(pts,d)
                        if pt is not None:
                            # Do not place a support column on a ground-level
                            # carriageway crossing below the bridge.
                            blocked=False
                            for ground,segments in road_segments:
                                if ground.osm_id == way.osm_id or ground.tags.get('bridge') in ('yes','viaduct') or ground.tags.get('layer','0') not in ('0',''):
                                    continue
                                near_ground = self.nearby_road(pt, [(ground,segments)])
                                if near_ground and near_ground[-1] < clamp_float(ground.tags.get('lanes'),2,1,10)*LANE_WIDTH/2+1.8:
                                    blocked=True
                                    break
                            if blocked:
                                continue
                            self.add_shape('supports', f'bridge-pier-{way.osm_id}-{int(d)}', pt[0],pt[1],deck/2,
                                           min(2.0,road_width*.5), min(1.4,road_width*.35),deck,
                                           0, (.66,.64,.60),True)
                rail = tags_direction(t,'road_editor:guard_rail')
                if rail in ('yes','both','left','right'):
                    z = clamp_float(t.get('layer'), 0, 0, 10)*self.opts.layer_height
                    for offset in ([edge,-edge] if rail in ('yes','both') else [edge if rail == 'left' else -edge]):
                        self.edge_polyline('guardrails',way,pts,offset,z+.65,.10,1.3,(.58,.60,.62),True)
                if self.opts.include_markings:
                    self.lane_turn_arrows(way,pts,clamp_float(t.get('layer'),0,0,10)*self.opts.layer_height)
                    cm = (t.get('road_editor:centre_marking') or t.get('centre_line') or 'auto').lower()
                    if cm in ('solid','double','dashed'):
                        z = clamp_float(t.get('layer'),0,0,10)*self.opts.layer_height
                        if cm == 'double':
                            for off in (-.10,.10):
                                self.edge_polyline('markings', way,pts,off,z+.045,.10,.012,(.95,.84,.48),False)
                        elif cm == 'solid':
                            self.polyline('markings',way,pts,z+.045,.13,.012,(.95,.84,.48))
                        else:
                            for a,b,length in segment_lengths(pts):
                                k=0
                                while k*8 < length:
                                    start,stop = k*8,min(length,k*8+4)
                                    v1=(a[0]+(b[0]-a[0])*start/length,a[1]+(b[1]-a[1])*start/length)
                                    v2=(a[0]+(b[0]-a[0])*stop/length,a[1]+(b[1]-a[1])*stop/length)
                                    self.beam('markings',f'dash-{way.osm_id}-{k}',v1,v2,z+.045,.10,.012,(.95,.95,.95))
                                    k+=1
            if t.get('barrier') == 'kerb':
                h = clamp_float(t.get('height'),.15,.03,.5)
                self.polyline('kerbs',way,pts,h/2,.18,h,(.55,.55,.51),True)
            if t.get('barrier') in ('guard_rail','wall'):
                h = clamp_float(t.get('height'),1.0,.2,3.0)
                self.polyline('guardrails',way,pts,h/2,.12,h,(.52,.55,.58),True)
            if t.get('road_marking') == 'stop_line' or t.get('road_editor:stop_line') == 'yes':
                self.polyline('markings',way,pts,.045,.30,.012,(1.,1.,.95))
            if t.get('bridge:support') == 'pier' or t.get('man_made') == 'bridge_pier':
                x,y=pts[0]
                h = clamp_float(t.get('height'),self.opts.layer_height,1,30)
                self.add_shape('supports',f'explicit-pier-{way.osm_id}',x,y,h/2,1.3,1.3,h,0,(.64,.64,.62),True)
        if self.opts.include_crossings:
            for node_id,node in self.model.nodes.items():
                if node.tags.get('highway') != 'crossing':
                    continue
                mark = node.tags.get('crossing:markings') or node.tags.get('crossing','')
                if mark not in ('zebra','yes','marked','ladder'):
                    continue
                near = None
                q = self.proj.pt(node)
                for road,pts in road_segments:
                    for a,b,length in segment_lengths(pts):
                        tt=max(0,min(1,((q[0]-a[0])*(b[0]-a[0])+(q[1]-a[1])*(b[1]-a[1]))/(length*length)))
                        d=math.dist(q,(a[0]+(b[0]-a[0])*tt,a[1]+(b[1]-a[1])*tt))
                        if d < 9 and (near is None or d < near[0]):
                            near=(d,road,pts)
                if near:
                    self.crossing(node_id,node,near[1],near[2],9)
        if self.opts.include_signals:
            for node_id,node in self.model.nodes.items():
                if node.tags.get('highway') not in ('traffic_signals','stop','give_way'):
                    continue
                near=self.nearby_road(projected[node_id],road_segments,node.tags.get('road_editor:road'))
                if node.tags.get('road_editor:stop_line') != 'no' and near and self.opts.include_markings:
                    if node.tags.get('highway') in ('traffic_signals','stop') or node.tags.get('road_editor:stop_line') == 'yes':
                        self.traffic_stop_line(node_id,node,near,'signal')
                if node.tags.get('highway') != 'traffic_signals':
                    continue
                x,y=projected[node_id]
                yaw=0.0
                if near:
                    road,a,b,q,_=near
                    dx,dy=b[0]-a[0],b[1]-a[1]
                    length=math.hypot(dx,dy)
                    # On the correct roadside of the selected OSM direction.
                    direction=node.tags.get('traffic_signals:direction',node.tags.get('direction','forward'))
                    sign=1 if direction == 'backward' else -1
                    lanes=clamp_float(road.tags.get('lanes'),2,1,10)
                    offset=lanes*LANE_WIDTH/2+0.85
                    x,y=q[0]-dy/length*offset*sign,q[1]+dx/length*offset*sign
                    yaw=math.atan2(dy,dx)
                self.add_shape('signals',f'signal-pole-{node_id}',x,y,1.65,.13,.13,3.30,yaw,(.20,.23,.25),True)
                for index,color in enumerate(((.70,.09,.07),(.9,.68,.06),(.10,.64,.18))):
                    self.add_shape('signals',f'signal-lens-{node_id}-{index}',x,y,2.85-index*.33,.27,.17,.25,
                                   yaw,color)
            for node_id,node in self.model.nodes.items():
                if node.tags.get('bridge:support') == 'pier':
                    x,y=projected[node_id]
                    h=clamp_float(node.tags.get('height'),self.opts.layer_height,1,30)
                    self.add_shape('supports',f'bridge-node-pier-{node_id}',x,y,h/2,1.2,1.2,h,0,(.64,.64,.62),True)
        if self.total >= self.opts.max_objects:
            self.warnings.append(f'Лимит элементов Webots достигнут: {self.opts.max_objects}. Часть геометрии не экспортирована.')
        self.warnings.append('Светофоры — визуальные макеты без контроллера фаз.')
        self.warnings.append('Бортовые и мостовые высоты условные; проверьте коллизии и профиль дороги в Webots.')
        return f'{BEGIN}\n' + ''.join(self.parts) + f'{END}\n'


def merge_world(world: str, extras: str) -> str:
    if not world.lstrip().startswith('#VRML_SIM'):
        raise WebotsExportError('Базовая сцена должна быть .wbt, с заголовком #VRML_SIM.')
    # Repeated export replaces our block, not duplicates it.
    if BEGIN in world or END in world:
        if world.count(BEGIN) != 1 or world.count(END) != 1 or world.index(BEGIN) > world.index(END):
            raise WebotsExportError('Некорректные маркеры предыдущего Webots-экспорта.')
        world = world[:world.index(BEGIN)] + world[world.index(END)+len(END):]
    return world.rstrip() + '\n\n' + extras


def export_bundle(xml: str, base_world: str | None = None, options: ExportSettings | None = None) -> bytes:
    model = read_osm(xml)
    builder = Builder(model, options or ExportSettings(), Projection(model.bounds))
    extras = builder.generate()
    source = osm_with_bounds(xml, model.bounds)
    report = {'counts': builder.counts, 'bounds': model.bounds, 'projection': builder.proj.proj_string,
              'warnings': builder.warnings, 'source_filename': 'webots-source.osm',
              'world_filename': 'webots-ready.wbt' if base_world else None}
    readme = '''Road Editor — Webots 3D infrastructure\n\n1. Import webots-source.osm with the OFFICIAL Webots OSM importer.\n   IMPORTANT: use webots-source.osm, NOT a differently clipped file;\n   the UTM projection and bounds must match.\n2. Use backend/webots_extras.py to merge exported infrastructure with the\n   .wbt world from the official importer. Example in project root:\n   python -m backend.webots_extras --osm webots-source.osm --world map.wbt --output webots-ready.wbt\n3. Open webots-ready.wbt in Webots, check scale, collisions and traffic lights.\n   Do not append the extras twice; the CLI replaces previously added blocks.\n\nIf webots-ready.wbt is included it was already merged with the world supplied\nin the UI. The standalone file extras-to-merge.txt is NOT a complete world.\nThis is an approximate FLAT-TERRAIN supplement; it does not implement\nactual traffic signal cycles, realistic curb ramps, exact approach placement,\nor a physically engineered bridge. A 3D-terrain importer requires a separate\nheight alignment pass. Standard road lane paint from the official importer\nremains its responsibility; custom marking tags are overlaid by this exporter.\n'''
    mem = io.BytesIO()
    with zipfile.ZipFile(mem,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        z.writestr('webots-source.osm',source)
        z.writestr('extras-to-merge.txt',extras)
        z.writestr('report.json',json.dumps(report,ensure_ascii=False,indent=2))
        z.writestr('WEBOTS-README.txt',readme)
        if base_world is not None:
            z.writestr('webots-ready.wbt',merge_world(base_world,extras))
    return mem.getvalue()


def main() -> None:
    parser=argparse.ArgumentParser(description='Add Road Editor infrastructure to a Webots OSM world')
    parser.add_argument('--osm',required=True,type=Path)
    parser.add_argument('--world',required=True,type=Path,help='Official Webots OSM importer .wbt output')
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--layer-height',type=float,default=5.0)
    args=parser.parse_args()
    xml=args.osm.read_text(encoding='utf-8')
    world=args.world.read_text(encoding='utf-8')
    model=read_osm(xml)
    if not 0 < args.layer_height <= 30:
        parser.error('layer-height must be within 0..30 m')
    extra=Builder(model,ExportSettings(layer_height=args.layer_height),Projection(model.bounds)).generate()
    result=merge_world(world,extra)
    args.output.write_text(result,encoding='utf-8')
    print(f'Webots world saved: {args.output}')


if __name__ == '__main__':
    main()

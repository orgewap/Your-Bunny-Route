"""Conservative, local geometry overlap checks for imported OSM ways.

The preview never changes the workspace. Geometry is a suggestion, not a
reason to silently collapse different OSM IDs or snap nearby carriageways.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from math import ceil, cos, floor, hypot, pi
from xml.etree import ElementTree as ET

GRID_METRES = 80.0
DUPLICATE_METRES = 0.85  # tighter than typical physically separate carriageways
NEAR_METRES = 4.0
MAX_EXAMPLES = 12


@dataclass
class WayShape:
    ident: str
    points: list[tuple[float, float]]
    tags: dict[str, str]
    bounds: tuple[float, float, float, float]
    length: float


def _tags(element: ET.Element) -> dict[str, str]:
    return {x.get('k', ''): x.get('v', '') for x in element.findall('tag')}


def _shapes(root: ET.Element, latitude: float) -> dict[str, WayShape]:
    metres_x = 111_320 * max(0.01, cos(latitude * pi / 180))
    nodes: dict[str, tuple[float, float]] = {}
    for node in root.findall('node'):
        try:
            nodes[node.get('id', '')] = float(node.get('lon', '')) * metres_x, float(node.get('lat', '')) * 111_320
        except ValueError:
            continue
    shapes = {}
    for way in root.findall('way'):
        tags = _tags(way)
        if not tags.get('highway'):  # non-traffic areas are not candidates
            continue
        coords = []
        for child in way.findall('nd'):
            point = nodes.get(child.get('ref', ''))
            if point is None:
                coords = []
                break
            if not coords or hypot(point[0] - coords[-1][0], point[1] - coords[-1][1]) > 0.05:
                coords.append(point)
        if len(coords) < 2:
            continue
        length = sum(hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(coords, coords[1:]))
        if length < 2:
            continue
        x = [p[0] for p in coords]
        y = [p[1] for p in coords]
        shapes[way.get('id', '')] = WayShape(
            way.get('id', ''), coords, tags, (min(x), min(y), max(x), max(y)), length,
        )
    return shapes


def _grid_cells(shape: WayShape) -> set[tuple[int, int]]:
    """Index the way *segments*, not the entire possibly massive bbox."""
    cells = set()
    for a, b in zip(shape.points, shape.points[1:]):
        span = hypot(b[0] - a[0], b[1] - a[1])
        steps = max(1, ceil(span / (GRID_METRES * 0.6)))
        # A huge road isn't allowed to allocate a giant spatial index.
        steps = min(steps, 400)
        for j in range(steps + 1):
            t = j / steps
            x, y = a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])
            cx, cy = floor(x / GRID_METRES), floor(y / GRID_METRES)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    cells.add((cx + dx, cy + dy))
    return cells


def _samples(shape: WayShape) -> list[tuple[float, float]]:
    count = min(60, max(3, ceil(shape.length / 12)))
    targets = [shape.length * n / count for n in range(count + 1)]
    result = []
    i = 0
    walked = 0.0
    for a, b in zip(shape.points, shape.points[1:]):
        length = hypot(b[0] - a[0], b[1] - a[1])
        while i < len(targets) and targets[i] <= walked + length + 0.00001:
            ratio = max(0.0, min(1.0, (targets[i] - walked) / length)) if length else 0.0
            result.append((a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio))
            i += 1
        walked += length
    return result


def _point_segment_distance(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    denominator = dx * dx + dy * dy
    if denominator < 0.00001:
        return hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denominator))
    return hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _near_ratio(a: WayShape, b: WayShape, tolerance: float) -> tuple[float, float]:
    # Pure shape comparison: shared endpoints and crossing alone are not enough.
    count = 0
    accumulated = 0.0
    samples = _samples(a)
    for point in samples:
        dist = min(_point_segment_distance(point, p, q) for p, q in zip(b.points, b.points[1:]))
        count += dist <= tolerance
        accumulated += dist
    return count / len(samples), accumulated / len(samples)


def _compatible(a: WayShape, b: WayShape) -> bool:
    # Roads at different levels, opposing one-way carriageways or different
    # highway classes must not be silently collapsed as geometric duplicates.
    for field in ('highway', 'layer', 'bridge', 'tunnel', 'oneway', 'lanes', 'lanes:forward',
                  'lanes:backward', 'turn:lanes', 'turn:lanes:forward', 'turn:lanes:backward'):
        if a.tags.get(field, '') != b.tags.get(field, ''):
            return False
    for field in ('name', 'ref'):
        if a.tags.get(field) and b.tags.get(field) and a.tags[field] != b.tags[field]:
            return False
    return True


def _endpoints_match(a: WayShape, b: WayShape) -> bool:
    p, q, r, s = a.points[0], a.points[-1], b.points[0], b.points[-1]
    return (hypot(p[0] - r[0], p[1] - r[1]) <= DUPLICATE_METRES and
            hypot(q[0] - s[0], q[1] - s[1]) <= DUPLICATE_METRES) or (
            hypot(p[0] - s[0], p[1] - s[1]) <= DUPLICATE_METRES and
            hypot(q[0] - r[0], q[1] - r[1]) <= DUPLICATE_METRES)


def _compare(a: WayShape, b: WayShape) -> tuple[str | None, float]:
    # Same XY but different OSM elevation is not a duplicate: a bridge can
    # legitimately run directly above a surface road.
    if any(a.tags.get(tag, '') != b.tags.get(tag, '') for tag in ('bridge', 'tunnel', 'layer')):
        return None, 0
    # Bounding-box prefilter. A nearby crossing does not by itself qualify.
    ax0, ay0, ax1, ay1 = a.bounds
    bx0, by0, bx1, by1 = b.bounds
    if ax0 - NEAR_METRES > bx1 or bx0 - NEAR_METRES > ax1 or ay0 - NEAR_METRES > by1 or by0 - NEAR_METRES > ay1:
        return None, 0
    # Prevent an ordinary perpendicular crossing from becoming a partial match.
    av = (a.points[-1][0] - a.points[0][0], a.points[-1][1] - a.points[0][1])
    bv = (b.points[-1][0] - b.points[0][0], b.points[-1][1] - b.points[0][1])
    len_a, len_b = hypot(*av), hypot(*bv)
    if len_a > 5 and len_b > 5 and abs(av[0] * bv[0] + av[1] * bv[1]) / (len_a * len_b) < 0.75:
        return None, 0
    ar, ad = _near_ratio(a, b, DUPLICATE_METRES)
    br, bd = _near_ratio(b, a, DUPLICATE_METRES)
    if (ar >= 0.97 and br >= 0.97 and _endpoints_match(a, b) and
            abs(a.length - b.length) / max(a.length, b.length) < 0.03):
        # Two coincident but OPPOSITE one-way carriageways are not duplicates.
        # Never remove either via the 'keep existing' deduplication policy.
        direct = lambda v: -1 if v == '-1' else 1
        one_a, one_b = a.tags.get('oneway', ''), b.tags.get('oneway', '')
        if one_a != one_b and (one_a in ('yes', '1', '-1', 'true') or one_b in ('yes', '1', '-1', 'true')):
            return 'direction_conflict', round(max(ad, bd), 2)
        if one_a in ('yes', '1', '-1', 'true') and one_b in ('yes', '1', '-1', 'true'):
            av = (a.points[-1][0] - a.points[0][0], a.points[-1][1] - a.points[0][1])
            bv = (b.points[-1][0] - b.points[0][0], b.points[-1][1] - b.points[0][1])
            if (av[0] * bv[0] + av[1] * bv[1]) * direct(one_a) * direct(one_b) < 0:
                return 'direction_conflict', round(max(ad, bd), 2)
        return ('duplicate' if _compatible(a, b) else 'attribute_conflict'), round(max(ad, bd), 2)
    if max(ar, br) >= 0.40 and min(a.length, b.length) >= 10:
        return 'partial', round(min(ad, bd), 2)
    ar_near, ad_near = _near_ratio(a, b, NEAR_METRES)
    br_near, bd_near = _near_ratio(b, a, NEAR_METRES)
    if min(ar_near, br_near) >= 0.75 and min(a.length, b.length) >= 10:
        return 'nearby', round(max(ad_near, bd_near), 2)
    return None, 0


def analyze_overlap(base: ET.Element, incoming: ET.Element) -> dict:
    """Serializable preview. `duplicate_matches` drives opt-in deduplication."""
    node = next(iter(base.findall('node')), None)
    if node is None:
        node = next(iter(incoming.findall('node')), None)
    latitude = float(node.get('lat', '0')) if node is not None else 0
    existing = _shapes(base, latitude)
    additions = _shapes(incoming, latitude)
    index: dict[tuple[int, int], set[str]] = defaultdict(set)
    for ident, shape in existing.items():
        for cell in _grid_cells(shape):
            index[cell].add(ident)
    counts = {'duplicate': 0, 'attribute_conflict': 0, 'direction_conflict': 0, 'partial': 0,
              'nearby': 0, 'id_conflict': 0, 'node_id_conflict': 0}
    examples: list[dict] = []
    duplicate_matches: dict[str, str] = {}

    # Positive IDs represent the same global OSM object. Never remap them by
    # spatial similarity; detect changes and let the workspace remain canonical.
    base_nodes = {x.get('id'): x for x in base.findall('node') if x.get('id', '').isdigit()}
    for node in incoming.findall('node'):
        ident = node.get('id')
        other = base_nodes.get(ident)
        if other is None:
            continue
        try:
            dx = (float(node.get('lon', '0')) - float(other.get('lon', '0'))) * 111320 * cos(latitude * pi / 180)
            dy = (float(node.get('lat', '0')) - float(other.get('lat', '0'))) * 111320
        except ValueError:
            continue
        if hypot(dx, dy) > DUPLICATE_METRES:
            counts['node_id_conflict'] += 1
            if len(examples) < MAX_EXAMPLES:
                examples.append({'type': 'node_id_conflict', 'incoming_id': ident, 'existing_id': ident,
                                 'distance_m': round(hypot(dx, dy), 1), 'name': ''})

    for ident, shape in additions.items():
        if ident in existing and ident.lstrip('-').isdigit() and int(ident) > 0:
            old = existing[ident]
            # Tags, node refs and geometry may differ between OSM extracts.
            if old.tags != shape.tags or not _endpoints_match(old, shape) or abs(old.length - shape.length) > 1:
                counts['id_conflict'] += 1
                if len(examples) < MAX_EXAMPLES:
                    examples.append({'type': 'id_conflict', 'incoming_id': ident, 'existing_id': ident,
                                     'distance_m': 0, 'name': shape.tags.get('name', '')})
            continue
        candidates = set()
        for cell in _grid_cells(shape):
            candidates.update(index.get(cell, ()))
        best: tuple[int, float, str, str] | None = None
        priority = {'duplicate': 0, 'attribute_conflict': 1, 'direction_conflict': 2, 'partial': 3, 'nearby': 4}
        for other_id in candidates:
            other = existing[other_id]
            classification, distance = _compare(shape, other)
            if classification:
                candidate = (priority[classification], distance, other_id, classification)
                if best is None or candidate < best:
                    best = candidate
        if best is None:
            continue
        _, distance, other_id, kind = best
        counts[kind] += 1
        if kind in ('duplicate', 'attribute_conflict'):
            duplicate_matches[ident] = other_id
        if len(examples) < MAX_EXAMPLES:
            examples.append({'type': kind, 'incoming_id': ident, 'existing_id': other_id,
                             'distance_m': distance, 'name': shape.tags.get('name', '')})
    # Conflicts with different IDs and same geometry are candidates for safe
    # reuse; partial/nearby geometry is NEVER silently merged or overwritten.
    review_needed = any(counts.values())
    return {'counts': counts, 'examples': examples, 'duplicate_matches': duplicate_matches,
            'review_needed': review_needed, 'incoming_roads': len(additions),
            'existing_roads': len(existing)}

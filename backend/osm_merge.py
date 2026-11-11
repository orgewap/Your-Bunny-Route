"""Safe OSM XML 0.6 merge and per-source removal.

This module deliberately does not infer road intersections or rewrite the lane
network. OSM IDs and existing edits are authoritative; duplicates are shared.
"""
from __future__ import annotations

from copy import deepcopy
from xml.etree import ElementTree as ET

from .osm_overlap import analyze_overlap

TYPES = ('node', 'way', 'relation')
EMPTY_OSM = '<osm version="0.6" generator="Road Network Editor"></osm>'
MAX_XML_BYTES = 40 * 1024 * 1024


class OsmError(ValueError):
    pass


class OsmOverlapReviewRequired(OsmError):
    pass


def parse_osm(xml: str) -> ET.Element:
    if not isinstance(xml, str) or not xml.strip():
        raise OsmError('Пустой OSM-файл.')
    if len(xml.encode('utf-8')) > MAX_XML_BYTES:
        raise OsmError('OSM-файл превышает ограничение 40 МБ.')
    if '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper():
        raise OsmError('DTD и XML-сущности не поддерживаются.')
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise OsmError(f'Некорректный XML: {exc}') from exc
    if root.tag != 'osm' or root.attrib.get('version', '0.6') != '0.6':
        raise OsmError('Ожидается OSM XML версии 0.6.')
    for element in root:
        if element.tag in TYPES and not element.get('id'):
            raise OsmError(f'OSM {element.tag} без ID.')
    return root


def xml_text(root: ET.Element) -> str:
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding='unicode')


def _objects(root: ET.Element) -> dict[str, dict[str, ET.Element]]:
    items: dict[str, dict[str, ET.Element]] = {kind: {} for kind in TYPES}
    for item in root:
        if item.tag not in items:
            continue
        ident = item.get('id', '')
        if ident in items[item.tag]:
            raise OsmError(f'Повторный {item.tag} ID {ident} внутри одного файла.')
        items[item.tag][ident] = item
    return items


def _sort_root(root: ET.Element) -> None:
    ordering = {'node': 1, 'way': 2, 'relation': 3}
    root[:] = sorted(root, key=lambda item: ordering.get(item.tag, 0))


def merge_xml(base_xml: str, added_xml: str, policy: str | None = None) -> tuple[str, dict[str, list[str]]]:
    """Merge after an explicit overlap choice; preserve all references and ownership.

    `keep_existing`: reuse existing IDs for geometrically identical roads.
    `keep_both`: preserve different ways, remapping colliding IDs when needed.
    `new_tags`: reuse existing geometry/ID but apply incoming way tags.
    Partial/nearby overlap is always preserved as two ways.
    """
    if policy not in (None, 'keep_existing', 'keep_both', 'new_tags'):
        raise OsmError('Неизвестный способ обработки наложений.')
    base = parse_osm(base_xml)
    incoming = parse_osm(added_xml)
    existing = _objects(base)
    additions = _objects(incoming)
    analysis = analyze_overlap(base, incoming)
    if analysis['review_needed'] and policy is None:
        raise OsmOverlapReviewRequired('Перед добавлением OSM подтвердите обработку наложений.')
    dup = analysis['duplicate_matches'] if policy in ('keep_existing', 'new_tags') else {}
    # Examples are intentionally capped for the UI; check all positive nodes
    # so no dangerous shared-node collision can slip through after item #12.
    from math import cos, hypot, pi
    node_conflict_ids: set[str] = set()
    existing_nodes = existing['node']
    for ident, node in additions['node'].items():
        other = existing_nodes.get(ident)
        if other is None or not ident.isdigit():
            continue
        try:
            lat0 = float(other.get('lat', '0'))
            dist = hypot((float(node.get('lon', '0')) - float(other.get('lon', '0'))) * 111_320 * cos(lat0 * pi / 180),
                         (float(node.get('lat', '0')) - lat0) * 111_320)
        except ValueError:
            continue
        if dist > 0.85:
            node_conflict_ids.add(ident)
    # Two different highways with the *same* positive OSM way ID but different
    # geometry cannot coexist with that ID; only keep_both forks the incoming way.
    fork_way_ids = set()
    if policy == 'keep_both':
        for ident, new in additions['way'].items():
            old = existing['way'].get(ident)
            if old is not None and ident.isdigit():
                refs_old = [x.get('ref') for x in old.findall('nd')]
                refs_new = [x.get('ref') for x in new.findall('nd')]
                if refs_old != refs_new or any(ref in node_conflict_ids for ref in refs_new):
                    fork_way_ids.add(ident)
    next_negative = {
        kind: min([0] + [int(i) for i in existing[kind] if i.lstrip('-').isdigit() and int(i) < 0]) - 1
        for kind in TYPES
    }
    # Reserve IDs used by the new extract too. Otherwise a remapped -1 could
    # accidentally take an incoming -2, creating two nodes with the same ID.
    reserved = {kind: set(existing[kind]) | set(additions[kind]) for kind in TYPES}
    remap: dict[str, dict[str, str]] = {kind: {} for kind in TYPES}
    owned: dict[str, list[str]] = {kind: [] for kind in TYPES}
    for kind in TYPES:
        for original in additions[kind]:
            ident = original
            if ident in existing[kind] and (
                original.startswith('-') or
                (kind == 'node' and original in node_conflict_ids) or
                (kind == 'way' and original in fork_way_ids)
            ):
                ident = str(next_negative[kind])
                while ident in reserved[kind] or ident in remap[kind].values():
                    next_negative[kind] -= 1
                    ident = str(next_negative[kind])
                next_negative[kind] -= 1
            if kind == 'way' and original in dup:
                ident = dup[original]
            remap[kind][original] = ident
            owned[kind].append(ident)

    # A source which reuses a pre-existing OSM way also owns its canonical
    # geometry nodes. This keeps sequential source removal symmetric: when A
    # is deleted before B, then B is deleted, the old way AND its nodes can go.
    claimed_nodes = set(owned['node'])
    for original in additions['way']:
        canonical = existing['way'].get(remap['way'][original])
        if canonical is None:
            continue
        for nd in canonical.findall('nd'):
            ref = nd.get('ref', '')
            if ref in existing['node'] and ref not in claimed_nodes:
                owned['node'].append(ref)
                claimed_nodes.add(ref)

    # Object references must be remapped along with their owner IDs.
    for kind in TYPES:
        for original, element in additions[kind].items():
            ident = remap[kind][original]
            if ident in existing[kind]:
                if kind == 'way' and policy == 'new_tags':
                    # Apply attributes only; do NOT rewrite shared node coordinates,
                    # node refs, relation membership or the target OSM identifier.
                    target = existing['way'][ident]
                    for tag in list(target.findall('tag')):
                        target.remove(tag)
                    for tag in element.findall('tag'):
                        target.append(deepcopy(tag))
                continue  # existing object is canonical unless explicitly forked
            clone = deepcopy(element)
            clone.set('id', ident)
            if kind == 'way':
                for nd in clone.findall('nd'):
                    if nd.get('ref') in remap['node']:
                        nd.set('ref', remap['node'][nd.get('ref', '')])
            elif kind == 'relation':
                for member in clone.findall('member'):
                    mtype = member.get('type', '')
                    if mtype in remap and member.get('ref') in remap[mtype]:
                        member.set('ref', remap[mtype][member.get('ref', '')])
            base.append(clone)
    # Preserve nonroad map objects, notes and metadata. Bounds of additional
    # extracts are not combined: the actual geometry determines map bounds.
    for item in incoming:
        if item.tag not in TYPES and item.tag != 'bounds':
            base.append(deepcopy(item))
    _sort_root(base)
    return xml_text(base), owned


def remove_source_xml(
    xml: str,
    doomed: dict[str, list[str]],
    remaining: list[dict[str, list[str]]],
    *,
    report: dict[str, int] | None = None,
) -> str:
    """Remove an import without breaking dependencies from surviving sources.

    OSM relations can reference ways owned only by the removed source (common
    with bus/tram routes across overlapping extracts). Keep the minimal ways,
    nodes and nested relations needed by those surviving relationships instead
    of deleting broken references or rejecting the whole operation.

    New editor-created ways (not in any source ownership list) are kept.
    The optional report gives the UI an honest accounting of retained objects.
    """
    root = parse_osm(xml)
    objects = _objects(root)
    others = {
        kind: set().union(*(set(refs.get(kind, [])) for refs in remaining))
        for kind in TYPES
    }
    exclusive = {
        kind: set(doomed.get(kind, [])) - others[kind]
        for kind in TYPES
    }

    # A retained relation may reference a source-exclusive relation, which in
    # turn references source-exclusive ways. Calculate the transitive closure.
    kept_relation_ids = set(objects['relation']) - exclusive['relation']
    changed = True
    while changed:
        changed = False
        for rel_id in tuple(kept_relation_ids):
            relation = objects['relation'].get(rel_id)
            if relation is None:
                continue
            for member in relation.findall('member'):
                if member.get('type') != 'relation':
                    continue
                referenced = member.get('ref', '')
                if referenced in objects['relation'] and referenced not in kept_relation_ids:
                    kept_relation_ids.add(referenced)
                    changed = True

    # Keep original ways needed by retained relations. These ways will become
    # unowned workspace objects after the source metadata is removed.
    referenced_ways: set[str] = set()
    referenced_nodes: set[str] = set()
    for rel_id in kept_relation_ids:
        relation = objects['relation'][rel_id]
        for member in relation.findall('member'):
            ref = member.get('ref', '')
            if member.get('type') == 'way':
                referenced_ways.add(ref)
            elif member.get('type') == 'node':
                referenced_nodes.add(ref)
    kept_way_ids = (set(objects['way']) - exclusive['way']) | referenced_ways
    # Preserve graph nodes for every surviving way, including new handmade
    # roads and canonical ways shared with another uploaded OSM.
    for way_id in kept_way_ids:
        way = objects['way'].get(way_id)
        if way is not None:
            referenced_nodes.update(nd.get('ref', '') for nd in way.findall('nd'))

    for element in list(root):
        ident = element.get('id', '')
        if element.tag == 'way' and ident in exclusive['way'] and ident not in kept_way_ids:
            root.remove(element)
        elif (element.tag == 'relation' and ident in exclusive['relation']
              and ident not in kept_relation_ids):
            root.remove(element)
        elif (element.tag == 'node' and ident in exclusive['node']
              and ident not in referenced_nodes):
            root.remove(element)

    if report is not None:
        report.update({
            'removed_nodes': len(exclusive['node'] & set(objects['node']) - referenced_nodes),
            'removed_ways': len(exclusive['way'] & set(objects['way']) - kept_way_ids),
            'removed_relations': len(exclusive['relation'] & set(objects['relation']) - kept_relation_ids),
            'retained_nodes': len(exclusive['node'] & set(objects['node']) & referenced_nodes),
            'retained_ways': len(exclusive['way'] & set(objects['way']) & kept_way_ids),
            'retained_relations': len(exclusive['relation'] & set(objects['relation']) & kept_relation_ids),
        })
    _sort_root(root)
    return xml_text(root)

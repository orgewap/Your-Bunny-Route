# API contract — proposed for Egor, Trofim, and Sasha

This document is an **integration proposal**, not an existing backend. Align and freeze the contract before implementing CRUD concurrently.

## Model

```json
{
  "id": "way-1023",
  "osmId": "1023",
  "name": "Ленина",
  "highway": "residential",
  "lanes": 2,
  "oneway": false,
  "bridge": false,
  "level": 0,
  "vertices": [
    { "id": "osm-node-10", "lng": 104.286, "lat": 52.284 },
    { "id": "osm-node-11", "lng": 104.288, "lat": 52.284 }
  ],
  "tags": { "highway": "residential", "name": "Ленина" }
}
```

**Important invariants**

- IDs remain strings (OSM may use large signed integers; new IDs are negative).
- Coordinate order in the frontend is `[longitude, latitude]`, WGS84.
- The server converts to projected **metric coordinates** before computing intersections and snapping.
- Shared vertex IDs represent real topological connections. A geometric intersection alone **does not** create a shared vertex.
- A crossing with differing levels cannot create an implicit road-graph node.
- Additional OSM `tag` values, non-road `way` objects, `relation` objects, and unmapped nodes must survive round-trip export.
- The server is the single authority for the road graph, relationship cleanup, validation, and import/export.

## Suggested endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/projects/import` | Multipart `.osm`, creates current project |
| `GET` | `/api/projects/current` | Current project + road graph |
| `POST` | `/api/roads` | Create road |
| `PATCH` | `/api/roads/{id}` | Update geometry/attributes |
| `DELETE` | `/api/roads/{id}` | Delete with referential integrity handling |
| `POST` | `/api/geometry/preview` | Preview snap/junction/bridge; **no mutation** |
| `POST` | `/api/geometry/commit` | Atomically accept preview after user confirmation |
| `GET` | `/api/projects/export` | `edited.osm` |
| `POST` | `/api/validation` | Delegate independent validation service |
| `GET` | `/api/validation/{jobId}` | Validation status by MATSim/SUMO/Webots |

Return JSON for successful metadata/road calls; return structured JSON errors with a stable code, message, and object IDs.

`POST /api/geometry/preview` should return explicit candidate crossings and possible actions (`junction`, `overpass`, later `underpass`), associated segment IDs, insertion points, and reasons why an option may be unavailable. Do not silently merge intersecting roads. A separate commit call is crucial for the confirmation workflow in the technical requirements.

## Parallel ownership proposal

- **Sasha** — frontend shell, MapLibre, 2D/3D camera, road overlay and edit handles; connects API to frontend.
- **Egor** — road CRUD endpoints, entity schemas, import/export OSM fidelity.
- **Trofim** — geometry/topology, snapping, crossing preview/commit, road levels.
- **All three** — joint integration tests for create/update/delete, undo policy, sharing vertices, export/import round-trips.

The split above is suggested only. Update it together with teammates.

/** Persisted OSM workspaces. The editor itself stays client-side. */
export interface ProjectSource {
  id: string
  filename: string
  created_at: string
}
export type OsmOverlapPolicy = 'keep_existing' | 'keep_both' | 'new_tags'
export type OverlapKind = 'duplicate' | 'attribute_conflict' | 'direction_conflict' | 'partial' | 'nearby' | 'id_conflict' | 'node_id_conflict'
export interface SourceOverlapPreview {
  revision: number
  review_needed: boolean
  incoming_roads: number
  existing_roads: number
  counts: Record<OverlapKind, number>
  examples: Array<{ type: OverlapKind; incoming_id: string; existing_id: string; distance_m: number; name: string }>
}
export interface ExistingSourceOverlapAudit {
  sources: number
  revision: number
  pairs: Array<{ left: string; right: string;
    counts: SourceOverlapPreview['counts']; examples: SourceOverlapPreview['examples'];
    shared_ids?: { node: number; way: number; relation: number } }>
}
export interface SourceRemovalSummary {
  removed_nodes: number
  removed_ways: number
  removed_relations: number
  retained_nodes: number
  retained_ways: number
  retained_relations: number
}
export interface SavedProject {
  removal?: SourceRemovalSummary
  id: string
  name: string
  revision: number
  created_at: string
  updated_at: string
  source_count: number
  sources: ProjectSource[]
  role: 'owner' | 'editor' | 'viewer'
}

export interface SignedInUser { id: string; username: string; role: 'admin' | 'editor' }
export interface ProjectMember { id: string; username: string; role: 'owner' | 'editor' | 'viewer' }
export type ProjectLiveEvent =
  | { type: 'workspace_updated'; revision: number; actor: string | null }
  | { type: 'members_updated'; revision: number; actor: string | null }
  | { type: 'presence'; count: number }
  | { type: 'pong' }
  | { type: 'project_deleted' }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      credentials: 'same-origin',
    })
  } catch {
    throw new Error('Backend недоступен. Запустите сервер FastAPI на порту 8000.')
  }
  if (!response.ok) {
    let error = `HTTP ${response.status}`
    try {
      const body = await response.json() as { detail?: string }
      if (typeof body.detail === 'string') error = body.detail
    } catch { /* Unstructured error from proxy. */ }
    throw new Error(error)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}
const json = (value: unknown) => JSON.stringify(value)

export const projectsApi = {
  list: () => request<SavedProject[]>('/projects'),
  get: (id: string) => request<SavedProject>(`/projects/${encodeURIComponent(id)}`),
  create: (name: string) => request<SavedProject>('/projects', {
    method: 'POST', body: json({ name }),
  }),
  remove: (id: string) => request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workspace: (id: string) => request<{ xml: string; revision: number }>(`/projects/${encodeURIComponent(id)}/workspace`),
  save: (id: string, xml: string, expected_revision: number) => request<{ revision: number; merged: boolean }>(
    `/projects/${encodeURIComponent(id)}/workspace`,
    { method: 'PUT', body: json({ xml, expected_revision }) },
  ),
  auditOverlaps: (id: string) => request<ExistingSourceOverlapAudit>(
    `/projects/${encodeURIComponent(id)}/overlaps`,
  ),
  previewSource: (id: string, filename: string, xml: string) => request<SourceOverlapPreview>(
    `/projects/${encodeURIComponent(id)}/sources/preview`, { method: 'POST', body: json({ filename, xml }) },
  ),
  addSource: (id: string, filename: string, xml: string,
    policy?: OsmOverlapPolicy, expected_revision?: number) => request<SavedProject>(
    `/projects/${encodeURIComponent(id)}/sources`,
    { method: 'POST', body: json({ filename, xml, policy: policy ?? null, expected_revision: expected_revision ?? null }) },
  ),
  removeSource: (id: string, source: string) => request<SavedProject>(
    `/projects/${encodeURIComponent(id)}/sources/${encodeURIComponent(source)}`, { method: 'DELETE' },
  ),
  members: (id: string) => request<ProjectMember[]>(`/projects/${encodeURIComponent(id)}/members`),
  invite: (id: string, username: string, role: 'editor' | 'viewer') => request<ProjectMember>(
    `/projects/${encodeURIComponent(id)}/members`, { method: 'POST', body: json({ username, role }) }),
  kick: (id: string, userId: string) => request<void>(
    `/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
}


export const authApi = {
  me: () => request<SignedInUser>('/auth/me'),
  login: (username: string, password: string) => request<SignedInUser>('/auth/login', {
    method: 'POST', body: json({ username, password }),
  }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  createUser: (username: string, password: string) => request<SignedInUser>('/auth/users', {
    method: 'POST', body: json({ username, password }),
  }),
}

export function connectProjectLive(projectId: string): WebSocket {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${scheme}//${window.location.host}/api/projects/${encodeURIComponent(projectId)}/live`)
}

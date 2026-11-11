<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Activity, ArrowDownToLine, CheckCheck, FolderOpen, Undo2, Redo2, Network, Save, FolderKanban, Plus, Trash2, X } from 'lucide-vue-next'
import MapEditor from './components/MapEditor.vue'
import PropertyPanel from './components/PropertyPanel.vue'
import AnalysisPanel from './components/AnalysisPanel.vue'
import ToolRail from './components/ToolRail.vue'
import { useEditorStore } from './stores/editor'
import { projectsApi, authApi, connectProjectLive } from './lib/projectsApi'
import { downloadOsm } from './lib/osm'
import type { SimulatorExportReport } from './lib/simulatorExport'
import type { SavedProject, ProjectSource, SourceOverlapPreview, OsmOverlapPolicy, ExistingSourceOverlapAudit, SignedInUser, ProjectMember, ProjectLiveEvent } from './lib/projectsApi'

const store = useEditorStore()
const analysisOpen = ref(false)
const simulatorExport = ref<{ xml: string; filename: string; report: SimulatorExportReport; downloaded: boolean } | null>(null)
const mapEditorRef = ref<{ focusRoad: (roadId: string) => void } | null>(null)

function focusAnalysisRoad(roadId: string): void {
  mapEditorRef.value?.focusRoad(roadId)
}
function toggleAnalysis(): void {
  analysisOpen.value = !analysisOpen.value
  if (analysisOpen.value) {
    store.setTool('select')
    if (store.roadAnalysis && !store.roadAnalysisStale) store.roadAnalysisVisible = true
  } else store.roadAnalysisVisible = false
}
function closeAnalysis(): void {
  analysisOpen.value = false
  store.roadAnalysisVisible = false
}
function simulatorFilename(projectName: string): string {
  const base = projectName.trim().replace(/\.osm$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80)
  return `${base || 'simulation-network'}.osm`
}
function prepareSimulatorExport(): void {
  try {
    const prepared = store.prepareSimulationExport()
    simulatorExport.value = {
      ...prepared,
      filename: simulatorFilename(store.projectName),
      downloaded: false,
    }
  } catch (error) {
    showError(error)
  }
}
function downloadSimulationOsm(): void {
  const prepared = simulatorExport.value
  if (!prepared?.report.ok) return
  downloadOsm(prepared.xml, prepared.filename)
  prepared.downloaded = true
  store.notify(`Файл ${prepared.filename} подготовлен для MATSim и SUMO; Webots получает сценарий после SUMO.`)
}
const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const addSourceInput = ref<HTMLInputElement | null>(null)
const projectsOpen = ref(false)
const projects = ref<SavedProject[]>([])
const activeProject = ref<SavedProject | null>(null)
const newProjectName = ref('Новый проект')
const projectsBusy = ref(false)
const signedIn = ref<SignedInUser | null>(null)
const showLogin = ref(false)
const loginName = ref('')
const loginPassword = ref('')
const authError = ref('')
const authBusy = ref(false)
const members = ref<ProjectMember[]>([])
const inviteName = ref('')
const inviteRole = ref<'editor' | 'viewer'>('editor')
const teammateName = ref('')
const teammatePassword = ref('')
const presenceCount = ref(0)
const liveStatus = ref<'offline' | 'connecting' | 'online'>('offline')
const remotePending = ref(false)
let socket: WebSocket | null = null
let socketGeneration = 0
let reconnectTimer: number | null = null
let refreshInFlight = false

function closeLive(): void {
  socketGeneration++
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (socket) { socket.close(); socket = null }
  liveStatus.value = 'offline'
  presenceCount.value = 0
}

function connectLive(projectId: string): void {
  closeLive()
  if (!signedIn.value) return
  const generation = socketGeneration
  liveStatus.value = 'connecting'
  const connection = connectProjectLive(projectId)
  socket = connection
  connection.onopen = () => { if (generation === socketGeneration) liveStatus.value = 'online' }
  connection.onmessage = event => {
    if (generation !== socketGeneration || activeProject.value?.id !== projectId) return
    let message: ProjectLiveEvent
    try { message = JSON.parse(event.data) as ProjectLiveEvent } catch { return }
    if (message.type === 'presence') { presenceCount.value = message.count; return }
    if (message.type === 'members_updated') {
      void projectsApi.members(projectId).then(result => { members.value = result }).catch(showError)
      return
    }
    if (message.type === 'project_deleted') {
      closeLive()
      activeProject.value = null
      store.importFile('<osm version="0.6"></osm>', 'Новый проект')
    store.readOnly = false
      store.notify('Проект удалён на сервере.')
      return
    }
    if (message.type !== 'workspace_updated' || message.actor === signedIn.value?.id) return
    if (!activeProject.value || message.revision <= activeProject.value.revision) return
    remotePending.value = true
    if (!store.dirty && store.tool === 'select' && !saveInFlight) void refreshRemote()
    else store.notify('У коллеги новые изменения. Они будут объединены при сохранении.')
  }
  connection.onclose = (event) => {
    if (generation !== socketGeneration || activeProject.value?.id !== projectId) return
    liveStatus.value = 'offline'
    presenceCount.value = 0
    if (event.code === 1008) { store.notify('Нет доступа к проекту или сессия истекла. Войдите повторно.'); return }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (activeProject.value?.id === projectId) connectLive(projectId)
    }, 3000)
  }
}

async function refreshRemote(): Promise<void> {
  if (refreshInFlight || !activeProject.value || store.dirty || store.tool !== 'select') return
  const projectId = activeProject.value.id
  refreshInFlight = true
  try {
    const [metadata, document] = await Promise.all([projectsApi.get(projectId), projectsApi.workspace(projectId)])
    if (activeProject.value?.id !== projectId || store.dirty) return
    if (document.revision >= activeProject.value.revision) {
      const selectedOsmId = store.selectedRoad?.osmId
      store.importFile(document.xml, metadata.name)
      store.readOnly = metadata.role === 'viewer'
      store.projectName = metadata.name
      activeProject.value = { ...metadata, revision: document.revision }
      if (selectedOsmId) {
        const same = store.roads.find(road => road.osmId === selectedOsmId)
        if (same) store.selectRoad(same.id)
      }
      remotePending.value = false
      saveConflict.value = false
      store.notify('Изменения других участников загружены.')
    }
  } catch (error) { showError(error) }
  finally { refreshInFlight = false }
}

async function signIn(): Promise<void> {
  authBusy.value = true
  authError.value = ''
  try {
    signedIn.value = await authApi.login(loginName.value, loginPassword.value)
    loginPassword.value = ''
    showLogin.value = false
    await refreshProjects()
  } catch (error) { authError.value = error instanceof Error ? error.message : 'Ошибка входа.' }
  finally { authBusy.value = false }
}
async function signOut(): Promise<void> {
  try {
    await saveProject()
    await authApi.logout()
    closeLive()
    activeProject.value = null
    members.value = []
    projects.value = []
    signedIn.value = null
    projectsOpen.value = false
    store.importFile('<osm version="0.6"></osm>', 'Новый проект')
    store.readOnly = false
  } catch (error) { showError(error) }
}
/** Conflict recovery must not touch store.dirty, unlike Export OSM. */
function downloadMyChanges(): void {
  const xml = store.workspaceXml()
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'my-conflicting-edits.osm'
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
async function discardLocalEdits(): Promise<void> {
  if (!activeProject.value) return
  if (!window.confirm('Несохранённые изменения в этой вкладке будут заменены версией сервера. Рекомендуется сначала скачать копию. Продолжить?')) return
  store.dirty = false
  await refreshRemote()
}
async function createTeammate(): Promise<void> {
  try {
    await authApi.createUser(teammateName.value, teammatePassword.value)
    teammateName.value = ''; teammatePassword.value = ''
    store.notify('Учётная запись создана. Добавьте участника в проект.')
  } catch (error) { showError(error) }
}
async function addTeammateToProject(): Promise<void> {
  if (!activeProject.value) return
  try {
    await projectsApi.invite(activeProject.value.id, inviteName.value, inviteRole.value)
    members.value = await projectsApi.members(activeProject.value.id)
    inviteName.value = ''
  } catch (error) { showError(error) }
}
async function removeTeammate(member: ProjectMember): Promise<void> {
  if (!activeProject.value) return
  try {
    await projectsApi.kick(activeProject.value.id, member.id)
    members.value = await projectsApi.members(activeProject.value.id)
  } catch (error) { showError(error) }
}
async function activateProject(metadata: SavedProject, document: { xml: string; revision: number }): Promise<void> {
  const isDifferent = activeProject.value?.id !== metadata.id
  if (isDifferent) closeLive()
  store.importFile(document.xml, metadata.name)
  store.readOnly = metadata.role === 'viewer'
  store.projectName = metadata.name
  activeProject.value = { ...metadata, revision: document.revision }
  members.value = await projectsApi.members(metadata.id)
  remotePending.value = false
  saveConflict.value = false
  if (isDifferent) connectLive(metadata.id)
}

const projectsError = ref('')
const saveConflict = ref(false)
const pendingRemoval = ref('')
const overlapPrompt = ref<{ filename: string; preview: SourceOverlapPreview } | null>(null)
const auditedOverlaps = ref<ExistingSourceOverlapAudit | null>(null)
const auditBusy = ref(false)
async function auditProjectOverlaps(): Promise<void> {
  if (!activeProject.value || projectsBusy.value || auditBusy.value) return
  auditBusy.value = true
  try {
    auditedOverlaps.value = await projectsApi.auditOverlaps(activeProject.value.id)
  } catch (error) { showError(error) }
  finally { auditBusy.value = false }
}

let overlapAnswer: ((policy: OsmOverlapPolicy | null) => void) | null = null
function chooseOverlapPolicy(policy: OsmOverlapPolicy | null): void {
  const resolve = overlapAnswer
  overlapAnswer = null
  overlapPrompt.value = null
  resolve?.(policy)
}
function askOverlapPolicy(filename: string, preview: SourceOverlapPreview): Promise<OsmOverlapPolicy | null> {
  return new Promise(resolve => {
    overlapAnswer = resolve
    overlapPrompt.value = { filename, preview }
  })
}
const overlapCount = computed(() => overlapPrompt.value?.preview.counts)
let autoSaveTimer: number | null = null
let saveInFlight: Promise<void> | null = null

function showError(error: unknown): void {
  const text = error instanceof Error ? error.message : 'Ошибка сохранения проекта.'
  projectsError.value = text
  if (text.includes('Конфликт совместного редактирования') || text.includes('Версия проекта слишком старая')) {
    saveConflict.value = true
    remotePending.value = true
  }
  store.notify(text)
}
async function refreshProjects(): Promise<void> {
  projects.value = await projectsApi.list()
}
async function saveProject(): Promise<void> {
  if (saveInFlight) await saveInFlight
  for (let tries = 0; tries < 3 && activeProject.value && store.dirty; tries++) {
    const id = activeProject.value.id
    const expected_revision = activeProject.value.revision
    const editRevision = store.geometryRevision
    const xml = store.workspaceXml()
    const saving = (async () => {
      const result = await projectsApi.save(id, xml, expected_revision)
      if (activeProject.value?.id === id) {
        activeProject.value.revision = result.revision
        if (store.geometryRevision === editRevision) store.dirty = false
        if (result.merged) remotePending.value = true
        saveConflict.value = false
      }
    })()
    saveInFlight = saving
    try { await saving } finally { if (saveInFlight === saving) saveInFlight = null }
  }
  if (activeProject.value && store.dirty) {
    throw new Error('Завершите редактирование дороги перед сменой проекта.')
  }
  if (remotePending.value && !store.dirty && !saveInFlight) void refreshRemote()
}

watch(() => store.geometryRevision, () => {
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
  if (!activeProject.value || !store.dirty || activeProject.value.role === 'viewer') return
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = null
    void saveProject().catch(showError)
  }, 2500)
})
async function openProjects(): Promise<void> {
  if (!signedIn.value) { showLogin.value = true; return }
  projectsOpen.value = !projectsOpen.value
  projectsError.value = ''
  if (projectsOpen.value) {
    try { await refreshProjects() } catch (error) { showError(error) }
  }
}
async function loadProject(id: string): Promise<void> {
  if (projectsBusy.value) return
  projectsBusy.value = true
  try {
    await saveProject()
    const [metadata, document] = await Promise.all([projectsApi.get(id), projectsApi.workspace(id)])
    await activateProject(metadata, document)
    auditedOverlaps.value = null
    await refreshProjects()
    projectsError.value = ''
  } catch (error) { showError(error) }
  finally { projectsBusy.value = false }
}
async function createProject(): Promise<void> {
  if (projectsBusy.value) return
  projectsBusy.value = true
  try {
    await saveProject()
    const fromLocal = !activeProject.value && store.roads.length > 0
      ? { xml: store.workspaceXml(), filename: store.projectName.endsWith('.osm') ? store.projectName : `${store.projectName}.osm` }
      : null
    let created = await projectsApi.create(newProjectName.value.trim() || 'Новый проект')
    if (fromLocal) created = await projectsApi.addSource(created.id, fromLocal.filename, fromLocal.xml)
    const document = await projectsApi.workspace(created.id)
    await activateProject(created, document)
    auditedOverlaps.value = null
    projectsError.value = ''
    await refreshProjects()
  } catch (error) { showError(error) }
  finally { projectsBusy.value = false }
}
async function addSourceFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || !activeProject.value || projectsBusy.value) return
  projectsBusy.value = true
  const projectId = activeProject.value.id
  let imported = 0
  try {
    await saveProject()
    for (const file of files) {
      const xml = await file.text()
      // Preview is read-only and returns the current server revision. Upload
      // checks the revision again to avoid applying a choice to stale data.
      const preview = await projectsApi.previewSource(projectId, file.name, xml)
      const policy = preview.review_needed
        ? await askOverlapPolicy(file.name, preview)
        : 'keep_existing'
      if (policy === null) break
      await projectsApi.addSource(projectId, file.name, xml, policy, preview.revision)
      imported++
    }
    if (imported) projectsError.value = ''
  } catch (error) { showError(error) }
  finally {
    chooseOverlapPolicy(null)
    if (imported > 0) {
      try {
        const [metadata, document] = await Promise.all([projectsApi.get(projectId), projectsApi.workspace(projectId)])
        await activateProject(metadata, document)
        auditedOverlaps.value = null
        await refreshProjects()
      } catch (error) { showError(error) }
    }
    projectsBusy.value = false
  }
}
async function removeSource(source: ProjectSource): Promise<void> {
  if (!activeProject.value || projectsBusy.value) return
  projectsBusy.value = true
  try {
    await saveProject()
    const id = activeProject.value.id
    const deleted = await projectsApi.removeSource(id, source.id)
    const [metadata, document] = await Promise.all([projectsApi.get(id), projectsApi.workspace(id)])
    await activateProject(metadata, document)
    auditedOverlaps.value = null
    await refreshProjects()
    projectsError.value = ''
    pendingRemoval.value = ''
    const kept = deleted.removal
    if (kept && (kept.retained_ways || kept.retained_relations)) {
      store.notify(`Источник удалён. Сохранено ${kept.retained_ways} дорог и ${kept.retained_relations} отношений: они нужны другим OSM-объектам.`)
    } else {
      store.notify('Источник удалён из проекта.')
    }
  } catch (error) { showError(error) }
  finally { projectsBusy.value = false }
}
async function removeProject(item: SavedProject): Promise<void> {
  if (projectsBusy.value) return
  projectsBusy.value = true
  try {
    // When deleting the active project do NOT autosave it again.
    if (activeProject.value?.id !== item.id) await saveProject()
    await projectsApi.remove(item.id)
    if (activeProject.value?.id === item.id) {
      closeLive()
      activeProject.value = null
      members.value = []
      auditedOverlaps.value = null
      store.importFile('<osm version="0.6"></osm>', 'Новый проект')
    store.readOnly = false
    }
    await refreshProjects()
    pendingRemoval.value = ''
    projectsError.value = ''
  } catch (error) { showError(error) }
  finally { projectsBusy.value = false }
}

const recentMessage = computed(() => store.notifications[0] ?? 'Готово')

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importing.value = true
  try {
    await saveProject()
    store.importFile(await file.text(), file.name)
    store.readOnly = false
    closeLive()
    activeProject.value = null
  } catch (error) {
    store.notify(error instanceof Error ? error.message : 'Не удалось прочитать OSM-файл.')
  } finally {
    importing.value = false
    input.value = ''
  }
}

function openFile(): void { fileInput.value?.click() }

function onKeydown(event: KeyboardEvent): void {
  if (overlapPrompt.value) {
    if (event.key === 'Escape') { event.preventDefault(); chooseOverlapPolicy(null) }
    return
  }
  const target = event.target as HTMLElement | null
  if (target?.closest('input, select, textarea, [contenteditable="true"]')) return

  const ctrl = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  if (activeProject.value?.role === 'viewer' && (['p', 'c', 'd', 'i', 'j'].includes(key) || event.key === 'Delete' || ctrl && ['s', 'z', 'y'].includes(key))) return
  if (ctrl && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) store.redo()
    else store.undo()
    return
  }
  if (ctrl && key === 'y') { event.preventDefault(); store.redo(); return }
  if (ctrl && key === 'o') { event.preventDefault(); openFile(); return }
  if (ctrl && key === 's') { event.preventDefault(); void saveProject().catch(showError); return }
  if (event.key === 'Delete' && store.selectedInfrastructureId) {
    event.preventDefault()
    try { store.removeInfrastructure(store.selectedInfrastructureId) }
    catch (error) { store.notify(error instanceof Error ? error.message : 'Не удалось удалить объект.') }
    return
  }
  if (event.key === 'Delete' && store.selectedId) {
    event.preventDefault()
    store.removeRoad(store.selectedId)
    return
  }
  if (ctrl || event.altKey) return
  if (key === 'v') store.setTool('select')
  if (key === 'p') store.setTool('pen')
  if (key === 'c') { store.penMode = 'curve'; store.setTool('pen') }
  if (key === 'd') store.setTool('delete')
  if (key === 'j') store.setTool('junction')
  if (key === 'i') store.setTool('infrastructure')
  if (event.key === 'Escape') store.setTool('select')
}

watch(() => store.tool, tool => {
  if (tool === 'select' && remotePending.value && !store.dirty && !saveConflict.value) void refreshRemote()
})

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void authApi.me().then(user => { signedIn.value = user }).catch(() => { signedIn.value = null })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
  chooseOverlapPolicy(null)
  closeLive()
})
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="project-breadcrumb">
        <span>{{ store.projectName }}</span>
        <span v-if="store.dirty" class="dirty-marker" title="Несохранённые изменения">●</span>
      </div>
      <div class="header-spacer"></div>
      <span v-if="activeProject" class="collab-presence" :title="liveStatus === 'online' ? 'Обновления в реальном времени' : 'Серверное соединение потеряно'">
        <span class="collab-status-dot" :class="liveStatus"></span>
        {{ liveStatus === 'online' ? `Онлайн: ${presenceCount}` : 'Подключение…' }}
      </span>
      <span v-if="saveConflict" class="collab-conflict" role="alert">Конфликт сохранения</span>
      <button v-if="saveConflict" type="button" class="collab-update" @click="downloadMyChanges">Скачать мои изменения</button>
      <button v-if="saveConflict" type="button" class="collab-update" @click="discardLocalEdits">Версия сервера</button>
      <button v-else-if="remotePending && activeProject && !store.dirty" type="button" class="collab-update" @click="refreshRemote">Обновить сеть</button>
      <button v-if="signedIn" type="button" class="collab-account" :title="`Выйти: ${signedIn.username}`" @click="signOut">{{ signedIn.username }} · Выход</button>
      <button v-else type="button" class="collab-account" @click="showLogin = true">Войти</button>
      <button v-if="activeProject && activeProject.role !== 'viewer'" class="command-btn project-save-command" :disabled="projectsBusy || !store.dirty" title="Сохранить проект (Ctrl+S)" @click="saveProject().catch(showError)">
        <Save :size="15" /> Сохранить
      </button>
      <button class="header-export" :disabled="importing" title="Проверить и экспортировать OSM для MATSim → SUMO → Webots" @click="prepareSimulatorExport">
        <ArrowDownToLine :size="17" />
        <span>Экспорт для симуляций</span>
      </button>
    </header>

    <div class="command-bar">
      <input ref="fileInput" class="visually-hidden" type="file" accept=".osm,.xml,text/xml,application/xml" @change="onFileChange" />
      <div class="command-group">
        <button type="button" class="command-btn projects-command" :class="{ active: projectsOpen }" @click="openProjects"><FolderKanban :size="16" /> Проекты</button>
        <button class="command-btn primary-command" :disabled="importing" @click="openFile">
          <FolderOpen :size="17" />
          <span>{{ importing ? 'Загрузка…' : 'Открыть OSM' }}</span>
        </button>
      </div>
      <div class="vertical-separator"></div>
      <div class="command-group">
        <button class="square-command" :disabled="!store.history.length" title="Отменить (Ctrl+Z)" @click="store.undo"><Undo2 :size="18" /></button>
        <button class="square-command" :disabled="!store.future.length" title="Повторить (Ctrl+Y)" @click="store.redo"><Redo2 :size="18" /></button>
      </div>
      <div class="command-spacer"></div>
      <button type="button" class="command-btn analysis-command" :class="{ active: analysisOpen }"
        :aria-pressed="analysisOpen" title="Проверка качества и связности дорожной сети"
        @click="toggleAnalysis">
        <Activity :size="16" /> Анализ
        <span v-if="store.roadAnalysis && !store.roadAnalysisStale" class="analysis-command-count">{{ store.roadAnalysis.counts.critical + store.roadAnalysis.counts.warning }}</span>
      </button>
      <button type="button" class="graph-command" :class="{ active: store.graphView && store.mode === '2d' }"
        :aria-pressed="store.graphView && store.mode === '2d'" :disabled="store.mode === '3d'"
        title="Показать линии, узлы и связи полос" @click="store.graphView = !store.graphView">
        <Network :size="16" /> Граф полос
      </button>
      <div class="mode-switch" role="group" aria-label="Режим отображения">
        <button type="button" :class="{ active: store.mode === '2d' }" :aria-pressed="store.mode === '2d'" @click="store.mode = '2d'">2D</button>
        <button type="button" :class="{ active: store.mode === '3d' }" :aria-pressed="store.mode === '3d'" @click="store.mode = '3d'">3D</button>
      </div>
    </div>

    <main class="workspace">
      <ToolRail />
      <aside v-if="projectsOpen" class="projects-drawer" aria-label="Проекты и OSM источники">
        <div class="projects-drawer-heading"><strong>Проекты</strong><button type="button" aria-label="Закрыть проекты" @click="projectsOpen = false"><X :size="16" /></button></div>
        <div class="projects-drawer-scroll">
          <div v-if="activeProject && activeProject.role === 'viewer'" class="collab-note">Режим просмотра. Изменять сеть может участник с ролью редактора.</div>
          <div v-if="projectsError" class="projects-error" role="alert">{{ projectsError }}</div>
          <div class="projects-section-title">ВАШИ ПРОЕКТЫ</div>
          <div class="projects-items">
            <div v-for="item in projects" :key="item.id" class="projects-entry" :class="{ selected: activeProject?.id === item.id }">
              <button type="button" class="projects-entry-open" :disabled="projectsBusy" @click="loadProject(item.id)">
                <FolderKanban :size="16" /><span>{{ item.name }}</span><small>{{ item.source_count }} OSM</small>
              </button>
              <button v-if="item.role === 'owner'" type="button" class="projects-entry-delete" :title="`Удалить проект ${item.name}`" :disabled="projectsBusy" @click="pendingRemoval = `project:${item.id}`"><Trash2 :size="13" /></button>
              <div v-if="pendingRemoval === `project:${item.id}`" class="projects-confirm">
                <span>Удалить проект со всеми файлами?</span>
                <button type="button" @click="pendingRemoval = ''">Отмена</button>
                <button type="button" class="danger" :disabled="projectsBusy" @click="removeProject(item)">Удалить</button>
              </div>
            </div>
          </div>
          <div class="projects-section-title">НОВЫЙ ПРОЕКТ</div>
          <input v-model="newProjectName" class="projects-name-input" maxlength="120" placeholder="Название проекта" @keydown.enter="createProject" />
          <button type="button" class="projects-primary" :disabled="projectsBusy" @click="createProject"><Plus :size="15" /> Создать проект</button>
          <template v-if="activeProject">
            <div class="projects-section-title">КОМАНДА · {{ members.length }}</div>
            <div v-for="member in members" :key="member.id" class="collab-member">
              <span>{{ member.username }} <small>{{ member.role === 'owner' ? 'Владелец' : member.role === 'editor' ? 'Редактор' : 'Просмотр' }}</small></span>
              <button v-if="activeProject.role === 'owner' && member.role !== 'owner'" type="button" title="Удалить из проекта" @click="removeTeammate(member)"><X :size="13" /></button>
            </div>
            <div v-if="activeProject.role === 'owner'" class="collab-invite">
              <input v-model.trim="inviteName" placeholder="Логин участника" maxlength="48" />
              <select v-model="inviteRole" aria-label="Роль участника"><option value="editor">Редактор</option><option value="viewer">Просмотр</option></select>
              <button type="button" :disabled="!inviteName" @click="addTeammateToProject">Добавить в проект</button>
            </div>
            <template v-if="signedIn?.role === 'admin'">
              <div class="projects-section-title">СОЗДАТЬ УЧЁТНУЮ ЗАПИСЬ</div>
              <div class="collab-invite">
                <input v-model.trim="teammateName" autocomplete="off" placeholder="Логин нового сотрудника" />
                <input v-model="teammatePassword" type="password" autocomplete="new-password" placeholder="Пароль (12+ символов)" />
                <button type="button" :disabled="!teammateName || teammatePassword.length < 12" @click="createTeammate">Создать пользователя</button>
              </div>
            </template>
            <div class="projects-section-title">ИСТОЧНИКИ · {{ activeProject.sources.length }}</div>
            <div class="projects-items">
              <div v-for="source in activeProject.sources" :key="source.id" class="projects-entry">
                <div class="projects-source-name"><FolderOpen :size="14" /><span :title="source.filename">{{ source.filename }}</span></div>
                <button v-if="activeProject.role !== 'viewer'" type="button" class="projects-entry-delete" title="Удалить OSM из проекта" @click="pendingRemoval = `source:${source.id}`"><Trash2 :size="13" /></button>
                <div v-if="pendingRemoval === `source:${source.id}`" class="projects-confirm">
                  <span>Удалить источник? Созданные вручную дороги и объекты, необходимые другим OSM-отношениям, сохранятся.</span>
                  <button type="button" @click="pendingRemoval = ''">Отмена</button>
                  <button type="button" class="danger" :disabled="projectsBusy" @click="removeSource(source)">Удалить</button>
                </div>
              </div>
            </div>
            <button type="button" class="projects-secondary" :disabled="projectsBusy || auditBusy || activeProject.sources.length < 2"
              @click="auditProjectOverlaps">{{ auditBusy ? 'Проверка…' : 'Проверить наложения OSM' }}</button>
            <div v-if="auditedOverlaps" class="projects-overlap-audit">
              <div v-if="!auditedOverlaps.pairs.length">Наложений между источниками не обнаружено.</div>
              <template v-else>
                <strong>Источников с общими объектами или конфликтами: {{ auditedOverlaps.pairs.length }}</strong>
                <div v-for="(pair, index) in auditedOverlaps.pairs" :key="index" class="projects-overlap-pair">
                  <span>{{ pair.left }} / {{ pair.right }}</span>
                  <small>Общих OSM ID: {{ pair.shared_ids?.way ?? 0 }} дорог, {{ pair.shared_ids?.node ?? 0 }} узлов · Геометрических совпадений: {{ pair.counts.duplicate + pair.counts.attribute_conflict }} · Частичных: {{ pair.counts.partial }} · Близких: {{ pair.counts.nearby }}</small>
                </div>
                <small>Это только проверка. Текущий проект не изменён.</small>
              </template>
            </div>
            <input ref="addSourceInput" class="visually-hidden" type="file" accept=".osm,.xml" multiple @change="addSourceFile" />
            <button v-if="activeProject.role !== 'viewer'" type="button" class="projects-secondary" :disabled="projectsBusy" @click="addSourceInput?.click()"><Plus :size="15" /> Добавить OSM-файлы</button>
          </template>
        </div>
      </aside>
      <section class="map-stage" aria-label="Карта дорожной сети"><MapEditor ref="mapEditorRef" /></section>
      <AnalysisPanel v-if="analysisOpen" @close="closeAnalysis" @focus-road="focusAnalysisRoad" />
      <PropertyPanel v-else />
    </main>

    <div v-if="showLogin" class="collab-auth-backdrop" role="presentation">
      <form class="collab-auth-dialog" role="dialog" aria-modal="true" aria-label="Вход в редактор" @submit.prevent="signIn">
        <div class="collab-auth-header"><strong>Вход в OSM Studio</strong><button type="button" aria-label="Закрыть" @click="showLogin = false"><X :size="17" /></button></div>
        <p>Для открытия проектов и совместной работы нужна учётная запись.</p>
        <label>Логин<input v-model.trim="loginName" autocomplete="username" required autofocus /></label>
        <label>Пароль<input v-model="loginPassword" type="password" autocomplete="current-password" required /></label>
        <div v-if="authError" class="projects-error" role="alert">{{ authError }}</div>
        <button type="submit" class="projects-primary" :disabled="authBusy || !loginName || !loginPassword">{{ authBusy ? 'Проверка…' : 'Войти' }}</button>
      </form>
    </div>
    <div v-if="overlapPrompt" class="overlap-backdrop" role="presentation">
      <section class="overlap-dialog" role="dialog" aria-modal="true" aria-labelledby="overlap-title">
        <div class="overlap-heading">
          <div><span class="overlap-eyebrow">ИМПОРТ OSM</span><h2 id="overlap-title">Обнаружены наложения</h2></div>
          <button type="button" aria-label="Отменить импорт" @click="chooseOverlapPolicy(null)"><X :size="18" /></button>
        </div>
        <p class="overlap-description">Файл <strong>{{ overlapPrompt.filename }}</strong> пересекается с текущей сетью. Выберите способ импорта. Существующие изменения автоматически не перезаписываются.</p>
        <div class="overlap-summary">
          <span v-if="overlapCount?.duplicate">Дубликаты: <strong>{{ overlapCount.duplicate }}</strong></span>
          <span v-if="overlapCount?.attribute_conflict">Разные атрибуты: <strong>{{ overlapCount.attribute_conflict }}</strong></span>
          <span v-if="overlapCount?.direction_conflict">Несовместимые направления: <strong>{{ overlapCount.direction_conflict }}</strong></span>
          <span v-if="overlapCount?.id_conflict">Разные данные с тем же ID: <strong>{{ overlapCount.id_conflict }}</strong></span>
          <span v-if="overlapCount?.node_id_conflict">Различия координат общих узлов: <strong>{{ overlapCount.node_id_conflict }}</strong></span>
          <span v-if="overlapCount?.partial">Частичные наложения: <strong>{{ overlapCount.partial }}</strong></span>
          <span v-if="overlapCount?.nearby">Близкие параллельные дороги: <strong>{{ overlapCount.nearby }}</strong></span>
        </div>
        <div v-if="overlapPrompt.preview.examples.length" class="overlap-examples">
          <div v-for="(example, index) in overlapPrompt.preview.examples.slice(0, 7)" :key="index">
            <span>{{ example.name || `way/node ${example.incoming_id}` }}</span>
            <code>{{ example.incoming_id }} → {{ example.existing_id }}</code>
          </div>
        </div>
        <div class="overlap-actions">
          <button type="button" class="overlap-option primary" @click="chooseOverlapPolicy('keep_existing')">
            <strong>Оставить существующие</strong>
            <small>Совпадающие дороги объединятся; изменения текущей сети сохранятся.</small>
          </button>
          <button type="button" class="overlap-option" @click="chooseOverlapPolicy('keep_both')">
            <strong>Сохранить обе сети</strong>
            <small>Дороги с разными ID останутся отдельными, даже при наложении.</small>
          </button>
          <button v-if="overlapCount && (overlapCount.duplicate + overlapCount.attribute_conflict + overlapCount.id_conflict) > 0"
            type="button" class="overlap-option" @click="chooseOverlapPolicy('new_tags')">
            <strong>Взять теги из нового</strong>
            <small>Только атрибуты совпадающих дорог; старые OSM-узлы и геометрия сохранятся.</small>
          </button>
          <button type="button" class="overlap-cancel" @click="chooseOverlapPolicy(null)">Отменить добавление файла</button>
        </div>
        <p class="overlap-note">Частичные наложения и близкие дороги никогда не соединяются автоматически. При разных данных с одним OSM ID новые объекты могут получить локальные отрицательные ID.</p>
      </section>
    </div>
    <div v-if="simulatorExport" class="overlap-backdrop simulator-export-backdrop" role="presentation" @click.self="simulatorExport = null">
      <section class="overlap-dialog simulator-export-dialog" role="dialog" aria-modal="true" aria-labelledby="simulator-export-title">
        <div class="overlap-heading">
          <div><span class="overlap-eyebrow">ПРОВЕРКА ЭКСПОРТА</span><h2 id="simulator-export-title">MATSim · SUMO · Webots</h2></div>
          <button type="button" aria-label="Закрыть проверку экспорта" @click="simulatorExport = null"><X :size="18" /></button>
        </div>
        <div class="simulator-export-state" :class="simulatorExport.report.ok ? 'ready' : 'blocked'">
          <CheckCheck :size="17" />
          <strong>{{ simulatorExport.report.ok ? 'OSM готов к экспорту' : 'Экспорт заблокирован' }}</strong>
          <span>{{ simulatorExport.report.ok ? simulatorExport.filename : `${simulatorExport.report.errors.length} ошибок` }}</span>
        </div>
        <p class="overlap-description">
          Используется один файл OSM 0.6: сначала его читают MATSim и SUMO. Webots в этом конвертере запускается после SUMO и получает <code>scenario.zip</code> вместе с <code>fcd.xml</code> — отдельный OSM для Webots не нужен.
        </p>
        <div class="simulator-export-metrics">
          <div><strong>{{ simulatorExport.report.nodes.toLocaleString('ru-RU') }}</strong><small>узлов</small></div>
          <div><strong>{{ simulatorExport.report.ways.toLocaleString('ru-RU') }}</strong><small>ways</small></div>
          <div><strong>{{ simulatorExport.report.motorRoadWays.toLocaleString('ru-RU') }}</strong><small>автодорог</small></div>
          <div><strong>{{ simulatorExport.report.bridgeWays + simulatorExport.report.tunnelWays }}</strong><small>мостов и тоннелей</small></div>
        </div>
        <div class="simulator-export-details">
          <div><span>Координаты для MATSim</span><strong>WGS84 → EPSG:32648</strong></div>
          <div><span>Пешеходные ways</span><strong>{{ simulatorExport.report.pedestrianWays.toLocaleString('ru-RU') }}</strong></div>
          <div><span>Ограничения для авто</span><strong>{{ simulatorExport.report.restrictedWays }}</strong></div>
          <div><span>Светофоры / знаки / переходы</span><strong>{{ simulatorExport.report.trafficControls }}</strong></div>
        </div>
        <div v-if="simulatorExport.report.errors.length" class="simulator-export-messages errors" role="alert">
          <strong>Нужно исправить до экспорта</strong>
          <ul><li v-for="(message, index) in simulatorExport.report.errors" :key="index">{{ message }}</li></ul>
        </div>
        <div v-if="simulatorExport.report.warnings.length" class="simulator-export-messages warnings">
          <strong>Предупреждения</strong>
          <ul><li v-for="(message, index) in simulatorExport.report.warnings" :key="index">{{ message }}</li></ul>
        </div>
        <p class="overlap-note">
          Checker принимает именно файл <code>.osm</code>. Перед отправкой имя файла должно совпадать с именем команды, например <code>team1.osm</code>. Исходные отношения и не-дорожные OSM-объекты сохраняются.
        </p>
        <div class="simulator-export-actions">
          <button type="button" class="overlap-cancel" @click="simulatorExport = null">Закрыть</button>
          <button v-if="simulatorExport.report.ok" type="button" class="overlap-option primary" @click="downloadSimulationOsm">
            <strong>{{ simulatorExport.downloaded ? 'Скачать ещё раз' : 'Скачать OSM для конвертера' }}</strong>
            <small>{{ simulatorExport.filename }}</small>
          </button>
        </div>
      </section>
    </div>

    <footer class="status-bar">
      <div class="status-left"><CheckCheck :size="15" /><span>{{ recentMessage }}</span></div>
      <div class="status-right">
        <span>{{ store.roads.length }} дорог</span>
        <span class="status-divider"></span>
        <span>{{ store.bridgeCount }} мостов</span>
        <span class="status-divider"></span>
        <span>{{ store.mode.toUpperCase() }}{{ store.graphView && store.mode === '2d' ? ' · граф полос' : '' }} · WGS84</span>
      </div>
    </footer>
  </div>
</template>

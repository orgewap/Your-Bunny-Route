<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, Search, Trash2 } from 'lucide-vue-next'
import { useEditorStore } from '../stores/editor'
import { ROAD_STATUS_LABELS } from '../lib/roadStatus'
import { isPedestrianWay, isUndergroundPedestrianWay } from '../lib/pedestrian'
import { markingPreference } from '../lib/roadMarkings'
import { roadLengthMeters } from '../lib/geometry'
import { clampRoadLanes, laneDirections, MAX_ROAD_LANES } from '../lib/lanes'
import { buildLaneGraph } from '../lib/laneGraph'
import { getLaneTurnRules, laneDirectionPosition } from '../lib/laneRules'
import type { LaneTurnToken } from '../lib/laneRules'
import type { RoadPatch } from '../types/road'
import type { TrafficDirection, InfrastructureKind } from '../lib/infrastructure'
import { infrastructureRoadPlacement, nearbyInfrastructureRoads, allowedInfrastructureLanes, effectiveInfrastructureLanes } from '../lib/infrastructure'

const store = useEditorStore()
const search = ref('')
const visibleLimit = ref(120)
const road = computed(() => store.selectedRoad)
const isWalkRoad = computed(() => !!road.value && isPedestrianWay(road.value))
const infra = computed(() => store.selectedInfrastructure)
const infraNames: Record<InfrastructureKind, string> = { traffic_signal: 'Светофор', stop: 'Знак STOP', give_way: 'Уступи дорогу', crossing: 'Пешеходный переход', stop_line: 'Стоп-линия' }
const infraPlacement = computed(() => infra.value ? infrastructureRoadPlacement(infra.value, store.roads) : null)
const infraRoadCandidates = computed(() => infra.value ? nearbyInfrastructureRoads(infra.value, store.roads) : [])
function chooseInfraRoad(event: Event): void {
  if (!infra.value) return
  try { store.assignInfrastructureRoad(infra.value.id, (event.target as HTMLSelectElement).value) }
  catch (error) { store.notify(error instanceof Error ? error.message : 'Не удалось выбрать дорогу.') }
}
const infraLaneOptions = computed(() => {
  const placement = infraPlacement.value, current = infra.value
  if (!placement || !current) return []
  const allowed = allowedInfrastructureLanes(placement.road, current.direction)
  return allowed.map(index => {
    const position = laneDirectionPosition(placement.road, index)
    return { index, number: position ? position.index + 1 : index + 1,
      flow: position?.flow === 'backward' ? 'встречная' : 'по ходу' }
  })
})
const infraSelectedLanes = computed(() => {
  const placement = infraPlacement.value, current = infra.value
  return placement && current ? effectiveInfrastructureLanes(current, placement.road) : []
})
const infraAutoStopLine = computed(() => {
  const current = infra.value
  if (!current) return false
  return current.tags['road_editor:stop_line'] === 'yes' ||
    current.tags['road_editor:stop_line'] !== 'no' && (current.kind === 'traffic_signal' || current.kind === 'stop')
})
function changeInfraDirection(event: Event): void {
  if (!infra.value) return
  try { store.changeInfrastructureDirection(infra.value.id, (event.target as HTMLSelectElement).value as TrafficDirection) }
  catch (error) {
    store.notify(error instanceof Error ? error.message : 'Не удалось изменить направление.')
    ;(event.target as HTMLSelectElement).value = infra.value.direction
  }
}
function toggleInfraLane(index: number, checked: boolean): void {
  if (!infra.value) return
  const chosen = checked ? [...infraSelectedLanes.value, index] : infraSelectedLanes.value.filter(value => value !== index)
  try { store.changeInfrastructureLanes(infra.value.id, chosen) }
  catch (error) { store.notify(error instanceof Error ? error.message : 'Не удалось изменить полосы.') }
}
function changeStopLineEnabled(event: Event): void {
  if (infra.value) store.toggleInfrastructureStopLine(infra.value.id, (event.target as HTMLInputElement).checked)
}
function deleteInfra(): void {
  if (!infra.value) return
  try { store.removeInfrastructure(infra.value.id) }
  catch (error) { store.notify(error instanceof Error ? error.message : 'Не удалось удалить объект.') }
}

const selectedLength = computed(() => road.value ? roadLengthMeters(road.value.vertices) : 0)
const laneSplit = computed(() => road.value ? laneDirections(road.value) : { forward: 0, backward: 0 })
const graphLane = computed(() => store.graphView && store.mode === '2d' ? store.selectedGraphLane : null)
const graphLaneStats = computed(() => {
  if (!graphLane.value) return null
  // Only selected road and neighbours sharing its OSM node IDs are needed
  // for this sidebar. Building an entire city's lane graph on every click
  // caused multi-second stalls on ordinary laptops.
  const selected = store.roads.find(item => item.id === graphLane.value!.roadId)
  if (!selected) return null
  const sharedIds = new Set(selected.vertices.map(vertex => vertex.id))
  const localRoads = store.roads.filter(item => item.id === selected.id ||
    (item.level === selected.level && item.vertices.some(v => sharedIds.has(v.id))))
  const graph = buildLaneGraph(localRoads, { connectionRoadId: selected.id, maxConnections: 250 })
  const lane = graph.edges.find(item => item.roadId === graphLane.value!.roadId && item.laneIndex === graphLane.value!.laneIndex)
  if (!lane) return null
  return { lane, incoming: graph.connections.filter(link => link.toRoad === lane.roadId && link.toLane === lane.laneIndex),
    outgoing: graph.connections.filter(link => link.fromRoad === lane.roadId && link.fromLane === lane.laneIndex) }
})

const selectedTurnRules = ref<LaneTurnToken[]>([])
const canEditTurns = computed(() => !!road.value && !!graphLane.value &&
  !!laneDirectionPosition(road.value, graphLane.value.laneIndex))
watch(() => [graphLane.value?.roadId, graphLane.value?.laneIndex,
  road.value?.tags['turn:lanes'], road.value?.tags['turn:lanes:forward'], road.value?.tags['turn:lanes:backward']], () => {
  selectedTurnRules.value = road.value && graphLane.value
    ? getLaneTurnRules(road.value, graphLane.value.laneIndex) : []
}, { immediate: true })
function toggleSelectedTurn(turn: LaneTurnToken): void {
  selectedTurnRules.value = selectedTurnRules.value.includes(turn)
    ? selectedTurnRules.value.filter(item => item !== turn)
    : [...selectedTurnRules.value, turn]
}
function saveSelectedTurns(): void {
  if (!road.value || !graphLane.value) return
  try { store.setLaneTurns(road.value.id, graphLane.value.laneIndex, [...selectedTurnRules.value]) }
  catch (error) { store.notify(error instanceof Error ? error.message : 'Не удалось изменить направления.') }
}

// Missing lane tags in imported OSM are a display assumption, not real source data.
const inferredLanes = computed(() => {
  const item = road.value
  return !!item && item.id.startsWith('way-') &&
    !('lanes' in item.tags) &&
    !('lanes:forward' in item.tags) &&
    !('lanes:backward' in item.tags)
})
const bridgeFrom = ref(0)
const bridgeTo = ref(0)
const bridgeError = ref('')
const moveEast = ref(0)
const moveNorth = ref(0)
const moveStep = ref(3)
function moveSelected(): void {
  if (!road.value) return
  try {
    store.moveRoadExact(road.value.id, Number(moveEast.value), Number(moveNorth.value))
  } catch (error) {
    store.notify(error instanceof Error ? error.message : 'Ошибка перемещения.')
  }
}
function nudge(eastDirection: number, northDirection: number): void {
  if (!road.value) return
  try {
    const step = Number(moveStep.value)
    if (!Number.isFinite(step) || step <= 0) throw new Error('Шаг должен быть положительным числом.')
    store.moveRoadExact(road.value.id, step * eastDirection, step * northDirection)
  } catch (error) {
    store.notify(error instanceof Error ? error.message : 'Ошибка перемещения.')
  }
}
watch(() => road.value?.id, () => {
  const total = selectedLength.value
  bridgeFrom.value = Math.round(total * 0.25)
  bridgeTo.value = Math.round(total * 0.75)
  bridgeError.value = ''
}, { immediate: true })
function makeBridge(): void {
  if (!road.value) return
  try {
    store.createBridgeOnRoad(road.value.id, bridgeFrom.value, bridgeTo.value)
    bridgeError.value = ''
  } catch (error) {
    bridgeError.value = error instanceof Error ? error.message : 'Не удалось построить мост.'
  }
}
const roadTypes = [
  { value: 'motorway', label: 'Автомагистраль' },
  { value: 'trunk', label: 'Скоростная дорога' },
  { value: 'primary', label: 'Главная дорога' },
  { value: 'secondary', label: 'Второстепенная' },
  { value: 'tertiary', label: 'Местная дорога' },
  { value: 'residential', label: 'Жилая улица' },
  { value: 'service', label: 'Служебная дорога' },
  { value: 'unclassified', label: 'Неклассифицированная' },
  { value: 'footway', label: 'Пешеходная дорожка' },
  { value: 'path', label: 'Тропа / общая дорожка' },
  { value: 'pedestrian', label: 'Пешеходная улица' },
  { value: 'steps', label: 'Лестница' },
  { value: 'cycleway', label: 'Велодорожка' },
]

const filteredRoads = computed(() => {
  const query = search.value.trim().toLocaleLowerCase('ru-RU')
  return store.roads
    .filter(item => store.networkMode === 'all' || (store.networkMode === 'pedestrian') === isPedestrianWay(item))
    .filter(item => !query || `${item.name} ${item.highway} ${item.osmId}`.toLocaleLowerCase('ru-RU').includes(query))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }) || a.osmId.localeCompare(b.osmId, 'en', { numeric: true }))
})
const visibleRoads = computed(() => filteredRoads.value.slice(0, visibleLimit.value))
watch(search, () => { visibleLimit.value = 120 })

function patch(value: RoadPatch): void {
  if (road.value) store.patchRoad(road.value.id, value)
}
/** Editor-only metadata is stored in OSM without modifying way geometry. */
function setWebotsTag(key: 'road_editor:kerb' | 'road_editor:kerb_height' |
  'road_editor:guard_rail' | 'road_editor:bridge_support' | 'road_editor:support_spacing', value: string): void {
  if (road.value) store.setWebotsTag(road.value.id, key, value)
}
function updateLanes(event: Event): void {
  const input = event.target as HTMLInputElement
  const count = clampRoadLanes(Number(input.value) || 1)
  // Restore the visible value even if the reactive value was already at its limit.
  input.value = String(count)
  patch({ lanes: count })
}
function targetValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value
}
function removeSelected(): void {
  if (road.value) store.removeRoad(road.value.id)
}
</script>

<template>
  <aside class="inspector">
    <template v-if="infra">
      <div class="panel-heading">
        <button type="button" class="icon-button" title="Назад к списку" aria-label="Назад к списку" @click="store.selectInfrastructure(null)"><ArrowLeft :size="18" /></button>
        <h2>Дорожная инфраструктура</h2>
      </div>
      <div class="panel-scroll" tabindex="0" aria-label="Свойства объекта">
        <div class="object-intro"><div class="object-id-block">
          <span class="object-title">{{ infraNames[infra.kind] }}</span>
          <span class="object-id">OSM {{ infra.element }} / {{ infra.osmId }}</span>
        </div></div>
        <section class="property-section">
          <h3>ОБЪЕКТ</h3>
          <div class="metric-pair"><span>Тип</span><strong>{{ infraNames[infra.kind] }}</strong></div>
          <div class="metric-pair"><span>Широта</span><strong>{{ infra.vertices[0]?.lat.toFixed(6) }}</strong></div>
          <div class="metric-pair"><span>Долгота</span><strong>{{ infra.vertices[0]?.lng.toFixed(6) }}</strong></div>
          <label v-if="infra.kind !== 'crossing'" class="field infra-direction-field">
            <span>Направление действия</span>
            <select :value="infra.direction" :disabled="store.readOnly" @change="changeInfraDirection">
              <option value="forward">По направлению OSM</option>
              <option value="backward">Против направления OSM</option>
              <option value="both">Оба направления</option>
            </select>
          </label>
          <label v-if="infraRoadCandidates.length > 1" class="field infra-road-picker">
            <span>Дорога / подход к перекрёстку</span>
            <select :value="infraPlacement?.road.id" :disabled="store.readOnly" @change="chooseInfraRoad">
              <option v-for="candidate in infraRoadCandidates" :key="candidate.road.id" :value="candidate.road.id">
                {{ candidate.road.name || 'Без названия' }} · {{ candidate.road.osmId }} ({{ candidate.road.lanes }} полос)
              </option>
            </select>
          </label>
          <div v-if="infraPlacement" class="infra-lanes-picker">
            <div class="metric-pair"><span>Дорожный участок</span><strong>{{ infraPlacement.road.name || infraPlacement.road.osmId }}</strong></div>
            <h3>ПОЛОСЫ ДЕЙСТВИЯ</h3>
            <p class="infra-tag-note">Отметьте полосы, на которых действует объект. Нумерация отдельно для каждого направления.</p>
            <div class="infra-lanes-grid">
              <label v-for="lane in infraLaneOptions" :key="lane.index" class="infra-lane-check">
                <input type="checkbox" :checked="infraSelectedLanes.includes(lane.index)" :disabled="store.readOnly"
                  @change="toggleInfraLane(lane.index, ($event.target as HTMLInputElement).checked)" />
                <span>Полоса {{ lane.number }}</span>
                <small>{{ lane.flow }}</small>
              </label>
            </div>
            <p v-if="!infraLaneOptions.length" class="infra-tag-note">У этого направления нет полос. Выберите другое направление.</p>
            <label v-if="infra.kind !== 'crossing' && infra.kind !== 'stop_line'" class="infra-stopline-check">
              <input type="checkbox" :checked="infraAutoStopLine" :disabled="store.readOnly" @change="changeStopLineEnabled" />
              <span>Показывать стоп-линию перед объектом</span>
            </label>
          </div>
          <p v-else class="infra-tag-note">Не найдена связанная наземная дорога. Перенесите объект ближе к проезжей части, чтобы настроить полосы.</p>
          <p v-if="infra.kind === 'stop_line'" class="infra-tag-note">Одна OSM-стоп-линия покрывает соседние полосы. Для раздельных участков создайте две линии.</p>
          <p v-if="infra.kind !== 'stop_line'" class="infra-tag-note">Выбор полос хранится в дополнительных тегах road_editor:*. SUMO/Webots не применят его автоматически — нужен отдельный экспорт соединений.</p>
          <p v-if="infra.kind === 'traffic_signal'" class="infra-tag-note">OSM: highway=traffic_signals. Фазы работы светофора настраиваются отдельно.</p>
          <p v-else-if="infra.kind === 'stop_line'" class="infra-tag-note">OSM: road_marking=stop_line. Геометрия ограничена выбранными полосами.</p>
          <p v-else-if="infra.kind === 'crossing'" class="infra-tag-note">OSM: highway=crossing · crossing:markings=zebra.</p>
        </section>
        <section v-if="!store.readOnly" class="property-section">
          <h3>ДЕЙСТВИЯ</h3>
          <button type="button" class="move-mode-toggle" @click="store.beginInfrastructureRelocation(infra.id)">Переместить объект на карте</button>
          <button type="button" class="danger-action infra-delete" @click="deleteInfra"><Trash2 :size="16" /> Удалить объект <span>Del</span></button>
        </section>
      </div>
    </template>
    <template v-else-if="road">
      <div class="panel-heading">
        <button type="button" class="icon-button" title="К списку дорог" aria-label="К списку дорог" @click="store.selectRoad(null)">
          <ArrowLeft :size="18" />
        </button>
        <h2>Свойства дороги</h2>
      </div>
      <div class="panel-scroll" tabindex="0" aria-label="Прокручиваемые свойства дороги">
        <div class="object-intro">
          <div class="object-id-block">
            <span class="object-title">{{ road.name || (road.tags.junction === 'roundabout' ? 'Круговое движение' : 'Без названия') }}</span>
            <span class="object-id">OSM way / {{ road.osmId }}</span>
            <span class="road-provenance" :class="store.roadStatusById.get(road.id) ?? 'imported'">
              <i class="status-swatch" :class="store.roadStatusById.get(road.id) ?? 'imported'"></i>
              {{ ROAD_STATUS_LABELS[store.roadStatusById.get(road.id) ?? 'imported'] }}
            </span>
          </div>
        </div>

        <section v-if="graphLaneStats" class="graph-lane-summary">
          <strong>Полоса №{{ graphLaneStats.lane.laneIndex + 1 }} из {{ graphLaneStats.lane.count }}</strong>
          <div>{{ graphLaneStats.lane.flow === 'forward' ? 'По направлению OSM' : graphLaneStats.lane.flow === 'backward' ? 'Против направления OSM' : 'Общее движение в обе стороны' }}</div>
          <div class="graph-lane-counts">
            <span>Входящих связей: {{ graphLaneStats.incoming.length }}</span>
            <span>Выходящих связей: {{ graphLaneStats.outgoing.length }}</span>
          </div>
          <div v-if="canEditTurns" class="graph-turn-editor">
            <span>Разрешённые направления</span>
            <div class="graph-turn-buttons" role="group" aria-label="Повороты выбранной полосы">
              <button v-for="turn in (['left', 'through', 'right'] as const)" :key="turn"
                type="button" :class="{ active: selectedTurnRules.includes(turn) }"
                :aria-pressed="selectedTurnRules.includes(turn)" @click="toggleSelectedTurn(turn)">
                {{ turn === 'left' ? '↰ Налево' : turn === 'through' ? '↑ Прямо' : '↱ Направо' }}
              </button>
            </div>
            <button class="graph-turn-save" type="button" :disabled="!selectedTurnRules.length"
              @click="saveSelectedTurns">Сохранить направления</button>
          </div>
          <p class="graph-lane-caveat">Связи рассчитаны для просмотра графа. Точные связи между полосами требуют отдельного экспорта в формат симулятора.</p>
        </section>

        <section class="property-section">
          <h3>ОСНОВНОЕ</h3>
          <label class="field"><span>Название</span><input :value="road.name" placeholder="Название дороги" @change="patch({ name: targetValue($event) })" /></label>
          <label class="field"><span>Тип дороги</span>
            <select :value="road.highway" @change="patch({ highway: targetValue($event) })">
              <option v-if="!roadTypes.some(type => type.value === road?.highway)" :value="road.highway">{{ road.highway }}</option>
              <option v-for="type in roadTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
            </select>
          </label>
          <div class="metric-pair"><span>Длина</span><strong>{{ Math.round(selectedLength).toLocaleString('ru-RU') }} м</strong></div>
          <div class="metric-pair"><span>Опорные точки</span><strong>{{ road.vertices.length }}</strong></div>
        </section>

        <section v-if="isWalkRoad" class="property-section pedestrian-properties">
          <h3>ПЕШЕХОДНАЯ СЕТЬ</h3>
          <div class="metric-pair"><span>Тип связи</span><strong>{{ road.highway === 'steps' ? 'Лестница' : road.tags.footway === 'crossing' ? 'Переход' : 'Пешеходная дорожка' }}</strong></div>
          <div class="metric-pair"><span>Связность</span><strong>По общим OSM-узлам</strong></div>
          <div v-if="isUndergroundPedestrianWay(road)" class="metric-pair"><span>Расположение</span><strong>↧ Подземный переход / тоннель</strong></div>
          <p v-if="isUndergroundPedestrianWay(road)" class="infra-tag-note">Тоннель отмечен в исходных OSM-тегах. На карте он показан фиолетовым пунктиром; глубина в 3D пока условная.</p>
          <label class="field"><span>Покрытие</span>
            <select :value="road.tags.surface || ''" :disabled="store.readOnly" @change="store.setPedestrianAttribute(road.id, 'surface', targetValue($event))">
              <option value="">Не указано в OSM</option><option value="asphalt">Асфальт</option>
              <option value="paved">Твёрдое</option><option value="concrete">Бетон</option>
              <option value="paving_stones">Плитка</option><option value="gravel">Гравий</option>
              <option value="ground">Грунт</option>
            </select>
          </label>
          <label class="field"><span>Доступность для колясок</span>
            <select :value="road.tags.wheelchair || ''" :disabled="store.readOnly" @change="store.setPedestrianAttribute(road.id, 'wheelchair', targetValue($event))">
              <option value="">Неизвестно</option><option value="yes">Доступно</option><option value="limited">Ограниченно</option><option value="no">Недоступно</option>
            </select>
          </label>
          <p class="infra-tag-note">Переходы объединяют граф только по настоящим общим OSM-узлам. Тротуары из sidewalk=* отображаются пунктиром и пока не становятся маршрутными рёбрами.</p>
        </section>
        <section v-if="!isWalkRoad" class="property-section">
          <h3>ДВИЖЕНИЕ</h3>
          <label class="field"><span>Количество полос (1–10)</span><input type="number" min="1" :max="MAX_ROAD_LANES" step="1" :value="road.lanes" @change="updateLanes" /></label>
          <div class="metric-pair lane-split"><span>Полосы в 2D</span><strong>{{ road.oneway ? `${road.lanes} в одну сторону` : road.lanes === 1 ? '1 общая' : `${laneSplit.forward} + ${laneSplit.backward}` }}</strong></div>
          <p v-if="inferredLanes" class="lane-source-note">В исходном OSM число полос не задано. Значение редактора — предположение, а не исходный тег.</p>
          <label class="toggle-field">
            <span class="toggle-caption">Одностороннее движение</span>
            <input class="switch-input" type="checkbox" :checked="road.oneway" @change="patch({ oneway: ($event.target as HTMLInputElement).checked })" />
          </label>
        </section>

        <section v-if="!isWalkRoad" class="property-section">
          <h3>РАЗМЕТКА ПОЛОС</h3>
          <label class="field"><span>Осевая линия</span>
            <select :value="markingPreference(road)" :disabled="store.readOnly"
              @change="store.setRoadMarking(road.id, 'centre', targetValue($event) as any)">
              <option value="auto">Из тегов OSM / по умолчанию</option>
              <option value="solid">Сплошная</option><option value="double">Двойная сплошная</option>
              <option value="dashed">Прерывистая</option><option value="none">Без осевой линии</option>
            </select>
          </label>
          <label class="field"><span>Край проезжей части</span>
            <select :value="road.tags['road_editor:edge_marking'] || 'auto'" :disabled="store.readOnly"
              @change="store.setRoadMarking(road.id, 'edge', targetValue($event) as any)">
              <option value="auto">Из OSM / без изменений</option><option value="solid">Сплошная краевая</option><option value="none">Не рисовать</option>
            </select>
          </label>
          <p class="infra-tag-note">Сплошная и двойная осевая отображаются отдельно от полос. Ручная разметка сохраняется в тегах road_editor:*; симулятору может понадобиться отдельная конвертация.</p>
        </section>
        <section v-if="!isWalkRoad" class="property-section">
          <h3>УРОВНИ И МОСТЫ</h3>
          <template v-if="road.bridge">
            <label class="field"><span>Уровень моста</span>
              <select :value="road.level" @change="patch({ level: Number(targetValue($event)) })">
                <option :value="1">+1 — 5 м</option>
                <option :value="2">+2 — 10 м</option>
              </select>
            </label>
            <div class="metric-pair"><span>Начало моста</span><strong class="bridge-boundary-name">{{ road.vertices[0]?.lat.toFixed(6) }}, {{ road.vertices[0]?.lng.toFixed(6) }}</strong></div>
            <div class="metric-pair"><span>Конец моста</span><strong class="bridge-boundary-name">{{ road.vertices[road.vertices.length - 1]?.lat.toFixed(6) }}, {{ road.vertices[road.vertices.length - 1]?.lng.toFixed(6) }}</strong></div>
          </template>
          <template v-else>
            <div class="metric-pair"><span>Уровень</span><strong>0 — наземный</strong></div>
            <div v-if="selectedLength >= 8" class="bridge-create-fields">
              <label class="field"><span>Начало моста, м</span><input v-model.number="bridgeFrom" type="number" min="1" :max="Math.max(1, Math.floor(selectedLength - 5))" step="1" /></label>
              <label class="field"><span>Конец моста, м</span><input v-model.number="bridgeTo" type="number" :min="bridgeFrom + 4" :max="Math.floor(selectedLength - 1)" step="1" /></label>
              <button type="button" class="bridge-create-action" @click="makeBridge">Создать мост</button>
              <p v-if="bridgeError" class="crossing-error">{{ bridgeError }}</p>
            </div>
          </template>
        </section>

        <section v-if="!isWalkRoad" class="property-section">
          <h3>ИНФРАСТРУКТУРА 3D</h3>
          <label class="field"><span>Бордюры</span>
            <select :value="road.tags['road_editor:kerb'] || 'auto'" :disabled="store.readOnly" @change="setWebotsTag('road_editor:kerb', targetValue($event))">
              <option value="auto">Из тега sidewalk / нет</option>
              <option value="both">По обеим сторонам</option>
              <option value="left">Слева по ходу OSM</option>
              <option value="right">Справа по ходу OSM</option>
              <option value="no">Без бордюров</option>
            </select>
          </label>
          <label class="field"><span>Высота бордюра, м</span>
            <input type="number" min="0.03" max="0.45" step="0.01" :disabled="store.readOnly"
              :value="road.tags['road_editor:kerb_height'] || '0.15'"
              @change="setWebotsTag('road_editor:kerb_height', String(Math.min(0.45, Math.max(0.03, Number(targetValue($event)) || 0.15))))" />
          </label>
          <label class="field"><span>Ограждения</span>
            <select :value="road.tags['road_editor:guard_rail'] || 'no'" :disabled="store.readOnly" @change="setWebotsTag('road_editor:guard_rail', targetValue($event))">
              <option value="no">Не добавлять</option><option value="both">С обеих сторон</option>
              <option value="left">Слева</option><option value="right">Справа</option>
            </select>
          </label>
          <template v-if="road.bridge">
            <label class="field"><span>Опоры моста</span>
              <select :value="road.tags['road_editor:bridge_support'] || 'auto'" :disabled="store.readOnly" @change="setWebotsTag('road_editor:bridge_support', targetValue($event))">
                <option value="auto">Автоматически</option><option value="none">Не создавать</option>
              </select>
            </label>
            <label class="field"><span>Расстояние между опорами, м</span>
              <input type="number" min="8" max="100" step="1" :disabled="store.readOnly"
                :value="road.tags['road_editor:support_spacing'] || '22'"
                @change="setWebotsTag('road_editor:support_spacing', String(Math.min(100, Math.max(8, Number(targetValue($event)) || 22))))" />
            </label>
          </template>
          <p class="infra-tag-note">Бордюры, ограждения и опоры видны сразу в режиме 3D. Их параметры сохраняются обычной кнопкой «Экспорт OSM» без изменения дорожного графа.</p>
        </section>

        <section class="property-section">
          <h3>ПЕРЕМЕЩЕНИЕ ОБЪЕКТА</h3>
          <button type="button" class="move-mode-toggle" :class="{ active: store.moveObjectMode }" :aria-pressed="store.moveObjectMode" @click="store.moveObjectMode = !store.moveObjectMode">
            {{ store.moveObjectMode ? 'Режим переноса включён' : 'Перемещать объект мышью' }}
          </button>
          <p class="move-hint">{{ store.moveObjectMode ? 'Тяните объект за любую точку, включая круг и овал. Можно также удерживать Tab.' : 'Быстрый перенос: наведите на карту, удерживайте Tab и перетаскивайте выделенный объект. Или включите постоянный режим ниже.' }}</p>
          <div class="move-metre-fields">
            <label class="field"><span>Восток / запад, м</span><input v-model.number="moveEast" type="number" step="0.1" aria-label="Смещение по востоку в метрах" /></label>
            <label class="field"><span>Север / юг, м</span><input v-model.number="moveNorth" type="number" step="0.1" aria-label="Смещение по северу в метрах" /></label>
          </div>
          <button type="button" class="move-apply" @click="moveSelected">Переместить на заданное расстояние</button>
          <div class="move-nudge">
            <label class="field"><span>Быстрый сдвиг, м</span><input v-model.number="moveStep" type="number" min="0.1" max="10000" step="0.5" aria-label="Шаг быстрого перемещения" /></label>
            <div class="move-nudge-buttons" role="group" aria-label="Сдвиг выделенного объекта по сторонам света">
              <button type="button" title="На запад" aria-label="Сдвинуть на запад" @click="nudge(-1, 0)">←</button>
              <button type="button" title="На север" aria-label="Сдвинуть на север" @click="nudge(0, 1)">↑</button>
              <button type="button" title="На юг" aria-label="Сдвинуть на юг" @click="nudge(0, -1)">↓</button>
              <button type="button" title="На восток" aria-label="Сдвинуть на восток" @click="nudge(1, 0)">→</button>
            </div>
          </div>
          <p class="move-hint">Соединения с другими дорогами при переносе разъединяются. Отменить — Ctrl+Z.</p>
        </section>

        <section class="property-section">
          <h3>ДЕЙСТВИЯ</h3>
          <button type="button" class="danger-action" @click="removeSelected"><Trash2 :size="16" /> Удалить участок <span>Del</span></button>
        </section>
      </div>
    </template>

    <template v-else>
      <div class="panel-heading">
        <h2>{{ store.networkMode === 'pedestrian' ? 'Пешеходная сеть' : store.networkMode === 'all' ? 'Все участки' : 'Автодороги' }}</h2>
        <span class="road-counter">{{ filteredRoads.length }}</span>
      </div>
      <label class="road-search">
        <Search :size="15" />
        <input v-model="search" type="search" placeholder="Название, тип или ID" aria-label="Поиск дорог" />
      </label>
      <div class="panel-scroll road-list" tabindex="0" aria-label="Прокручиваемый список дорог">
        <button v-for="item in visibleRoads" :key="item.id" type="button" class="road-list-item" @click="store.selectRoad(item.id)">
          <span class="road-list-stripe" :class="isPedestrianWay(item) ? 'pedestrian' : (store.roadStatusById.get(item.id) ?? 'imported')"></span>
          <span class="road-list-info">
            <strong>{{ item.name || (item.tags.junction === 'roundabout' ? 'Круговое движение' : 'Без названия') }}</strong>
            <small>{{ item.highway }} · way/{{ item.osmId }}</small>
          </span>
          <span v-if="isUndergroundPedestrianWay(item)" class="road-list-level" title="Подземный переход">↧</span>
          <span v-else-if="item.level > 0" class="road-list-level">+{{ item.level }}</span>
        </button>
        <div v-if="store.infrastructure.length" class="infra-list-divider">ДОРОЖНАЯ ИНФРАСТРУКТУРА · {{ store.infrastructure.length }}</div>
        <button v-for="item in store.infrastructure.slice(0, 70)" :key="item.id" type="button" class="road-list-item" @click="store.selectInfrastructure(item.id)">
          <span class="road-list-stripe infra-list-stripe"></span>
          <span class="road-list-info"><strong>{{ infraNames[item.kind] }}</strong><small>{{ item.element }}/{{ item.osmId }}</small></span>
        </button>
        <button v-if="filteredRoads.length > visibleRoads.length" type="button" class="road-list-more"
          @click="visibleLimit += 120">
          Показать ещё ({{ filteredRoads.length - visibleRoads.length }})
        </button>
      </div>
      <div class="road-list-footer">Показано {{ visibleRoads.length }} из {{ filteredRoads.length }} · всего {{ filteredRoads.length }}</div>
    </template>
  </aside>
</template>

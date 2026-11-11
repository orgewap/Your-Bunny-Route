<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Activity, AlertCircle, AlertTriangle, CheckCircle2, Eye, EyeOff, Info, MapPin, RefreshCw, X } from 'lucide-vue-next'
import { useEditorStore } from '../stores/editor'
import type { RoadIssueSeverity } from '../lib/networkAnalysis'

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'focus-road', roadId: string): void
}>()

const store = useEditorStore()
const filter = ref<'attention' | RoadIssueSeverity>('attention')
const visibleLimit = ref(80)
watch(filter, () => { visibleLimit.value = 80 })
const analysis = computed(() => store.roadAnalysis)
const filteredIssues = computed(() => {
  const issues = analysis.value?.issues ?? []
  if (filter.value === 'attention') return issues.filter(issue => issue.severity !== 'info')
  return issues.filter(issue => issue.severity === filter.value)
})
const displayedIssues = computed(() => filteredIssues.value.slice(0, visibleLimit.value))
const roadLabels = computed(() => new Map(store.roads.map(road => [road.id, road.name.trim() || `Дорога ${road.osmId}`])))
const filterCounts = computed(() => ({
  attention: (analysis.value?.counts.critical ?? 0) + (analysis.value?.counts.warning ?? 0),
  critical: analysis.value?.counts.critical ?? 0,
  warning: analysis.value?.counts.warning ?? 0,
  info: analysis.value?.counts.info ?? 0,
}))

function roadLabel(roadId: string): string {
  return roadLabels.value.get(roadId) ?? `Дорога ${roadId.slice(0, 8)}`
}
function issueRoadLabel(ids: string[]): string {
  const first = ids[0] ? roadLabel(ids[0]) : 'Дорожный участок'
  return ids.length > 1 ? `${first} и ещё ${ids.length - 1}` : first
}
function formatLength(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} км` : `${Math.round(metres)} м`
}
function severityLabel(severity: RoadIssueSeverity): string {
  return severity === 'critical' ? 'Критическая' : severity === 'warning' ? 'Предупреждение' : 'Информация'
}
function focusIssue(roadId: string): void {
  emit('focus-road', roadId)
}
function runAnalysis(): void {
  if (store.networkMode === 'pedestrian') store.setNetworkMode('motor')
  store.runRoadAnalysis()
}
function roadCountLabel(count: number): string {
  const mod10 = count % 10, mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'дорога'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дороги'
  return 'дорог'
}
</script>

<template>
  <aside class="inspector analysis-inspector" aria-label="Анализ дорожной сети">
    <header class="panel-heading analysis-panel-heading">
      <div class="analysis-heading-title">
        <Activity :size="17" />
        <div><h2>Анализ</h2><small>Качество дорожной сети</small></div>
      </div>
      <button type="button" class="icon-button" aria-label="Закрыть анализ" title="Вернуться к свойствам" @click="emit('close')"><X :size="17" /></button>
    </header>

    <nav class="analysis-subtabs" aria-label="Разделы анализа">
      <button type="button" class="active" aria-current="page">Критичность дорог</button>
    </nav>

    <div class="panel-scroll analysis-scroll">
      <section class="analysis-intro">
        <strong>Проверка связности</strong>
        <p>Проверка всей импортированной и созданной автомобильной сети: изолированные дороги, небольшие оторванные фрагменты и пропущенные соединения.</p>
        <p class="analysis-method-note">Реальное соединение определяется по общему OSM-узлу и одинаковому уровню. Крупные связные фрагменты, уже существовавшие в исходном OSM, считаются самостоятельными сетями и показываются как информация, а не как ошибка. Свободный конец сам по себе не считается проблемой; предупреждение появляется, если он находится в пределах 4 м от другой дороги того же уровня без общего OSM-узла. Мосты и дороги под ними не смешиваются. Подсветка работает в 2D.</p>
      </section>

      <section class="analysis-run-section">
        <button type="button" class="analysis-run-button" :disabled="store.roads.length === 0" @click="runAnalysis">
          <RefreshCw :size="15" />
          {{ analysis ? 'Проверить повторно' : 'Проверить сеть' }}
        </button>
        <div class="analysis-network-meta">
          <span>Автомобильные дороги</span><strong>{{ store.motorRoadCount.toLocaleString('ru-RU') }}</strong>
        </div>
      </section>

      <template v-if="analysis">
        <div v-if="store.roadAnalysisStale" class="analysis-stale-note" role="status">
          <AlertTriangle :size="15" /> Сеть изменилась после проверки. Результаты устарели — запусти анализ повторно.
        </div>

        <section class="analysis-summary" aria-label="Сводка проблем">
          <div class="analysis-summary-card critical"><strong>{{ analysis.counts.critical }}</strong><span>Критические</span></div>
          <div class="analysis-summary-card warning"><strong>{{ analysis.counts.warning }}</strong><span>Предупреждения</span></div>
          <div class="analysis-summary-card info"><strong>{{ analysis.counts.info }}</strong><span>Информация</span></div>
        </section>

        <section class="analysis-stats">
          <div><span>Проверено дорог</span><strong>{{ analysis.roadCount.toLocaleString('ru-RU') }}</strong></div>
          <div><span>Компонентов связности</span><strong>{{ analysis.componentCount.toLocaleString('ru-RU') }}</strong></div>
          <div><span>Дорог в крупнейшей сети</span><strong>{{ analysis.mainComponentRoadCount.toLocaleString('ru-RU') }}</strong></div>
          <div><span>Дорог в остальных сетях</span><strong>{{ Math.max(0, analysis.roadCount - analysis.mainComponentRoadCount).toLocaleString('ru-RU') }}</strong></div>
          <div><span>Дорог с замечаниями</span><strong>{{ analysis.affectedRoadCount.toLocaleString('ru-RU') }}</strong></div>
        </section>

        <label class="analysis-map-toggle">
          <input v-model="store.roadAnalysisVisible" type="checkbox" :disabled="store.roadAnalysisStale" />
          <component :is="store.roadAnalysisVisible ? Eye : EyeOff" :size="15" />
          Подсвечивать проблемы на карте
        </label>

        <div class="analysis-map-legend" aria-label="Цвета проблем на карте">
          <span><i class="critical"></i> Критическая</span>
          <span><i class="warning"></i> Предупреждение</span>
          <span><i class="info"></i> Информация</span>
        </div>

        <section class="analysis-issues-section">
          <div class="analysis-issues-heading">
            <h3>Найденные проблемы</h3>
            <span>{{ filteredIssues.length }}</span>
          </div>
          <div class="analysis-filters" role="group" aria-label="Фильтр проблем">
            <button type="button" :class="{ active: filter === 'attention' }" @click="filter = 'attention'">Требуют внимания <small>{{ filterCounts.attention }}</small></button>
            <button type="button" :class="{ active: filter === 'critical' }" @click="filter = 'critical'">Критические <small>{{ filterCounts.critical }}</small></button>
            <button type="button" :class="{ active: filter === 'warning' }" @click="filter = 'warning'">Предупреждения <small>{{ filterCounts.warning }}</small></button>
            <button type="button" :class="{ active: filter === 'info' }" @click="filter = 'info'">Информация <small>{{ filterCounts.info }}</small></button>
          </div>

          <div v-if="!filteredIssues.length" class="analysis-empty">
            <CheckCircle2 v-if="filter !== 'info' || analysis.counts.info === 0" :size="24" />
            <Info v-else :size="24" />
            <strong>{{ filter === 'info' && analysis.counts.info === 0 ? 'Информационных замечаний нет' : 'Проблем не найдено' }}</strong>
            <span>{{ filter === 'attention' ? 'Критических ошибок и предупреждений нет. Информационные замечания можно посмотреть отдельно.' : 'Для выбранного фильтра замечаний нет.' }}</span>
          </div>

          <article v-for="issue in displayedIssues" :key="issue.id" class="analysis-issue" :class="issue.severity">
            <div class="analysis-issue-topline">
              <span class="analysis-severity-dot" :class="issue.severity"></span>
              <strong>{{ issue.title }}</strong>
              <small>{{ severityLabel(issue.severity) }}</small>
            </div>
            <div class="analysis-issue-road">{{ issueRoadLabel(issue.roadIds) }}</div>
            <p>{{ issue.description }}</p>
            <div class="analysis-issue-meta">
              <span>{{ issue.roadCount }} {{ roadCountLabel(issue.roadCount) }}</span>
              <span>{{ formatLength(issue.lengthMetres) }}</span>
              <span v-if="issue.openEnds">Свободных концов: {{ issue.openEnds }}</span>
            </div>
            <button type="button" class="analysis-focus-button" :disabled="!issue.roadIds.length" @click="focusIssue(issue.roadIds[0]!)">
              <MapPin :size="13" /> Показать на карте
            </button>
          </article>
          <button v-if="displayedIssues.length < filteredIssues.length" type="button" class="analysis-load-more"
            @click="visibleLimit = Math.min(visibleLimit + 80, filteredIssues.length)">
            Показать ещё {{ Math.min(80, filteredIssues.length - displayedIssues.length) }}
          </button>
        </section>
      </template>

      <div v-else class="analysis-before-run">
        <div class="analysis-before-icon"><Activity :size="24" /></div>
        <strong>Пока нет результатов</strong>
        <span>Запусти проверку, чтобы найти изолированные дороги, небольшие оторванные фрагменты и вероятные пропущенные соединения.</span>
      </div>

      <section class="analysis-footnote">
        <AlertCircle :size="14" />
        <span>Свободный конец сам по себе не считается проблемой: это может быть тупик, въезд или продолжение за границей загруженной области. Крупные связные участки исходного OSM тоже не считаются ошибкой только потому, что не соединены с крупнейшим компонентом карты. Предупреждение появляется, если конец расположен рядом с другой дорогой того же уровня, но не имеет с ней общего OSM-узла.</span>
      </section>
    </div>
  </aside>
</template>

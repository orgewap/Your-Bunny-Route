<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { MousePointer2, PencilLine, Waves, Circle, Trash2, PenTool, MousePointerClick, GitMerge, TrafficCone, Octagon, TriangleAlert, PersonStanding, Minus, Route }  from 'lucide-vue-next'
import { useEditorStore } from '../stores/editor'
import type { EditorTool } from '../types/road'
const store = useEditorStore()
const tools: Array<{ id: EditorTool; title: string; key: string; icon: Component }> = [
  { id: 'select', title: 'Выделение и перемещение узлов', key: 'V', icon: MousePointer2 },
  { id: 'pen', title: 'Перо: непрерывное рисование', key: 'P', icon: PenTool },
  { id: 'walk-route', title: 'Пешеходный маршрут: две точки', key: 'M', icon: Route },
  { id: 'junction', title: 'Перекрёсток: соединить наземные дороги', key: 'J', icon: GitMerge },
  { id: 'infrastructure', title: 'Дорожная инфраструктура', key: 'I', icon: TrafficCone },
  { id: 'delete', title: 'Удаление дороги', key: 'D', icon: Trash2 },
]
const visibleTools = computed(() => tools.filter(item =>
  store.networkMode === 'pedestrian'
    ? ['select', 'pen', 'walk-route', 'delete'].includes(item.id)
    : store.networkMode === 'motor' ? item.id !== 'walk-route' : true,
))
</script>
<template>
  <nav class="tool-rail" aria-label="Инструменты редактора">
    <div class="rail-group">
      <button v-for="tool in visibleTools" :key="tool.id" class="rail-button" :class="{ active: store.tool === tool.id }" :title="`${tool.title} (${tool.key})`" :aria-label="tool.title" :disabled="store.readOnly && tool.id !== 'select'" @click="store.setTool(tool.id)">
        <component :is="tool.icon" :size="19" :stroke-width="1.8" />
      </button>
    </div>
    <div v-if="store.tool === 'pen'" class="pen-mode-menu" role="group" aria-label="Режим пера">
      <div class="pen-mode-title">{{ store.networkMode === 'pedestrian' ? 'Пешеходная дорожка · P' : 'Перо · P' }}</div>
      <button type="button" :class="{ active: store.penMode === 'draw' }" @click="store.penMode = 'draw'">
        <PencilLine :size="16" /> Рисование
      </button>
      <button type="button" :class="{ active: store.penMode === 'curve' }" @click="store.penMode = 'curve'">
        <Waves :size="16" /> Кривая
      </button>
      <button type="button" :class="{ active: store.penMode === 'freehand' }" @click="store.penMode = 'freehand'">
        <MousePointerClick :size="16" /> Свободная рука
      </button>
      <button v-if="store.networkMode !== 'pedestrian'" type="button" :class="{ active: store.penMode === 'ellipse' }" @click="store.penMode = 'ellipse'">
        <Circle :size="16" /> Круг / овал
      </button>
    </div>
    <div v-if="store.tool === 'infrastructure'" class="pen-mode-menu infra-mode-menu" role="group" aria-label="Дорожная инфраструктура">
      <div class="pen-mode-title">Инфраструктура · I</div>
      <button type="button" :class="{ active: store.infraKind === 'traffic_signal' }" @click="store.setInfrastructureTool('traffic_signal')"><TrafficCone :size="16" /> Светофор</button>
      <button type="button" :class="{ active: store.infraKind === 'stop' }" @click="store.setInfrastructureTool('stop')"><Octagon :size="16" /> STOP</button>
      <button type="button" :class="{ active: store.infraKind === 'give_way' }" @click="store.setInfrastructureTool('give_way')"><TriangleAlert :size="16" /> Уступи дорогу</button>
      <button type="button" :class="{ active: store.infraKind === 'crossing' }" @click="store.setInfrastructureTool('crossing')"><PersonStanding :size="16" /> Пешеходный переход</button>
      <button type="button" :class="{ active: store.infraKind === 'stop_line' }" @click="store.setInfrastructureTool('stop_line')"><Minus :size="16" /> Стоп-линия</button>
    </div>
  </nav>
</template>

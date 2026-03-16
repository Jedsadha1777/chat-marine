<script setup lang="ts">
import type { Entity } from '../data/types'
import type { EntityType } from '../data/entities'
import { ENTITIES_BY_TYPE, ENTITY_TYPE_LABELS } from '../data/entities'

const props = defineProps<{
  type: EntityType
  modelValue: Entity | null
}>()

const emit = defineEmits<{
  'update:modelValue': [entity: Entity | null]
}>()

const options = computed(() => ENTITIES_BY_TYPE(props.type))
const label   = computed(() => ENTITY_TYPE_LABELS[props.type])

function select(entity: Entity) {
  if (props.modelValue?.id === entity.id) {
    emit('update:modelValue', null) // deselect
  } else {
    emit('update:modelValue', entity)
  }
}
</script>

<template>
  <div class="picker">
    <div class="picker__label">{{ label }}</div>

    <div class="picker__options">
      <button
        v-for="entity in options"
        :key="entity.id"
        class="picker__option"
        :class="{ 'picker__option--selected': modelValue?.id === entity.id }"
        @click="select(entity)"
      >
        <span class="picker__option-name">{{ entity.name }}</span>
        <span class="picker__option-cost">
          ฿{{ Number(entity.attributes.unit_cost ?? 0).toLocaleString() }}
        </span>
        <span
          v-if="entity.attributes.power_draw_w || entity.attributes.tdp_w"
          class="picker__option-power"
        >
          {{ entity.attributes.power_draw_w ?? entity.attributes.tdp_w }}W
        </span>
        <span v-if="entity.attributes.watt_output" class="picker__option-power picker__option-power--psu">
          {{ entity.attributes.watt_output }}W
        </span>
      </button>
    </div>

    <button
      v-if="modelValue"
      class="picker__clear"
      @click="emit('update:modelValue', null)"
    >
      ✕ ล้าง
    </button>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.picker__label {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-accent);
}

.picker__options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.picker__option {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
}

.picker__option:hover {
  border-color: var(--color-accent);
  background: var(--color-surface-hover);
}

.picker__option--selected {
  border-color: var(--color-accent);
  background: var(--color-accent-muted);
}

.picker__option-name {
  font-size: 13px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker__option-cost {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  color: var(--color-text-muted);
}

.picker__option-power {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  padding: 2px 5px;
  border-radius: 3px;
  background: var(--color-power-bg);
  color: var(--color-power-text);
}

.picker__option-power--psu {
  background: var(--color-psu-bg);
  color: var(--color-psu-text);
}

.picker__clear {
  font-size: 11px;
  color: var(--color-text-muted);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  padding: 2px 0;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.picker__clear:hover { opacity: 1; }
</style>

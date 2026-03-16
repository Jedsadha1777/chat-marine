<script setup lang="ts">
import type { ValidationResult } from '../data/types'

defineProps<{
  result: ValidationResult
  totalPower: number
  psuCapacity: number | null
  selectedCount: number
}>()
</script>

<template>
  <div class="panel">
    <!-- Status bar -->
    <div
      class="panel__status"
      :class="{
        'panel__status--valid':   result.is_valid && selectedCount > 0,
        'panel__status--invalid': !result.is_valid,
        'panel__status--empty':   selectedCount === 0,
      }"
    >
      <span class="panel__status-icon">
        {{ selectedCount === 0 ? '○' : result.is_valid ? '✓' : '✗' }}
      </span>
      <span class="panel__status-text">
        {{
          selectedCount === 0
            ? 'เลือกชิ้นส่วนเพื่อเริ่ม'
            : result.is_valid
            ? 'ผ่านการตรวจสอบ'
            : `พบ ${(result.issues ?? []).filter(i => i.severity === 'error').length} ข้อผิดพลาด`
        }}
      </span>
    </div>

    <!-- Power meter -->
    <div v-if="psuCapacity && selectedCount > 0" class="panel__power">
      <div class="panel__power-label">
        <span>Power</span>
        <span class="panel__power-val">
          {{ totalPower }}W / {{ psuCapacity }}W
        </span>
      </div>
      <div class="panel__power-bar">
        <div
          class="panel__power-fill"
          :class="{
            'panel__power-fill--ok':   totalPower / psuCapacity <= 0.8,
            'panel__power-fill--warn': totalPower / psuCapacity > 0.8 && totalPower / psuCapacity <= 1,
            'panel__power-fill--over': totalPower / psuCapacity > 1,
          }"
          :style="{ width: Math.min((totalPower / psuCapacity) * 100, 100) + '%' }"
        />
      </div>
      <div class="panel__power-pct">
        {{ Math.round((totalPower / psuCapacity) * 100) }}%
      </div>
    </div>

    <!-- Issues list -->
    <div v-if="(result.issues ?? []).length" class="panel__issues">
      <div
        v-for="(issue, idx) in (result.issues ?? [])"
        :key="idx"
        class="issue"
        :class="`issue--${issue.severity}`"
      >
        <span class="issue__icon">
          {{ issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '△' : 'ℹ' }}
        </span>
        <div class="issue__body">
          <div class="issue__code">{{ issue.rule_code }}</div>
          <div class="issue__message">{{ issue.message }}</div>
          <div v-if="issue.resolution" class="issue__resolution">
            → {{ issue.resolution }}
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="selectedCount > 0" class="panel__all-good">
      ไม่พบปัญหา — พร้อมสร้าง BOM
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Status */
.panel__status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
}

.panel__status--empty   { background: var(--color-surface); }
.panel__status--valid   { background: var(--color-ok-bg);   border-color: var(--color-ok); }
.panel__status--invalid { background: var(--color-err-bg);  border-color: var(--color-err); }

.panel__status-icon {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 16px;
  font-weight: 600;
}

.panel__status--valid   .panel__status-icon { color: var(--color-ok); }
.panel__status--invalid .panel__status-icon { color: var(--color-err); }
.panel__status--empty   .panel__status-icon { color: var(--color-text-muted); }

.panel__status-text {
  font-size: 13px;
  font-weight: 500;
}

/* Power */
.panel__power {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.panel__power-label {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--color-text-muted);
}

.panel__power-val {
  font-family: 'IBM Plex Mono', monospace;
}

.panel__power-bar {
  height: 6px;
  background: var(--color-border);
  border-radius: 3px;
  overflow: hidden;
}

.panel__power-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease, background 0.3s;
}

.panel__power-fill--ok   { background: var(--color-ok); }
.panel__power-fill--warn { background: var(--color-warn); }
.panel__power-fill--over { background: var(--color-err); }

.panel__power-pct {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  color: var(--color-text-muted);
  text-align: right;
}

/* Issues */
.panel__issues {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.issue {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 4px;
  border-left: 3px solid;
}

.issue--error   { background: var(--color-err-bg);  border-color: var(--color-err);  }
.issue--warning { background: var(--color-warn-bg); border-color: var(--color-warn); }
.issue--info    { background: var(--color-ok-bg);   border-color: var(--color-ok);   }

.issue__icon {
  font-size: 14px;
  line-height: 1.4;
  flex-shrink: 0;
}

.issue--error   .issue__icon { color: var(--color-err); }
.issue--warning .issue__icon { color: var(--color-warn); }

.issue__body { display: flex; flex-direction: column; gap: 2px; }

.issue__code {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.issue__message   { font-size: 12px; line-height: 1.5; }
.issue__resolution { font-size: 11px; color: var(--color-text-muted); }

.panel__all-good {
  font-size: 12px;
  color: var(--color-ok);
  text-align: center;
  padding: 8px;
}
</style>
<script setup lang="ts">
import type { BomItem } from '../data/types'

defineProps<{
  items: BomItem[]
  totalCost: number
}>()
</script>

<template>
  <div v-if="items.length" class="bom">
    <div class="bom__header">
      <span class="bom__title">Bill of Materials</span>
      <span class="bom__badge">{{ items.length }} รายการ</span>
    </div>

    <table class="bom__table">
      <thead>
        <tr>
          <th class="bom__th bom__th--line">#</th>
          <th class="bom__th">รายการ</th>
          <th class="bom__th bom__th--num">จำนวน</th>
          <th class="bom__th bom__th--num">ราคา/ชิ้น</th>
          <th class="bom__th bom__th--num">รวม</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.line_number" class="bom__row">
          <td class="bom__td bom__td--line">{{ item.line_number }}</td>
          <td class="bom__td">
            <span class="bom__type-badge">{{ item.entity.entity_type }}</span>
            {{ item.entity.name }}
          </td>
          <td class="bom__td bom__td--num">{{ item.quantity }}</td>
          <td class="bom__td bom__td--num">฿{{ item.unit_cost.toLocaleString() }}</td>
          <td class="bom__td bom__td--num bom__td--total">
            ฿{{ item.total_cost.toLocaleString() }}
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr class="bom__foot">
          <td colspan="4" class="bom__td bom__td--sum-label">รวมทั้งหมด</td>
          <td class="bom__td bom__td--num bom__td--grand">
            ฿{{ totalCost.toLocaleString() }}
          </td>
        </tr>
      </tfoot>
    </table>
  </div>
</template>

<style scoped>
.bom {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bom__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bom__title {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-accent);
}

.bom__badge {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  padding: 2px 6px;
  background: var(--color-accent-muted);
  border-radius: 10px;
  color: var(--color-accent);
}

.bom__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.bom__th {
  padding: 6px 10px;
  text-align: left;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
}

.bom__th--line { width: 36px; }
.bom__th--num  { text-align: right; }

.bom__row:hover td { background: var(--color-surface-hover); }

.bom__td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}

.bom__td--line {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  color: var(--color-text-muted);
}

.bom__td--num   { text-align: right; font-family: 'IBM Plex Mono', monospace; }
.bom__td--total { color: var(--color-text); }

.bom__type-badge {
  display: inline-block;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  padding: 1px 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 3px;
  color: var(--color-text-muted);
  margin-right: 6px;
  text-transform: uppercase;
  vertical-align: middle;
}

.bom__foot td {
  padding: 10px 10px;
  border-top: 2px solid var(--color-border);
}

.bom__td--sum-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
}

.bom__td--grand {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 15px;
  font-weight: 700;
  text-align: right;
  color: var(--color-accent);
}
</style>

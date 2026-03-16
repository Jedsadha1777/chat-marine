<script setup lang="ts">
import type { Entity } from '~/data/types'
import type { SlotItem } from '~/composables/useSimulation'
import { ENTITY_TYPE_LABELS, type EntityType } from '~/data/entities'
import { COST_ATTRIBUTE, COST_PRECISION } from '~/composables/simulationConfig'

const {
  budget,
  pinned,
  suggestion,
  totalCost,
  budgetRemaining,
  budgetUsedPct,
  issues,
  aggregateDetail,
  isValid,
  bom,
  pin,
  pinItems,
  setPinnedQuantity,
  exclude,
  excluded,
  clearAll,
  compatibleEntitiesFor,
  slotLimit,
  canAddToSlot,
} = useSimulation()

const SLOT_ORDER: EntityType[] = ['gpu', 'cpu', 'motherboard', 'ram', 'psu']
const expandedSlot = ref<EntityType | null>(null)

// ─── Pin actions ──────────────────────────────────────────────────
function toggleExpand(type: EntityType) {
  expandedSlot.value = expandedSlot.value === type ? null : type
}

function selectPin(type: EntityType, entity: Entity) {
  const limit   = slotLimit(type)
  const already = pinned[type].findIndex((s) => s.entity.id === entity.id)

  if (limit === 1) {
    // limit=1 → แทนที่เสมอ
    pin(type, entity)
  } else if (already !== -1) {
    // toggle off — unpin เฉพาะตัวนี้
    pinItems(type, pinned[type].filter((s) => s.entity.id !== entity.id))
  } else {
    // entity ยังไม่ได้ pin — ตรวจว่าอยู่ใน suggestion แล้วหรือยัง
    const inSuggestion = suggestion.value[type].find((s) => s.entity.id === entity.id)

    if (inSuggestion) {
      // auto-fill อยู่แล้ว → lock ที่ qty เดิม ไม่ได้เพิ่มใหม่
      // ไม่ต้องเช็ค aggregate เพราะ module count ไม่เปลี่ยน
      pinItems(type, [...pinned[type], { entity, quantity: inSuggestion.quantity }])
    } else if (canAddToSlot(type, entity)) {
      // entity ใหม่ที่ยังไม่อยู่ใน simulation — เพิ่ม 1 kit
      pinItems(type, [...pinned[type], { entity, quantity: 1 }])
    }
  }
}

function selectAuto(type: EntityType) {
  pin(type, null)
  exclude(type, false)
}

function selectExclude(type: EntityType) {
  exclude(type, true)
}

function adjustQty(type: EntityType, entityId: number, delta: number) {
  const idx = pinned[type].findIndex((s) => s.entity.id === entityId)
  if (idx === -1) return
  const slotItem = pinned[type][idx]   // SlotItem { entity, quantity }
  const current  = slotItem.quantity
  const next     = current + delta

  if (next < 1) {
    // qty = 0 → unpin entity นี้ออก
    pinItems(type, pinned[type].filter((s) => s.entity.id !== entityId))
  } else if (delta > 0 && !canAddToSlot(type, slotItem.entity)) {
    // aggregate rule ไม่ผ่าน (เช่น RAM modules เกิน slot) → ไม่เพิ่ม
    return
  } else {
    setPinnedQuantity(type, idx, next)
  }
}

// ─── Budget ───────────────────────────────────────────────────────
const budgetInput = ref<string>('')
watch(budgetInput, (val) => {
  const n = Number(val)
  budget.value = val === '' || isNaN(n) ? null : n
})

const PRESETS = [15000, 20000, 30000, 50000, 80000]
function setPreset(p: number) { budgetInput.value = String(p) }

// ─── Currency / Cost helpers ──────────────────────────────────────
const currencyFmt = new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB',
  minimumFractionDigits: 0, maximumFractionDigits: 0,
})
function fmt(value: number): string { return currencyFmt.format(value) }

function slotTotal(items: SlotItem[]): number {
  return items.reduce((sum, s) => {
    const raw = s.entity.attributes[COST_ATTRIBUTE] ?? 0
    return sum + parseFloat(Number(raw).toFixed(COST_PRECISION)) * s.quantity
  }, 0)
}

// ─── Power bar (from rule engine) ────────────────────────────────
const powerAgg = computed(() => aggregateDetail.value?.aggregate_value ?? null)
const powerCap = computed(() => aggregateDetail.value?.capacity_value  ?? null)
const powerPct = computed(() => {
  if (!powerAgg.value || !powerCap.value || powerCap.value === 0) return 0
  return Math.min((powerAgg.value / powerCap.value) * 100, 100)
})
</script>
<template>
  <div class="app">

    <div class="topbar">
      <span class="app-name">Compatibility Matrix</span>
      <button class="btn-sm btn-ghost" @click="clearAll(); budgetInput = ''">Reset</button>
    </div>

    <div class="toolbar">
      <label class="field-label">งบประมาณ</label>
      <input v-model="budgetInput" type="number" step="1000" min="0"
        placeholder="ไม่จำกัด" class="budget-input" />
      <div class="presets">
        <button v-for="p in PRESETS" :key="p"
          class="btn-sm" :class="{ 'btn-active': budget === p }"
          @click="setPreset(p)">฿{{ (p/1000).toFixed(0) }}K</button>
      </div>
    </div>

    <div class="body">

      <div class="slots-col">
        <table class="slot-table">
          <thead>
            <tr>
              <th>ประเภท</th>
              <th>รุ่น</th>
              <th>ราคา</th>
              <th>สถานะ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="type in SLOT_ORDER" :key="type">
              <tr class="slot-tr" :class="{
                'tr-pinned':   pinned[type].length > 0,
                'tr-excluded': excluded[type],
              }">
                <td class="td-type">{{ ENTITY_TYPE_LABELS[type] }}</td>
                <td class="td-name">
                  <template v-if="excluded[type]">
                    <span class="text-muted">— ไม่ใช้ —</span>
                  </template>
                  <template v-else-if="suggestion[type].length > 0">
                    <div v-for="(item, i) in suggestion[type]" :key="item.entity.id" class="slot-item-row">
                      {{ item.entity.name }}
                      <span v-if="item.quantity > 1" class="qty-badge">×{{ item.quantity }}</span>
                    </div>
                  </template>
                  <template v-else>
                    <span class="text-muted">— ไม่มีในงบ —</span>
                  </template>
                </td>
                <td class="td-price">
                  <template v-if="suggestion[type].length === 1">
                    {{ fmt(slotTotal(suggestion[type])) }}
                  </template>
                  <template v-else-if="suggestion[type].length > 1">
                    <div v-for="item in suggestion[type]" :key="item.entity.id" class="slot-item-row">
                      {{ fmt(slotTotal([item])) }}
                    </div>
                  </template>
                </td>
                <td class="td-status">
                  <span v-if="excluded[type]"    class="badge err">ไม่ใช้</span>
                  <span v-else-if="pinned[type].length > 0" class="badge pin">ล็อก</span>
                  <span v-else-if="suggestion[type].length > 0" class="badge auto">อัตโนมัติ</span>
                </td>
                <td class="td-action">
                  <button class="btn-sm" :class="expandedSlot === type ? 'btn-active' : ''"
                    @click="toggleExpand(type)">เลือก</button>
                  <button v-if="pinned[type].length > 0" class="btn-sm btn-ghost"
                    @click="pin(type, null)">ยกเลิก</button>
                </td>
              </tr>

              <tr v-if="expandedSlot === type" class="picker-tr">
                <td colspan="5" class="picker-td">
                  <div class="picker">
                    <div class="picker-head">
                      <span>
                        เลือก {{ ENTITY_TYPE_LABELS[type] }}
                        <span v-if="slotLimit(type) > 1" class="text-muted">
                          (เลือกได้สูงสุด {{ slotLimit(type) }} ชิ้น)
                        </span>
                      </span>
                      <button class="btn-sm btn-primary" @click="expandedSlot = null">ตกลง</button>
                    </div>

                    <div class="picker-opts">
                      <!-- ให้ระบบเลือก -->
                      <div class="pick-row" :class="{ 'pick-active': pinned[type].length === 0 && !excluded[type] }"
                        @click="selectAuto(type)">
                        <span>ให้ระบบเลือกอัตโนมัติ</span>
                        <span class="pick-check">{{ pinned[type].length === 0 && !excluded[type] ? '✓' : '' }}</span>
                      </div>

                      <!-- ไม่ใช้ -->
                      <div class="pick-row pick-row-exclude" :class="{ 'pick-active': excluded[type] }"
                        @click="selectExclude(type)">
                        <span>ไม่ใช้ชิ้นส่วนนี้</span>
                        <span class="pick-check">{{ excluded[type] ? '✓' : '' }}</span>
                      </div>

                      <div class="pick-divider"></div>

                      <!-- รายการ entity -->
                      <div v-for="entity in compatibleEntitiesFor(type)" :key="entity.id"
                        class="pick-row" :class="{ 'pick-active': pinned[type].some(s => s.entity.id === entity.id) }">
                        <span class="pick-name" @click="selectPin(type, entity)">
                          {{ entity.name }}
                        </span>
                        <div class="pick-right">
                          <span class="pick-price">{{ fmt(slotTotal([{ entity, quantity: 1 }])) }}</span>
                          <template v-if="pinned[type].some(s => s.entity.id === entity.id)">
                            <div class="qty-row">
                              <button class="qty-btn" @click="adjustQty(type, entity.id, -1)">−</button>
                              <span class="qty-num">{{ pinned[type].find(s => s.entity.id === entity.id)?.quantity }}</span>
                              <button class="qty-btn"
                                :disabled="!canAddToSlot(type, entity)"
                                @click="adjustQty(type, entity.id, 1)">+</button>
                            </div>
                          </template>
                          <template v-else>
                            <button class="btn-sm btn-primary" @click="selectPin(type, entity)">เลือก</button>
                          </template>
                        </div>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div class="summary-col">

        <div class="sum-box">
          <div class="sum-title">งบประมาณ</div>
          <div class="sum-row">
            <span>กำหนด</span>
            <span>{{ budget !== null ? fmt(budget) : 'ไม่จำกัด' }}</span>
          </div>
          <div class="sum-row">
            <span>ราคารวม</span>
            <strong>{{ fmt(totalCost) }}</strong>
          </div>
          <template v-if="budget !== null">
            <div class="progress-wrap">
              <div class="progress-fill"
                :class="budgetUsedPct > 100 ? 'fill-err' : budgetUsedPct > 80 ? 'fill-warn' : 'fill-ok'"
                :style="{ width: Math.min(budgetUsedPct, 100) + '%' }"/>
            </div>
            <div class="sum-row">
              <span>คงเหลือ</span>
              <span :class="(budgetRemaining ?? 0) < 0 ? 'text-err' : 'text-ok'">
                {{ fmt(budgetRemaining ?? 0) }}
              </span>
            </div>
          </template>
        </div>

        <div v-if="powerAgg !== null && powerCap !== null" class="sum-box">
          <div class="sum-title">พลังงาน</div>
          <div class="sum-row">
            <span>รวม</span>
            <span>{{ powerAgg }}W / {{ powerCap }}W</span>
          </div>
          <div class="progress-wrap">
            <div class="progress-fill"
              :class="powerPct > 100 ? 'fill-err' : powerPct > 80 ? 'fill-warn' : 'fill-ok'"
              :style="{ width: Math.min(powerPct, 100) + '%' }"/>
          </div>
        </div>

        <div v-if="issues.length" class="sum-box">
          <div class="sum-title">ปัญหาที่พบ</div>
          <div v-for="(issue, i) in issues" :key="i"
            class="issue-row" :class="'issue-' + issue.severity">
            <span class="issue-icon">{{ issue.severity === 'error' ? '✗' : '△' }}</span>
            <div>
              <div>{{ issue.message }}</div>
              <div v-if="issue.resolution" class="text-muted">{{ issue.resolution }}</div>
            </div>
          </div>
        </div>

        <div v-if="bom.length" class="sum-box">
          <div class="sum-title">รายการสั่งซื้อ</div>
          <table class="bom-tbl">
            <tr v-for="item in bom" :key="item.line_number">
              <td>{{ item.entity.name }}</td>
              <td class="bom-qty">×{{ item.quantity }}</td>
              <td class="bom-p">{{ fmt(item.total_cost) }}</td>
            </tr>
            <tr class="bom-sum">
              <td colspan="2">รวม</td>
              <td class="bom-p">{{ fmt(totalCost) }}</td>
            </tr>
          </table>
        </div>

      </div>
    </div>
  </div>
</template>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: #f5f5f5; color: #1a1a1a;
  font-family: 'IBM Plex Sans Thai', system-ui, sans-serif;
  font-size: 14px; line-height: 1.5;
}
</style>

<style scoped>
/* ─── Layout ─────────────────────────────────────── */
.app { min-height: 100vh; display: flex; flex-direction: column; background: #f5f5f5; }
.topbar { background: #fff; border-bottom: 1px solid #ddd; padding: 10px 20px;
  display: flex; justify-content: space-between; align-items: center; }
.app-name { font-weight: 600; font-size: 15px; }
.toolbar { background: #fff; border-bottom: 1px solid #ddd; padding: 10px 20px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.field-label { font-size: 12px; color: #666; white-space: nowrap; }
.budget-input { padding: 5px 10px; border: 1px solid #ccc; border-radius: 4px;
  font-size: 14px; width: 140px; outline: none; }
.budget-input:focus { border-color: #555; }
.presets { display: flex; gap: 4px; }
.body { display: grid; grid-template-columns: 1fr 280px; flex: 1; align-items: start; gap: 0; }

/* ─── Slots table ────────────────────────────────── */
.slots-col { padding: 16px; }
.slot-table { width: 100%; border-collapse: collapse; background: #fff;
  border: 1px solid #ddd; border-radius: 6px; overflow: hidden; }
.slot-table th { text-align: left; padding: 8px 12px; font-size: 11px;
  color: #666; border-bottom: 1px solid #ddd; background: #fafafa; font-weight: 500; }
.slot-tr td { padding: 10px 12px; border-bottom: 1px solid #eee; vertical-align: middle; }
.slot-tr:last-child td { border-bottom: none; }
.slot-tr.tr-pinned   { background: #f0f4ff; }
.slot-tr.tr-excluded { background: #fff5f5; opacity: 0.7; }
.td-type  { font-size: 12px; color: #555; white-space: nowrap; width: 100px; }
.td-name  { font-size: 13px; font-weight: 500; }
.td-price { font-size: 13px; text-align: right; white-space: nowrap; width: 100px; }
.td-status { width: 70px; }
.td-action { white-space: nowrap; width: 120px; }
.text-muted { color: #999; font-weight: 400; font-style: italic; }
.text-ok  { color: #2a9d5c; }
.text-err { color: #cc3333; }
.qty-badge { font-size: 12px; color: #444; margin-left: 4px; }
.slot-item-row { line-height: 1.6; }

/* ─── Badges ─────────────────────────────────────── */
.badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 500; }
.badge.pin  { background: #ddeaff; color: #2255bb; }
.badge.auto { background: #eee;    color: #666; }
.badge.err  { background: #ffe0e0; color: #cc3333; }

/* ─── Picker ─────────────────────────────────────── */
.picker-tr { background: #f9f9f9; }
.picker-td { padding: 0 !important; }
.picker { border-top: 2px solid #555; }
.picker-head { display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px; background: #f0f0f0; border-bottom: 1px solid #ddd; }
.picker-head span { font-size: 13px; font-weight: 500; }
.picker-opts { padding: 6px; display: flex; flex-direction: column; gap: 2px;
  max-height: 300px; overflow-y: auto; }
.pick-row { display: flex; justify-content: space-between; align-items: center;
  padding: 8px 10px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; }
.pick-row:hover { background: #f0f0f0; }
.pick-row.pick-active { background: #eaf0ff; border-color: #4477dd; }
.pick-row-exclude:hover { background: #fff0f0; }
.pick-row-exclude.pick-active { background: #ffe8e8; border-color: #cc3333; }
.pick-divider { height: 1px; background: #ddd; margin: 4px 0; }
.pick-name { flex: 1; font-size: 13px; cursor: pointer; }
.pick-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.pick-price { font-size: 12px; color: #444; }
.pick-check { font-size: 14px; color: #2255bb; width: 16px; text-align: center; }

/* ─── Qty ────────────────────────────────────────── */
.qty-row { display: flex; align-items: center; gap: 4px; }
.qty-btn { width: 24px; height: 24px; border: 1px solid #bbb; background: #fff;
  border-radius: 3px; cursor: pointer; font-size: 14px; }
.qty-btn:hover:not(:disabled) { border-color: #555; background: #f0f0f0; }
.qty-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.qty-num { min-width: 20px; text-align: center; font-weight: 600; }

/* ─── Buttons ────────────────────────────────────── */
.btn-sm { font-size: 12px; padding: 4px 10px; border: 1px solid #ccc;
  border-radius: 4px; background: #fff; cursor: pointer; color: #333; }
.btn-sm:hover { background: #f0f0f0; border-color: #999; }
.btn-sm.btn-active { background: #333; color: #fff; border-color: #333; }
.btn-sm.btn-primary { background: #333; color: #fff; border-color: #333; }
.btn-sm.btn-primary:hover { background: #111; }
.btn-sm.btn-ghost { background: none; border-color: transparent; color: #888; }
.btn-sm.btn-ghost:hover { color: #cc3333; border-color: #cc3333; }

/* ─── Summary ────────────────────────────────────── */
.summary-col { padding: 16px 16px 16px 0; display: flex; flex-direction: column; gap: 10px; }
.sum-box { background: #fff; border: 1px solid #ddd; border-radius: 6px;
  padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.sum-title { font-size: 11px; font-weight: 600; color: #666; text-transform: uppercase;
  letter-spacing: 0.05em; padding-bottom: 4px; border-bottom: 1px solid #eee; }
.sum-row { display: flex; justify-content: space-between; font-size: 13px; }
.progress-wrap { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.fill-ok   { background: #2a9d5c; }
.fill-warn { background: #e8a020; }
.fill-err  { background: #cc3333; }

/* ─── Issues ─────────────────────────────────────── */
.issue-row { display: flex; gap: 8px; padding: 6px 8px; border-radius: 4px;
  font-size: 12px; border-left: 3px solid; }
.issue-error   { background: #fff0f0; border-color: #cc3333; }
.issue-warning { background: #fffae0; border-color: #e8a020; }
.issue-icon { flex-shrink: 0; padding-top: 1px; }

/* ─── BOM ────────────────────────────────────────── */
.bom-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.bom-tbl td { padding: 4px 0; border-bottom: 1px solid #eee; }
.bom-qty { color: #666; padding-left: 8px; }
.bom-p { text-align: right; white-space: nowrap; }
.bom-sum td { border-bottom: none; font-weight: 600; padding-top: 8px; }

@media (max-width: 720px) {
  .body { grid-template-columns: 1fr; }
  .summary-col { padding: 0 16px 16px; }
}
</style>

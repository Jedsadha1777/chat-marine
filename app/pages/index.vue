<script setup lang="ts">
import type { Entity } from '~/data/types'
import { ENTITY_TYPE_LABELS, type EntityType } from '~/data/entities'

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
  exclude,
  excluded,
  clearAll,
  compatibleEntitiesFor,
} = useSimulation()

const SLOT_ORDER: EntityType[] = ['gpu', 'cpu', 'motherboard', 'ram', 'psu']

const expandedSlot = ref<EntityType | null>(null)

function toggleExpand(type: EntityType) {
  expandedSlot.value = expandedSlot.value === type ? null : type
}

function selectPin(type: EntityType, entity: Entity | null) {
  pin(type, entity)
  expandedSlot.value = null
}

function selectExclude(type: EntityType) {
  exclude(type, true)
  expandedSlot.value = null
}

function selectAuto(type: EntityType) {
  pin(type, null)
  exclude(type, false)
  expandedSlot.value = null
}

const budgetInput = ref<string>('')

watch(budgetInput, (val) => {
  const n = Number(val)
  budget.value = val === '' || isNaN(n) ? null : n
})

const PRESETS = [15000, 20000, 30000, 50000, 80000]

// ข้อ 5: ใช้ Intl.NumberFormat แทน hardcode ฿ เพื่อรองรับ locale/currency อื่นในอนาคต
const currencyFmt = new Intl.NumberFormat('th-TH', {
  style:    'currency',
  currency: 'THB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

function fmt(value: number): string {
  return currencyFmt.format(value)
}

function setPreset(p: number) {
  budgetInput.value = String(p)
}

// power bar จาก aggregateDetail ของ rule engine
const powerAgg  = computed(() => aggregateDetail.value?.aggregate_value ?? null)
const powerCap  = computed(() => aggregateDetail.value?.capacity_value  ?? null)
const powerPct  = computed(() => {
  if (powerAgg.value === null || powerCap.value === null || powerCap.value === 0) return 0
  return Math.min((powerAgg.value / powerCap.value) * 100, 100)
})
</script>

<template>
  <div class="app">

    <header class="header">
      <div class="logo">CMS</div>
      <div class="header-text">
        <span class="header-title">Compatibility Matrix</span>
        <span class="header-sub">Budget Builder Demo</span>
      </div>
      <button class="btn-reset" @click="clearAll(); budgetInput = ''">↺ Reset</button>
    </header>

    <section class="input-row">
      <div class="input-group">
        <label class="input-label">งบประมาณ (THB)</label>
        <input
          v-model="budgetInput"
          type="number"
          step="1000"
          min="0"
          placeholder="ไม่จำกัดงบ"
          class="budget-input"
        />
      </div>

      <div class="presets">
        <button
          v-for="p in PRESETS" :key="p"
          class="preset" :class="{ active: budget === p }"
          @click="setPreset(p)"
        >฿{{ (p / 1000).toFixed(0) }}K</button>
      </div>

      <div class="input-hint">
        {{ budget === null ? 'ไม่ได้กำหนดงบ — แสดงชิ้นส่วนที่ดีที่สุด' : `งบ ${fmt(budget!)}` }}
      </div>
    </section>

    <main class="main">

      <section class="slots-section">
        <div class="section-title">ผลลัพธ์ที่แนะนำ</div>

        <div class="slots">
          <div v-for="type in SLOT_ORDER" :key="type" class="slot-block">

            <div class="slot-row"
              :class="{
                'slot-row--pinned':    !!pinned[type],
                'slot-row--suggested': !pinned[type] && !!suggestion[type] && !excluded[type],
                'slot-row--excluded':  excluded[type],
              }"
            >
              <div class="slot-meta">
                <span class="slot-type">{{ ENTITY_TYPE_LABELS[type] }}</span>
                <span v-if="excluded[type]"                        class="badge badge--excluded">— ไม่ใช้</span>
                <span v-else-if="pinned[type]"                    class="badge badge--pinned">📌 pinned</span>
                <span v-else-if="suggestion[type]"                class="badge badge--suggested">✦ แนะนำ</span>
              </div>

              <div class="slot-result">
                <template v-if="excluded[type]">
                  <span class="slot-empty slot-empty--excluded">ไม่รวมในชุดนี้</span>
                </template>
                <template v-else-if="suggestion[type]">
                  <span class="slot-name">{{ suggestion[type]!.name }}</span>
                  <div class="slot-tags">
                    <span v-if="suggestion[type]!.attributes.socket" class="tag">
                      {{ suggestion[type]!.attributes.socket }}
                    </span>
                    <span v-if="suggestion[type]!.attributes.ram_type" class="tag">
                      {{ Array.isArray(suggestion[type]!.attributes.ram_type)
                        ? (suggestion[type]!.attributes.ram_type as string[]).join('/')
                        : suggestion[type]!.attributes.ram_type }}
                    </span>
                    <span v-if="suggestion[type]!.attributes.watt_output" class="tag tag-psu">
                      {{ suggestion[type]!.attributes.watt_output }}W
                    </span>
                    <span v-if="suggestion[type]!.attributes.power_draw_w || suggestion[type]!.attributes.tdp_w" class="tag tag-power">
                      {{ suggestion[type]!.attributes.power_draw_w ?? suggestion[type]!.attributes.tdp_w }}W
                    </span>
                    <span v-if="suggestion[type]!.attributes.cores" class="tag">
                      {{ suggestion[type]!.attributes.cores }} cores
                    </span>
                  </div>
                </template>
                <template v-else>
                  <span class="slot-empty">— ไม่มีในงบ —</span>
                </template>
              </div>

              <div class="slot-right">
                <span v-if="suggestion[type]" class="slot-price">
                  {{ fmt(Number(suggestion[type]!.attributes.unit_cost ?? 0)) }}
                </span>
                <button class="btn-pin" @click="toggleExpand(type)">
                  {{ expandedSlot === type ? '▲' : (pinned[type] ? '✎' : '📌') }}
                </button>
                <button v-if="pinned[type]" class="btn-unpin" @click="pin(type, null)" title="ยกเลิก pin">✕</button>
              </div>
            </div>

            <div v-if="expandedSlot === type" class="pin-picker">
              <div class="pin-picker-title">
                {{ pinned[type] ? '📌 pinned — เปลี่ยนหรือยกเลิก' : 'เลือก pin ' + ENTITY_TYPE_LABELS[type] }}
              </div>
              <button class="pin-option pin-option--auto" :class="{ active: !pinned[type] && !excluded[type] }" @click="selectAuto(type)">
                ✦ ให้ระบบเลือก
              </button>
              <button class="pin-option pin-option--exclude" :class="{ active: excluded[type] }" @click="selectExclude(type)">
                ✕ ไม่ใช้ชิ้นส่วนนี้
              </button>
              <button
                v-for="entity in compatibleEntitiesFor(type)"
                :key="entity.id"
                class="pin-option"
                :class="{ active: pinned[type]?.id === entity.id }"
                @click="selectPin(type, entity)"
              >
                <span class="pin-opt-name">{{ entity.name }}</span>
                <span class="pin-opt-price">{{ fmt(Number(entity.attributes.unit_cost ?? 0)) }}</span>
              </button>
            </div>

          </div>
        </div>
      </section>

      <aside class="summary">

        <div class="card">
          <div class="card-title">งบประมาณ</div>
          <div class="summary-row">
            <span class="summary-label">กำหนดงบ</span>
            <span class="summary-val">{{ budget !== null ? `${fmt(budget!)}` : 'ไม่จำกัด' }}</span>
          </div>
          <div class="summary-row">
            <span class="summary-label">ราคารวม</span>
            <span class="summary-val">{{ fmt(totalCost) }}</span>
          </div>
          <template v-if="budget !== null">
            <div class="bar-wrap">
              <div class="bar-fill"
                :class="{
                  'bar-ok':   budgetUsedPct <= 80,
                  'bar-warn': budgetUsedPct > 80 && budgetUsedPct <= 100,
                  'bar-over': budgetUsedPct > 100,
                }"
                :style="{ width: budgetUsedPct + '%' }"
              />
            </div>
            <div class="summary-row">
              <span class="summary-label">คงเหลือ</span>
              <span class="summary-val"
                :class="(budgetRemaining ?? 0) < 0 ? 'summary-val--over' : 'summary-val--ok'">
                {{ fmt((budgetRemaining ?? 0)) }}
              </span>
            </div>
          </template>
        </div>

        <!-- power bar — ค่ามาจาก aggregateDetail ของ rule engine ไม่ใช่คำนวณเอง -->
        <div v-if="powerAgg !== null && powerCap !== null" class="card">
          <div class="card-title">Power (จาก rule engine)</div>
          <div class="summary-row">
            <span class="summary-label">รวม</span>
            <span class="summary-val">{{ powerAgg }}W / {{ powerCap }}W</span>
          </div>
          <div class="bar-wrap">
            <div class="bar-fill"
              :class="{
                'bar-ok':   powerPct <= 80,
                'bar-warn': powerPct > 80 && powerPct <= 100,
                'bar-over': powerPct > 100,
              }"
              :style="{ width: powerPct + '%' }"
            />
          </div>
          <div class="summary-row">
            <span class="summary-label">utilization</span>
            <span class="summary-val">{{ aggregateDetail?.utilization_pct }}%</span>
          </div>
        </div>

        <div v-if="issues.length" class="card">
          <div class="card-title">Validation</div>
          <div
            v-for="(issue, i) in issues" :key="i"
            class="issue" :class="`issue-${issue.severity}`"
          >
            <span class="issue-icon">{{ issue.severity === 'error' ? '✗' : '△' }}</span>
            <div>
              <div class="issue-msg">{{ issue.message }}</div>
              <div v-if="issue.resolution" class="issue-res">→ {{ issue.resolution }}</div>
            </div>
          </div>
        </div>

        <div v-if="bom.length" class="card">
          <div class="card-title">Bill of Materials</div>
          <table class="bom-table">
            <tbody>
            <tr v-for="item in bom" :key="item.line_number" class="bom-row">
              <td class="bom-line">{{ item.line_number }}</td>
              <td class="bom-name">{{ item.entity.name }}</td>
              <td class="bom-price">{{ fmt(item.unit_cost) }}</td>
            </tr>
            </tbody>
            <tfoot>
            <tr class="bom-total-row">
              <td colspan="2" class="bom-total-label">รวม</td>
              <td class="bom-total-val">{{ fmt(totalCost) }}</td>
            </tr>
            </tfoot>
          </table>
        </div>

        <button class="btn-reset-sm" @click="clearAll(); budgetInput = ''">↺ Reset</button>

      </aside>
    </main>
  </div>
</template>

<style>
:root {
  --bg: #0d0e10; --surface: #141517; --surface2: #1a1c1f;
  --border: #252729; --border2: #2e3033;
  --text: #e2e4e8; --muted: #5c6370;
  --accent: #4f8ef7; --accent-dim: rgba(79,142,247,0.12);
  --ok: #3ecf8e; --warn: #f5a623; --err: #f26d6d;
  --err-bg: rgba(242,109,109,0.08); --warn-bg: rgba(245,166,35,0.08);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: var(--bg); color: var(--text);
  font-family: 'IBM Plex Sans Thai', 'IBM Plex Sans', system-ui, sans-serif;
  font-size: 14px; line-height: 1.6; min-height: 100vh;
}
</style>

<style scoped>
.app { display: flex; flex-direction: column; min-height: 100vh; }
.header { display: flex; align-items: center; gap: 12px; padding: 13px 24px; border-bottom: 1px solid var(--border); }
.logo { font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; padding: 3px 7px; border: 1px solid var(--accent); border-radius: 3px; color: var(--accent); }
.header-text { display: flex; flex-direction: column; flex: 1; }
.header-title { font-size: 14px; font-weight: 600; }
.header-sub { font-size: 10px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
.btn-reset { font-size: 11px; padding: 5px 11px; background: none; border: 1px solid var(--border2); border-radius: 4px; color: var(--muted); cursor: pointer; }
.btn-reset:hover { border-color: var(--accent); color: var(--accent); }
.input-row { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.input-group { display: flex; flex-direction: column; gap: 3px; }
.input-label { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
.budget-input { width: 160px; padding: 6px 10px; background: var(--surface2); border: 1px solid var(--border2); border-radius: 4px; color: var(--text); font-family: 'IBM Plex Mono', monospace; font-size: 14px; outline: none; }
.budget-input:focus { border-color: var(--accent); }
.budget-input::placeholder { color: var(--muted); font-size: 12px; }
.presets { display: flex; gap: 5px; flex-wrap: wrap; }
.preset { font-family: 'IBM Plex Mono', monospace; font-size: 11px; padding: 5px 10px; background: var(--surface2); border: 1px solid var(--border2); border-radius: 3px; color: var(--muted); cursor: pointer; transition: all 0.15s; }
.preset:hover, .preset.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.input-hint { font-size: 11px; color: var(--muted); }
.main { display: grid; grid-template-columns: 1fr 280px; flex: 1; align-items: start; }
.slots-section { padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.section-title { font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.slots { display: flex; flex-direction: column; gap: 6px; }
.slot-block { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.slot-row { display: grid; grid-template-columns: 130px 1fr auto; gap: 12px; align-items: center; padding: 12px 14px; background: var(--surface); }
.slot-row--pinned    { background: rgba(79,142,247,0.07); border-left: 3px solid var(--accent); }
.slot-row--suggested { background: var(--surface); border-left: 3px solid var(--border2); }
.slot-row--excluded  { background: var(--surface); border-left: 3px solid var(--err); opacity: 0.55; }
.slot-meta { display: flex; flex-direction: column; gap: 3px; }
.slot-type { font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent); }
.badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; }
.badge--pinned    { background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent); }
.badge--suggested { color: var(--muted); }
.badge--excluded  { color: var(--err); }
.slot-result { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.slot-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slot-empty { font-size: 12px; color: var(--muted); font-style: italic; }
.slot-empty--excluded { color: var(--err); opacity: 0.7; }
.slot-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.tag { font-family: 'IBM Plex Mono', monospace; font-size: 9px; padding: 1px 5px; border-radius: 3px; background: var(--surface2); border: 1px solid var(--border2); color: var(--muted); }
.tag-power { background: rgba(245,166,35,0.1); border-color: rgba(245,166,35,0.3); color: var(--warn); }
.tag-psu   { background: rgba(62,207,142,0.1); border-color: rgba(62,207,142,0.3); color: var(--ok); }
.slot-right { display: flex; align-items: center; gap: 6px; }
.slot-price { font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600; color: var(--ok); white-space: nowrap; }
.btn-pin   { font-size: 12px; background: none; border: 1px solid var(--border2); border-radius: 3px; padding: 3px 7px; cursor: pointer; color: var(--muted); }
.btn-pin:hover { border-color: var(--accent); color: var(--accent); }
.btn-unpin { font-size: 11px; background: none; border: none; color: var(--muted); cursor: pointer; padding: 2px; }
.btn-unpin:hover { color: var(--err); }
.pin-picker { border-top: 1px solid var(--border); background: var(--bg); padding: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow-y: auto; }
.pin-picker-title { font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); padding: 2px 4px 6px; }
.pin-option { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; text-align: left; gap: 8px; transition: border-color 0.1s; }
.pin-option:hover { border-color: var(--border2); background: var(--surface2); }
.pin-option.active { border-color: var(--accent); background: var(--accent-dim); }
.pin-option--auto    { color: var(--ok);   font-size: 12px; justify-content: center; }
.pin-option--exclude { color: var(--err);  font-size: 12px; justify-content: center; border-color: rgba(242,109,109,0.3); }
.pin-option--exclude.active { background: rgba(242,109,109,0.1); border-color: var(--err); }
.pin-opt-name { font-size: 12px; }
.pin-opt-price { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--ok); flex-shrink: 0; }
.summary { border-left: 1px solid var(--border); padding: 14px; display: flex; flex-direction: column; gap: 12px; position: sticky; top: 0; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.card-title { font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent); margin-bottom: 2px; }
.summary-row { display: flex; justify-content: space-between; align-items: center; }
.summary-label { font-size: 11px; color: var(--muted); }
.summary-val { font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
.summary-val--ok   { color: var(--ok); }
.summary-val--over { color: var(--err); }
.bar-wrap { height: 4px; background: var(--border2); border-radius: 2px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s ease, background 0.3s; }
.bar-ok   { background: var(--ok); }
.bar-warn { background: var(--warn); }
.bar-over { background: var(--err); }
.issue { display: flex; gap: 7px; padding: 7px 9px; border-radius: 4px; border-left: 2px solid; font-size: 11px; }
.issue-error   { background: var(--err-bg);  border-color: var(--err); }
.issue-warning { background: var(--warn-bg); border-color: var(--warn); }
.issue-icon { flex-shrink: 0; line-height: 1.5; }
.issue-error   .issue-icon { color: var(--err); }
.issue-warning .issue-icon { color: var(--warn); }
.issue-msg { line-height: 1.5; }
.issue-res { color: var(--muted); margin-top: 2px; }
.bom-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.bom-row td { padding: 4px 2px; border-bottom: 1px solid var(--border); }
.bom-line { font-family: 'IBM Plex Mono', monospace; color: var(--muted); width: 24px; }
.bom-name { color: var(--muted); }
.bom-price { font-family: 'IBM Plex Mono', monospace; text-align: right; white-space: nowrap; }
.bom-total-row td { padding-top: 8px; border-top: 2px solid var(--border2); }
.bom-total-label { font-weight: 600; font-size: 12px; }
.bom-total-val { font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 700; color: var(--accent); text-align: right; }
.btn-reset-sm { font-size: 11px; padding: 5px 11px; background: none; border: 1px solid var(--border2); border-radius: 4px; color: var(--muted); cursor: pointer; align-self: flex-start; }
.btn-reset-sm:hover { border-color: var(--accent); color: var(--accent); }
@media (max-width: 720px) {
  .main { grid-template-columns: 1fr; }
  .summary { border-left: none; border-top: 1px solid var(--border); position: static; }
  .slot-row { grid-template-columns: 100px 1fr auto; }
}
</style>
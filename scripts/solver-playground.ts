/**
 * Local playground for the marine-power CP-SAT lab.
 * Run:  npm run play:solver   →  http://127.0.0.1:5177
 * Lab-only dev harness — never imported by app/ or server/.
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Entity } from '~/data/types'
import type { DomainConfig } from '~/engine/suggest'
import { validateItems, toSimItems } from '~/engine/suggest'
import { cpsatSolve } from '~/engine/strategies/cpsat/index'
import { explainInfeasible } from '~/engine/strategies/cpsat/explain'
import type { SolverObjective } from '~/engine/engine-types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CFG = JSON.parse(readFileSync(join(ROOT, 'app/domains/marine-power.json'), 'utf-8')) as DomainConfig
const ENTITIES = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/marine-power.entities.json'), 'utf-8')) as Entity[]

const sumAttr = (slots: Record<string, { entity: Entity; quantity: number }[]>, type: string, attr: string): number =>
  (slots[type] ?? []).reduce((s, i) => s + Number(i.entity.attributes[attr] ?? 0) * i.quantity, 0)

async function solve(budget: number | null, objective: SolverObjective) {
  const t0 = performance.now()
  const r = await cpsatSolve({ cfg: CFG, entities: ENTITIES, budget, objective })
  const ms = Math.round(performance.now() - t0)

  if (r.status !== 'optimal') {
    const floor = await cpsatSolve({ cfg: CFG, entities: ENTITIES, budget: null, objective: { mode: 'min_cost' } })
    const hints = await explainInfeasible({ cfg: CFG, entities: ENTITIES, budget, objective })
    return { status: r.status, ms, minFeasibleCost: floor.status === 'optimal' ? floor.totalCost : null, hints }
  }

  const issues = validateItems(toSimItems(r.slots, CFG), CFG)
  const controllerMax = Number(r.slots['charge_controller']?.[0]?.entity.attributes['max_input_w'] ?? 0)
  return {
    status: r.status,
    ms,
    totalCost: r.totalCost,
    objectiveValue: r.objectiveValue,
    issues,
    slots: Object.fromEntries(
      Object.entries(r.slots).map(([t, items]) => [
        t,
        items.map((i) => ({
          code: i.entity.code, name: i.entity.name, quantity: i.quantity,
          unit_cost: Number(i.entity.attributes['unit_cost'] ?? 0),
        })),
      ]),
    ),
    meters: [
      { label: 'Usable capacity (Ah)', value: sumAttr(r.slots, 'battery', 'usable_ah'), limit: 240, dir: 'min' },
      { label: 'Solar yield (Ah/day)', value: sumAttr(r.slots, 'solar_panel', 'daily_ah_yield'), limit: 132, dir: 'min' },
      { label: 'Controller load (W)', value: sumAttr(r.slots, 'solar_panel', 'watt_rating'), limit: controllerMax, dir: 'max' },
      { label: 'Deck area (m²)', value: Math.round(sumAttr(r.slots, 'solar_panel', 'area_m2') * 100) / 100, limit: 4.0, dir: 'max' },
      { label: 'Weight (kg)', value: Math.round((sumAttr(r.slots, 'battery', 'weight_kg') + sumAttr(r.slots, 'solar_panel', 'weight_kg')) * 10) / 10, limit: 160, dir: 'max' },
    ],
  }
}

const HTML = `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marine Power — CP-SAT Playground</title>
<style>
* { box-sizing: border-box; margin: 0; }
body { font-family: 'IBM Plex Sans Thai', system-ui, sans-serif; background: #f5f5f5; color: #1a1a1a; font-size: 14px; padding: 24px; max-width: 760px; margin: 0 auto; }
h1 { font-size: 18px; margin-bottom: 4px; }
.sub { color: #888; font-size: 12px; margin-bottom: 16px; }
.card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
input[type=number] { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; width: 130px; font-size: 14px; }
button { padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; font-family: inherit; }
button:hover { background: #f0f0f0; }
button.primary { background: #333; color: #fff; border-color: #333; }
button.active { background: #333; color: #fff; border-color: #333; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td, th { padding: 7px 8px; border-bottom: 1px solid #eee; text-align: left; }
td.r, th.r { text-align: right; }
.banner { padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-weight: 600; }
.banner.ok { background: #e8f5e9; color: #2a6a3a; }
.banner.bad { background: #ffe8e8; color: #cc3333; }
.meter { margin: 8px 0; }
.meter .lbl { display: flex; justify-content: space-between; font-size: 12px; color: #555; margin-bottom: 3px; }
.bar { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; }
.bar > div { height: 100%; border-radius: 3px; }
.muted { color: #999; font-size: 12px; }
</style></head><body>
<h1>⛵ Marine Power — CP-SAT Playground</h1>
<div class="sub">MILP (HiGHS) บน domain ระบบไฟฟ้าเรือ — quantity sizing + capacity 5 มิติ + objective จริง</div>

<div class="card">
  <div class="row">
    <label>งบ (฿)</label>
    <input id="budget" type="number" step="5000" value="60000">
    <span id="presets"></span>
  </div>
  <div class="row" style="margin-top:10px">
    <label>Objective</label>
    <button id="obj-min" class="active" onclick="setObj('min')">ถูกสุดที่ผ่านทุกเงื่อนไข</button>
    <button id="obj-max" onclick="setObj('max')">แบตอึดสุดในงบ</button>
    <button class="primary" onclick="solve()" style="margin-left:auto">Solve</button>
  </div>
</div>

<div id="out"></div>

<script>
let obj = 'min'
const PRESETS = [45000, 60000, 80000, 100000, 150000]
document.getElementById('presets').innerHTML = PRESETS.map(p =>
  '<button onclick="document.getElementById(\\'budget\\').value=' + p + ';solve()">' + (p/1000) + 'k</button>').join(' ')

function setObj(o) {
  obj = o
  document.getElementById('obj-min').classList.toggle('active', o === 'min')
  document.getElementById('obj-max').classList.toggle('active', o === 'max')
  solve()
}

const fmt = (n) => Number(n).toLocaleString('th-TH')
const LABELS = { battery: 'Battery Bank', solar_panel: 'Solar Panel', charge_controller: 'Charge Controller', inverter: 'Inverter' }

async function solve() {
  const budget = Number(document.getElementById('budget').value) || null
  const out = document.getElementById('out')
  out.innerHTML = '<div class="card muted">กำลัง solve…</div>'
  const objective = obj === 'min' ? { mode: 'min_cost' } : { mode: 'max_attribute', type: 'battery', attribute: 'usable_ah' }
  const res = await fetch('/api/solve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ budget, objective }) })
  const d = await res.json()

  if (d.status !== 'optimal') {
    out.innerHTML = '<div class="card"><div class="banner bad">พิสูจน์แล้ว: งบนี้เป็นไปไม่ได้ (infeasible)</div>' +
      (d.minFeasibleCost ? '<div>ชุดที่ถูกที่สุดที่ผ่านทุกเงื่อนไขอยู่ที่ <b>' + fmt(d.minFeasibleCost) + ' ฿</b></div>' : '') +
      (d.hints && d.hints.length ? '<div class="muted" style="margin-top:6px">ผ่อนอันใดอันหนึ่งนี้ก็เป็นไปได้: ' + d.hints.join(', ') + '</div>' : '') +
      '<div class="muted" style="margin-top:6px">solve ' + d.ms + ' ms</div></div>'
    return
  }

  let rows = ''
  for (const [t, items] of Object.entries(d.slots)) {
    for (const i of items) {
      rows += '<tr><td>' + (LABELS[t] ?? t) + '</td><td>' + i.name + '</td><td class="r">×' + i.quantity + '</td><td class="r">' + fmt(i.unit_cost * i.quantity) + '</td></tr>'
    }
  }

  let meters = ''
  for (const m of d.meters) {
    const pct = m.limit > 0 ? Math.min(100, (m.value / m.limit) * 100) : 0
    const ok = m.dir === 'min' ? m.value >= m.limit : m.value <= m.limit
    meters += '<div class="meter"><div class="lbl"><span>' + m.label + '</span><span>' + m.value + ' / ' + m.limit + (m.dir === 'min' ? ' (ขั้นต่ำ)' : '') + '</span></div>' +
      '<div class="bar"><div style="width:' + pct + '%;background:' + (ok ? '#2a9d5c' : '#cc3333') + '"></div></div></div>'
  }

  const errCount = (d.issues ?? []).filter((i) => i.severity === 'error').length
  out.innerHTML = '<div class="card">' +
    '<div class="banner ok">Optimal — รวม ' + fmt(d.totalCost) + ' ฿ · validateItems: ' + errCount + ' error · solve ' + d.ms + ' ms</div>' +
    '<table><tr><th>หมวด</th><th>รุ่น</th><th class="r">จำนวน</th><th class="r">ราคา (฿)</th></tr>' + rows + '</table>' +
    '</div><div class="card"><b style="font-size:12px;color:#666">CONSTRAINTS</b>' + meters + '</div>'
}

solve()
</script></body></html>`

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/solve') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { budget, objective } = JSON.parse(body || '{}')
      const result = await solve(budget ?? null, objective ?? { mode: 'min_cost' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HTML)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
  }
})

server.listen(5177, '127.0.0.1', () => {
  console.log('⛵ Marine Power solver playground → http://127.0.0.1:5177')
})

# Adding a New Domain

A domain is a single JSON file that fully describes one use case — what entity types exist, how they relate, and how the engine builds suggestions. Switching domains requires changing **one import line** in `app/domains/index.ts`. No engine or server code needs modification.

## Prerequisites

- Your entities must be in the D1 database with the schema: `id, uuid, entity_type, code, name, status, <costColumn>, attributes (JSON)`
- `publishedStatus` must match the `status` value of entities you want available for suggestion (default: `"published"`)

---

## Step 1 — Create the domain JSON

Create `app/domains/<your-domain>.json` and add the schema reference for editor autocomplete and AI assistance:

```json
{
  "$schema": "./schema.json",

  "entityTypes":      ["part_a", "part_b", "part_c"],
  "entityTypeLabels": { "part_a": "Part A", "part_b": "Part B", "part_c": "Part C" },

  "fillOrder":      ["part_a", "part_b", "part_c"],
  "selectionOrder": ["part_b", "part_c"],

  "maxPerType": { "part_a": 1, "part_b": 1, "part_c": 1 },
  "dynamicMaxPerType": {},

  "anchorType":   "part_a",
  "requiredTypes": ["part_a", "part_b"],

  "costAttribute":   "unit_cost",
  "costColumn":      "unit_cost",
  "publishedStatus": "published",
  "costPrecision":   0,

  "aggregateDisplay":    { "primary": "AGG_MAIN", "safety": null },

  "fillStrategy": "backtrack",

  "fetchLimits": {
    "anchor": 60, "anchorNear": 20,
    "capacity": 50, "core": 25, "coreCheap": 25
  },

  "rules": []
}
```

### Key fields

| Field | ความหมาย |
|---|---|
| `anchorType` | entity หลักที่กำหนด tier ของทั้ง build — รับงบประมาณก้อนใหญ่ที่สุด |
| `fillOrder` | ลำดับ entity ใน BOM output — ต้องมีครบทุก type ใน `entityTypes` (type ที่ตกหล่นจะหายจาก BOM) |
| `selectionOrder` | ลำดับที่ backtrack fill เลือก: core types ก่อน แล้ว**ปิดท้ายด้วย `capacityType` เสมอ** (engine เลือก capacity เป็นตัวสุดท้ายแล้วหยุด — type ที่อยู่หลังจะไม่ถูกเลือก) ห้ามใส่ `anchorType` และ postFill types |
| `fetchLimits` | จำนวน rows ที่ดึงจาก D1 ต่อ category — เพิ่มเพื่อ accuracy สูงขึ้น (กระทบ billing) |
| `costColumn` | ชื่อ column ใน DB สำหรับ cost (ใช้ใน SQL ORDER BY / WHERE) |
| `publishedStatus` | ค่า `status` ของ entity ที่พร้อมใช้งาน |
| `fillStrategy` | `"backtrack"` (heuristic เร็ว, default) หรือ `"milp"` (exact solver — ดูหัวข้อ MILP ด้านล่าง) |
| `objective` | สำหรับ `milp` เท่านั้น: `{ "mode": "min_cost" }` หรือ `{ "mode": "max_attribute", "type": "...", "attribute": "..." }` |

---

## Step 2 — Capacity constraint (optional)

ถ้า domain มี entity ที่ทำหน้าที่รองรับ load (เช่น PSU รองรับ power, battery รองรับ watt-hour) ให้เพิ่ม:

```json
"capacityType":      "psu",
"capacityAttribute": "watt_output",
"loadAttributes":    ["power_draw_w", "tdp_w"],
"capacityFactor":    0.8
```

- `loadAttributes` — อ่านค่าแรกที่ไม่ null ต่อ entity (fallback chain)
- `capacityFactor` — `totalLoad / capacityFactor` = minimum capacity (0.8 = 80% rule)

---

## Step 3 — Dynamic slot counts (optional)

ถ้า entity บางประเภทมีจำนวน slot แบบ dynamic รองรับสองรูปแบบ:

### รูปแบบที่ 1 — Multi-source + aggregate

slot count อ่านจาก attribute ของ entity หนึ่งตัวหรือหลายตัว แล้วรวมด้วย `min`/`max`/`sum`

**`sources` array — แต่ละ entry คือ one (entity_type, attribute) pair เจตนาเป็น singular:**

| ต้องการอะไร | วิธีใส่ |
|---|---|
| อ่านจาก type เดียว | entry เดียว |
| อ่านจากหลาย type | entry ละหนึ่ง type |
| อ่านหลาย attribute จาก type เดียวกัน | entry ละหนึ่ง attribute (source_type ซ้ำได้) |

```json
"dynamicMaxPerType": {

  "ram": {
    "sources": [{ "source_type": "motherboard", "source_attribute": "ram_slots" }],
    "aggregate":          "min",
    "capacity_attribute": "modules",
    "sort_attribute":     "capacity_gb",
    "fallback":           2
  },

  "gpu": {
    "sources": [
      { "source_type": "motherboard", "source_attribute": "pcie_slots" },
      { "source_type": "psu",         "source_attribute": "max_gpus" }
    ],
    "aggregate": "min",
    "fallback":  1
  },

  "expansion_card": {
    "sources": [
      { "source_type": "motherboard", "source_attribute": "pcie_x16_slots" },
      { "source_type": "motherboard", "source_attribute": "pcie_x8_slots" }
    ],
    "aggregate": "sum",
    "fallback":  2
  }

}
```

- `sources[].source_type` — entity type ที่จะอ่าน (string เดียว ไม่ใช่ array); ถ้าต้องการหลาย type ให้เพิ่ม entry
- `sources[].source_attribute` — attribute บน entity นั้นที่เก็บค่า numeric
- entry ที่ยัง ไม่มีของถูกเลือก จะถูกข้าม — aggregate รันเฉพาะค่าที่มี
- `aggregate` — `min` = constraint แน่นสุด (พบบ่อยสุด), `max` = หลวมสุด, `sum` = บวกรวม
- `capacity_attribute` — attribute บน entity นี้ที่นับว่าใช้กี่ slot ต่อชิ้น (เช่น dual-channel kit = 2 modules)
- `sort_attribute` — attribute ที่ใช้เรียงลำดับตอนเลือก (สูงสุดก่อน)
- `fallback` — ค่าที่ใช้เมื่อยังไม่มี source entity ถูกเลือกเลย

### รูปแบบที่ 2 — RuleFlow formula

slot count คำนวณจาก expression — ใช้เมื่อ logic ซับซ้อนกว่าการ aggregate ตรงๆ:

```json
"dynamicMaxPerType": {
  "heatsink": {
    "formula":  "min($case_cpu_cooler_clearance_mm, $motherboard_vrm_height_mm)",
    "fallback": 1
  }
}
```

- `formula` — RuleFlow expression; ตัวแปรชื่อ `{type}_{attribute}` จาก suggestion entity ที่ถูกเลือกอยู่ เช่น `$motherboard_ram_slots`, `$case_cpu_cooler_clearance_mm`
- Built-in functions: `min()`, `max()`, `floor()`, `ceil()`, `round()`
- ถ้า formula throw หรือ input ขาด จะใช้ `fallback` แทน

---

## Step 4 — Post-fill phases (optional)

สำหรับ entity ที่ควรเลือกเป็นสองรอบ (เช่น SSD: เอาราคาถูกก่อน แล้ว upgrade ถ้างบเหลือ):

```json
"postFillTypes": [
  { "type": "ssd", "preferAttribute": "capacity_gb", "maxAttrValue": 512 },
  { "type": "ssd", "preferAttribute": "capacity_gb", "minAttrValue": 1000, "upgradeExisting": true }
]
```

- `upgradeExisting: false` (default) — เติม slot ที่ว่างหลัง backtrack
- `upgradeExisting: true` — แทนที่ของที่มีอยู่ถ้างบเหลือและเจอตัวที่ดีกว่า

---

## Step 5 — Budget formula (optional)

ค่า default คือ `round(effectiveBudget * ceil(entityCount/2) / entityCount)` ซึ่งให้งบครึ่งหนึ่งกับ anchor entity ถ้าต้องการสูตรอื่น:

```json
"budgetPlan": {
  "name": "my-domain-budget-plan", "ver": "1",
  "inputs": [
    { "name": "effectiveBudget", "type": "num" },
    { "name": "entityCount",     "type": "num" }
  ],
  "outputs": ["anchorTarget"],
  "blocks": [
    { "id": "anchor", "out": ["anchorTarget", "num"], "expr": "round($effectiveBudget * 0.4)" }
  ]
}
```

สูตรใน `expr` ใช้ `$varName` อ้าง input และ output ของ block ก่อนหน้า  
ฟังก์ชันที่ใช้ได้: `round()`, `ceil()`, `floor()`, `min()`, `max()`, `abs()`, `clamp(x, lo, hi)`, `pow(x, y)`, `sqrt(x)`  
Operators: `+ - * / % **`, เปรียบเทียบ `== != > >= < <=`, ตรรกะ `AND OR NOT` — **ไม่มี ternary/if ใน expression** (ใช้ if-block แทน)

ถ้าต้องการเงื่อนไข (เช่น งบสูง → สัดส่วน anchor สูงขึ้น) ใช้ **if-block** ร่วมกับ formula block:

```json
"budgetPlan": {
  "name": "tiered-budget-plan", "ver": "1",
  "inputs": [
    { "name": "effectiveBudget", "type": "num" },
    { "name": "entityCount",     "type": "num" }
  ],
  "outputs": ["anchorTarget"],
  "blocks": [
    {
      "id": "tier",
      "outs": [["ratio", "num", 0.5]],
      "branches": [
        ["$effectiveBudget >= 80000", { "ratio": 0.6 }],
        ["$effectiveBudget >= 40000", { "ratio": 0.55 }]
      ],
      "else": { "ratio": 0.5 }
    },
    { "id": "anchor", "out": ["anchorTarget", "num"], "expr": "round($effectiveBudget * $ratio)" }
  ]
}
```

if-block ทำงานแบบนี้: ตั้งทุก output เป็น fallback ก่อน (`outs` = `[ชื่อ, type, fallback]`) → ไล่เช็ค `branches` บนลงล่าง **เจอตัวแรกที่จริงแล้วหยุด** → ไม่เจอเลยใช้ `else` — payload เป็น object กำหนดค่า output ได้ทั้ง literal และ expression string (เช่น `"$effectiveBudget / 2"`) หากเขียน budgetPlan ผิด engine จะ fallback ไปสูตร default อัตโนมัติ (ดู error ใน log)

ลำดับ block ไม่ต้องเรียงเอง — engine เรียงตาม dependency ของ `$var` ให้อัตโนมัติ

---

## Step 6 — Compatibility rules

ใส่ใน `"rules": [...]` แต่ละ rule ต้องมี `id` ไม่ซ้ำกัน

### Pairwise rule — เปรียบ entity คู่ต่อคู่

```json
{
  "id": 1,
  "code": "SOCKET_MATCH",
  "name": "CPU and Motherboard must share the same socket",
  "check_type": "pairwise",
  "severity": "error",
  "priority": 200,
  "is_active": true,
  "scope": {
    "match_by": "shared_attribute",
    "attribute_key": "socket",
    "source_types": ["cpu"],
    "target_types": ["motherboard"]
  },
  "condition": {
    "==": [{ "var": "source.attributes.socket" }, { "var": "target.attributes.socket" }]
  },
  "message": "Socket mismatch: :source.attributes.socket ≠ :target.attributes.socket",
  "resolution": "Select a CPU and Motherboard with the same socket"
}
```

`match_by` options:

| match_by | ใช้เมื่อ |
|---|---|
| `shared_attribute` | ทั้งคู่ใช้ attribute key เดียวกันและค่าต้องตรงกัน |
| `attribute_pair` | source กับ target ใช้ attribute คนละชื่อแต่ค่าต้องตรงกัน |
| `attribute_range` | attribute ของ source ต้องอยู่ใน range ของ target |

### Aggregate rule — รวมค่าจากหลาย entity แล้วเทียบกับ capacity หรือ threshold คงที่

**`compare_to` มี 3 mode:**

| mode | ใช้เมื่อ |
|---|---|
| `entity_attribute` | เทียบกับ attribute ของ entity อื่น (เช่น watt_output ของ PSU) |
| `fixed_value` | เทียบกับตัวเลขคงที่ (เช่น minimum 240 GB) |
| `simulation_constraint` | เทียบกับค่าที่ส่งมาจาก constraints map ตอน runtime |

> **หมายเหตุ:** ถ้าไม่มี entity ของ `from_types` อยู่ใน build เลย rule จะถูก skip อัตโนมัติ (ไม่ยิง error)

**ตัวอย่าง 1 — เทียบกับ entity attribute (power vs PSU):**

```json
{
  "id": 5,
  "code": "AGG_POWER_CAPACITY",
  "name": "Total Power Must Not Exceed PSU",
  "check_type": "aggregate",
  "severity": "error",
  "priority": 200,
  "is_active": true,
  "condition": {
    "aggregate": {
      "function": "sum",
      "attribute": "power_draw_w",
      "fallback_attributes": ["tdp_w"],
      "from_types": ["*"],
      "exclude_types": ["psu"],
      "multiply_by_quantity": true
    },
    "compare_to": {
      "mode": "entity_attribute",
      "entity_type": "psu",
      "attribute": "watt_output"
    },
    "operator": "<="
  },
  "message": "Total power draw :aggregate_value W exceeds PSU capacity :capacity_value W",
  "resolution": "Select a PSU with wattage above :aggregate_value W"
}
```

**ตัวอย่าง 2 — เทียบกับ fixed threshold (SSD minimum 240 GB):**

```json
{
  "id": 9,
  "code": "SSD_MIN_CAPACITY",
  "name": "SSD Must Be At Least 240 GB",
  "check_type": "aggregate",
  "severity": "error",
  "priority": 165,
  "is_active": true,
  "condition": {
    "aggregate": {
      "function": "min",
      "attribute": "capacity_gb",
      "from_types": ["ssd"]
    },
    "compare_to": {
      "mode": "fixed_value",
      "value": 240
    },
    "operator": ">="
  },
  "message": "SSD must have at least 240 GB (current: :aggregate_value GB)",
  "resolution": "Select an SSD with 240 GB or more"
}
```

`function` options สำหรับ aggregate: `sum`, `count`, `min`, `max`, `avg`

### Tier rule — entity high-end ต้องใช้คู่กับ entity ที่รองรับ

```json
"tierRules": [
  {
    "name": "HIGH_BW_GPU_REQUIRES_HIGH_CACHE_CPU",
    "provider": {
      "entity_type": "gpu",
      "condition": { "and": [
        { ">": [{ "var": "attributes.memory_bus_bit" }, 312] },
        { ">": [{ "var": "attributes.vram_gb" }, 16] }
      ]}
    },
    "requires": [
      { "entity_type": "cpu", "condition": { ">": [{ "var": "attributes.l3_cache_mb" }, 32] } }
    ]
  }
]
```

---

## Step 7 — Wire up

แก้ไฟล์ `app/domains/index.ts` บรรทัดเดียว:

```ts
import domainJson from './<your-domain>.json'   // ← เปลี่ยนตรงนี้
```

engine, API handler, และ frontend ใช้ domain ใหม่ทันที ไม่มีไฟล์อื่นต้องแตะ

---

## MILP strategy (exact solver)

ตั้ง `"fillStrategy": "milp"` เพื่อใช้ exact Mixed-Integer Linear Programming (HiGHS WASM — รันได้ทั้ง Node และ workerd) แทน heuristic:

- **เลือกจำนวนชิ้นได้จริง** — `maxPerType > 1` กลายเป็น upper bound ของตัวแปรจำนวน (เช่น แบต 1-8 ลูก)
- **การันตี optimal** ตาม `objective` (default `min_cost`) และ**พิสูจน์ infeasible ได้** เมื่องบไม่พอ
- rule `severity: "error"` = hard constraint / rule `severity: "warning"` ที่มี `"penalty": <number>` = soft constraint (โดนปรับใน objective ตามหน่วยที่ละเมิด) / warning ที่ไม่มี penalty = solver ไม่สนใจ (validation ยังรายงานตามปกติ)
- aggregate ที่รองรับ: `sum` ทุกแบบ, `min`/`max` เฉพาะ type ที่เลือกชิ้นเดียวและ `fixed_value` — แบบอื่น throw `UNSUPPORTED`
- server จะดึง candidate **ครบชุดต่อ type** (ไม่ใช่ band sampling ของ backtrack)

ตัวอย่างเต็ม: `app/domains/marine-power.json` / ทดลองเล่น: `npm run play:solver`

---

## Checklist

- [ ] สร้าง `app/domains/<your-domain>.json` ครบ required fields
- [ ] `$schema` ชี้ไปที่ `./schema.json`
- [ ] `anchorType` และ `capacityType` (ถ้ามี) อยู่ใน `entityTypes`
- [ ] `fillOrder` ครอบคลุม entity types ทั้งหมด
- [ ] `selectionOrder` = core types + `capacityType` ปิดท้าย (ไม่มี `anchorType` / postFill types)
- [ ] แต่ละ type อยู่กลุ่มเดียว: anchor / selectionOrder / postFillTypes — ห้ามซ้ำ
- [ ] `requiredTypes` ใส่ทุก type ที่ขาดไม่ได้
- [ ] `aggregateDisplay.primary` ตรงกับ `code` ของ rule แบบ aggregate ที่มีอยู่
- [ ] rule `id` ไม่ซ้ำกันภายใน domain
- [ ] entity types ใน rule `scope`, `from_types`, `exclude_types` ตรงกับ `entityTypes`
- [ ] อัปเดต import ใน `app/domains/index.ts`

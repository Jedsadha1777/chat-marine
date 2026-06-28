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

  "aggregateGuardTypes": [],
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
| `fillOrder` | ลำดับ entity ใน BOM output |
| `selectionOrder` | ลำดับที่ backtrack fill เลือก core entities (ไม่รวม anchorType และ capacityType) |
| `fetchLimits` | จำนวน rows ที่ดึงจาก D1 ต่อ category — เพิ่มเพื่อ accuracy สูงขึ้น (กระทบ billing) |
| `costColumn` | ชื่อ column ใน DB สำหรับ cost (ใช้ใน SQL ORDER BY / WHERE) |
| `publishedStatus` | ค่า `status` ของ entity ที่พร้อมใช้งาน |

---

## Step 2 — Capacity constraint (optional)

ถ้า domain มี entity ที่ทำหน้าที่รองรับ load (เช่น PSU รองรับ power, battery รองรับ watt-hour) ให้เพิ่ม:

```json
"capacityType":      "psu",
"capacityAttribute": "watt_output",
"loadAttributes":    ["power_draw_w", "tdp_w"],
"capacityFactor":    0.8,

"aggregateGuardTypes": ["psu"]
```

- `loadAttributes` — อ่านค่าแรกที่ไม่ null ต่อ entity (fallback chain)
- `capacityFactor` — `totalLoad / capacityFactor` = minimum capacity (0.8 = 80% rule)

---

## Step 3 — Dynamic slot counts (optional)

ถ้า entity บางประเภทมีจำนวน slot แบบ dynamic รองรับสองรูปแบบ:

### รูปแบบที่ 1 — Multi-source + aggregate

slot count อ่านจาก attribute ของ entity หนึ่งตัวหรือหลายตัว แล้วรวมด้วย `min`/`max`/`sum`:

```json
"dynamicMaxPerType": {
  "ram": {
    "sources": [
      { "source_type": "motherboard", "source_attribute": "ram_slots" }
    ],
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
  }
}
```

- `sources` — รายการ (entity type, attribute) ที่จะอ่านค่า; ตัวไหนยังไม่ถูกเลือกจะถูกข้าม
- `aggregate` — วิธีรวมค่าจากหลาย source: `min` = constraint แน่นสุด, `max` = หลวมสุด, `sum` = บวกรวม
- `capacity_attribute` — attribute บน entity นี้ที่นับว่าใช้กี่ slot ต่อชิ้น (เช่น dual-channel kit = 2 modules)
- `sort_attribute` — attribute ที่ใช้เรียงลำดับตอนเลือก (สูงสุดก่อน)
- `fallback` — ค่า default ก่อนที่ source entity ถูกเลือก

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
ฟังก์ชันที่ใช้ได้: `round()`, `ceil()`, `floor()`, `min()`, `max()`, `abs()`

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

## Checklist

- [ ] สร้าง `app/domains/<your-domain>.json` ครบ required fields
- [ ] `$schema` ชี้ไปที่ `./schema.json`
- [ ] `anchorType` และ `capacityType` (ถ้ามี) อยู่ใน `entityTypes`
- [ ] `fillOrder` และ `selectionOrder` ครอบคลุม entity types ทั้งหมด
- [ ] `requiredTypes` ใส่ทุก type ที่ขาดไม่ได้
- [ ] `aggregateDisplay.primary` ตรงกับ `code` ของ rule ที่มีอยู่
- [ ] rule `id` ไม่ซ้ำกันภายใน domain
- [ ] entity types ใน rule `scope`, `from_types`, `exclude_types` ตรงกับ `entityTypes`
- [ ] อัปเดต import ใน `app/domains/index.ts`

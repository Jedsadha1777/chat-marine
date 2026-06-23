# Adding a New Domain

A "domain" is a JSON config file that describes what entity types exist, how they relate, and how the engine should build suggestions. No handler code needs changing — only the JSON and one import line.

## Step 1 — Create the domain JSON

Create `app/domains/<your-domain>.json`. Minimum required fields:

```json
{
  "entityTypes":      ["type_a", "type_b", "type_c"],
  "entityTypeLabels": { "type_a": "Label A", "type_b": "Label B", "type_c": "Label C" },

  "fillOrder":    ["type_a", "type_b", "type_c"],
  "selectionOrder": ["type_b", "type_c"],

  "maxPerType":   { "type_a": 1, "type_b": 1, "type_c": 1 },

  "requiredTypes": ["type_a", "type_b"],

  "anchorType":    "type_a",
  "capacityType":  "type_c",
  "capacityAttribute": "watt_output",
  "loadAttributes":    ["power_draw_w"],
  "capacityFactor":    0.8,

  "costAttribute":  "unit_cost",
  "costPrecision":  0,

  "aggregateGuardTypes": ["type_c"],
  "aggregateDisplay":    { "primary": "AGG_POWER_CAPACITY", "safety": null },

  "fetchLimits": {
    "anchor":     60,
    "anchorNear": 20,
    "capacity":   50,
    "core":       25,
    "coreCheap":  25
  },

  "rules": []
}
```

### Key fields

| Field | ความหมาย |
|---|---|
| `fillOrder` | ลำดับที่ engine เลือก entity (ส่งผลต่อ BOM line number ด้วย) |
| `selectionOrder` | ลำดับที่ backtrack fill ทำงาน (ไม่รวม `anchorType`) |
| `anchorType` | entity หลักที่กำหนด tier ของทั้ง build — engine ลองทุก anchor แล้วเลือก fit ที่ดีสุด |
| `capacityType` | entity ที่ทำหน้าที่รองรับ load (เช่น PSU) — เลือก cheapest ที่รองรับ load ได้ |
| `capacityFactor` | `totalLoad / capacityFactor` = minimum capacity (0.8 = 80% rule) |
| `fetchLimits` | จำนวน candidates ที่ดึงจาก DB ต่อ type — เพิ่มถ้าต้องการ accuracy สูงขึ้น |

## Step 2 — Optional: dynamic slot counts

ถ้า entity บางประเภทมีจำนวนสล็อตแบบ dynamic (เช่น RAM ขึ้นอยู่กับ motherboard):

```json
"dynamicMaxPerType": {
  "ram": {
    "source_type":        "motherboard",
    "source_attribute":   "ram_slots",
    "capacity_attribute": "modules",
    "sort_attribute":     "capacity_gb",
    "fallback":           2
  }
}
```

## Step 3 — Optional: post-fill types

ถ้ามี entity ที่ควรเติมหลัง backtrack fill เสร็จ (เช่น SSD):

```json
"postFillTypes": [
  { "type": "ssd", "preferAttribute": "capacity_gb", "maxAttrValue": 512 },
  { "type": "ssd", "preferAttribute": "capacity_gb", "minAttrValue": 1000, "upgradeExisting": true }
]
```

- `upgradeExisting: false` (default) — เติมครั้งแรกหลัง backtrack
- `upgradeExisting: true` — phase 3: upgrade ถ้า budget เหลือ

## Step 4 — Add compatibility rules

ใส่ใน `"rules": [...]` ทุก rule ต้องมี field เหล่านี้:

```json
{
  "id": 1,
  "code": "UNIQUE_RULE_CODE",
  "name": "Human readable name",
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
    "==": [
      { "var": "source.attributes.socket" },
      { "var": "target.attributes.socket" }
    ]
  },
  "message": "Socket mismatch: :source.attributes.socket ≠ :target.attributes.socket",
  "resolution": "Select components with matching socket"
}
```

`check_type` มีสองแบบ:

| check_type | ใช้เมื่อ |
|---|---|
| `pairwise` | เปรียบ entity คู่ต่อคู่ (socket match, RAM type match) |
| `aggregate` | รวม attribute จากหลาย entity แล้วเทียบกับ capacity (power, RAM slots) |

ดู `pc-builder.json` เป็น reference สำหรับ aggregate rule ที่สมบูรณ์

## Step 5 — Wire up in `app/domains/index.ts`

แก้ไฟล์นี้ให้ชี้ไปที่ JSON ใหม่:

```ts
import domainJson from './<your-domain>.json'
```

เท่านี้ engine, API handler, และ frontend จะใช้ domain ใหม่ทันที ไม่มีไฟล์อื่นต้องแตะ

## Checklist

- [ ] สร้าง `app/domains/<your-domain>.json` ครบทุก required field
- [ ] `anchorType` และ `capacityType` อยู่ใน `entityTypes`
- [ ] `fillOrder` และ `selectionOrder` ครอบคลุม entity types ที่ต้องการ
- [ ] `requiredTypes` ใส่ทุก type ที่ขาดไม่ได้
- [ ] rule id ไม่ซ้ำกัน
- [ ] อัปเดต import ใน `app/domains/index.ts`

# chat-marine

Configurator engine แบบ schema-driven: เลือกชุดอุปกรณ์ที่เข้ากันได้ภายใต้งบและข้อจำกัดหลายมิติ — หนึ่ง domain = หนึ่งไฟล์ JSON ไม่ต้องแก้โค้ด engine

รันบน **Nuxt 4 + Cloudflare Pages + D1**

## Fill strategies

| Strategy | วิธีทำงาน | เหมาะกับ |
|---|---|---|
| `backtrack` (default) | Greedy heuristic + backtracking — เร็ว (~ms), เลือก 1 ชิ้น/ประเภท | Interactive UI, โจทย์ kit-picker ที่ capacity มิติเดียว |
| `milp` | Exact **Mixed-Integer Linear Programming** ผ่าน HiGHS (WASM — รันได้ทั้ง Node และ workerd) | โจทย์ที่ต้องเลือก**จำนวนชิ้น**, capacity หลายมิติ, ต้องการ optimal จริง / พิสูจน์ infeasible / top-K alternatives / soft constraints |

> หมายเหตุ: strategy `milp` เคยใช้ชื่อ `cpsat` ซึ่งไม่ตรงกับเทคโนโลยี (ไม่ใช่ OR-Tools CP-SAT) — rename แล้วทั้งระบบ

## Domains

- [`app/domains/pc-builder.json`](app/domains/pc-builder.json) — จัดสเปคคอมพิวเตอร์ (backtrack) — UI หลักของแอป
- [`app/domains/marine-power.json`](app/domains/marine-power.json) — ระบบไฟฟ้าเรือ: แบต×N, โซลาร์×N, controller, inverter ภายใต้งบ/น้ำหนัก/พื้นที่/โหลด (milp)
- สเปคการเขียน domain ใหม่: [`docs/adding-a-domain.md`](docs/adding-a-domain.md) + [`app/domains/schema.json`](app/domains/schema.json) (JSON Schema พร้อม invariants ครบ — ออกแบบให้ AI อ่านแล้วเขียน template ได้)

## Quickstart

```bash
npm install
npm test                # ทุก test suite (ruleflow 54 / greedy 14 / suggest-pool 104 / milp 39)
npm run play:solver     # MILP playground → http://127.0.0.1:5177 (ไม่ต้องมี D1)
npm run dev             # Nuxt dev — หน้า UI (API ต้องมี D1 binding)
```

Production build + ทดสอบบน workerd จริง:

```bash
npm run build
npx wrangler pages dev dist          # local workerd + D1 local
curl http://127.0.0.1:8788/api/solver-poc   # พิสูจน์ MILP solver บน CF runtime
npx wrangler pages deploy dist
```

## โครงสร้าง

```
app/
  domains/          # domain JSON + schema.json (หัวใจของระบบ)
  engine/           # pure engine — ใช้ได้ทั้ง client/server
    strategies/     #   backtrack/ (greedy) + milp/ (compiler → HiGHS → slots)
    ruleflow/       #   expression/formula evaluator (budgetPlan, dynamicMax)
    pairwise.ts     #   JSON-Logic rule evaluation
    aggregate.ts    #   aggregate rule validation
    template.ts     #   message interpolation (:var | filter)
  pages/index.vue   # UI (pc-builder)
server/
  api/              # suggest, compatible, solver-poc
  utils/            # D1 fetch plans (band-sampling สำหรับ backtrack / fetch-all สำหรับ milp)
  database/         # schema.sql, seed.sql
test/               # tsx test suites + fixtures
scripts/            # solver-playground (local dev harness)
docs/               # adding-a-domain.md + plan records
```

## ข้อควรรู้ก่อน deploy

- MILP บน production ต้องใช้ **Workers paid plan** (free tier CPU 10ms ไม่พอ — solve จริงใช้ ~100-150ms)
- `/api/solver-poc` เป็น PoC/health-check endpoint — ลบได้ถ้าไม่ต้องการ
- Marine domain ยังใช้ entities จาก fixtures (`test/fixtures/`) — ถ้าจะ serve ผ่าน `/api/suggest` ต้อง seed เข้า D1 ก่อน

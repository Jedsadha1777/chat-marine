# Solver Lab (ไม่ deploy ขึ้น Cloudflare)

MILP solver ทดลองสำหรับ domain ที่ greedy engine ทำไม่ได้ (quantity sizing, capacity หลายมิติ, objective จริง, พิสูจน์ infeasible) — รันเฉพาะ local ผ่าน test harness

## กฎเหล็ก: import ทางเดียว

`solver/` import จาก `app/engine/` ได้ — แต่ `app/` / `server/` **ห้าม import จาก `solver/` เด็ดขาด** เส้นนี้คือสิ่งเดียวที่กันโค้ดนี้ออกจาก CF bundle

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `domains/marine-power.json` | Domain ระบบไฟฟ้าเรือ — เขียนตาม `app/domains/schema.json` (ajv-valid) + `x_objective` (ส่วนขยาย lab) |
| `domains/marine-power.entities.json` | Catalog 44 รายการ (ข้อมูลสมมติ ไม่ใช่ราคาขายจริง) |
| `model-compiler.ts` | DomainConfig + entities + budget + objective → CPLEX-LP text (pure function) |
| `adapters/highs.ts` | โหลด HiGHS WASM แล้ว solve LP string |
| `cpsat-strategy.ts` | compile → solve → map กลับเป็น `slots` (async) |

## รัน

```bash
npx tsx --tsconfig test/tsconfig.json test/cpsat.ts   # เฉพาะ lab
npm test                                              # ทุก suite (ruleflow, greedy, suggest-pool, cpsat)
```

## Encoding

- `y_<id>` binary = เลือกรุ่นนี้ / `q_<id>` integer = จำนวนชิ้น (เฉพาะ type ที่ `maxPerType > 1`)
- one-hot ต่อ type (`= 1` ถ้าอยู่ใน requiredTypes)
- aggregate error rules → linear rows (`sum` ตรงๆ; `min`/`max` ได้เฉพาะ type ที่เลือกชิ้นเดียว ผ่าน trick `Σ(attr−K)·y ≥ 0`; อื่นๆ throw UNSUPPORTED)
- pairwise error rules → ประเมินด้วย `runPairwise` ตัวจริงของ engine ทุกคู่ → `y_a + y_b ≤ 1`
- objective: `min_cost` | `max_attribute` (นิยามใน `x_objective` — ยังไม่เข้า schema หลักจนกว่าจะ graduate)

## Checklist ตอน graduate ขึ้น production

- [ ] PoC HiGHS WASM บน workerd (`wrangler pages dev`) — ถ้าไม่ผ่านใช้ Cloudflare Container + OR-Tools
- [ ] เช็ค CF plan (free tier CPU 10ms ไม่พอ — ต้อง paid)
- [ ] เปลี่ยน `FillStrategy.fill()` เป็น async แล้ว wire `cpsat` เข้า registry ใน `app/engine/strategies/index.ts`
- [ ] fetch plan แบบดึง candidate ครบชุดต่อ type (ไม่ใช่ band-sampling ของ backtrack)
- [ ] ยกระดับ `x_objective` เข้า `schema.json` อย่างเป็นทางการ

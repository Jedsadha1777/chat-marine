import type { EntityType } from '~/data/entities'

// ══════════════════════════════════════════════════════════════════
//  DOMAIN CONFIG
//  แก้ไฟล์นี้เมื่อเปลี่ยน domain — ห้ามแก้ useSimulation.ts
// ══════════════════════════════════════════════════════════════════

/**
 * ลำดับการ fill แต่ละ slot
 * กฎ: capacity container ต้องอยู่ท้ายสุดเสมอ
 *
 * ตัวอย่างอื่น:
 *   Server Rack : ['server', 'switch', 'patch_panel', 'ups']
 *   ระบบท่อน้ำ  : ['pump', 'valve', 'filter', 'tank']
 */
export const FILL_ORDER: EntityType[] = ['gpu', 'cpu', 'motherboard', 'ram', 'psu']

/**
 * จำนวน entity สูงสุดต่อ 1 slot type
 * ไม่ระบุ = ไม่จำกัด (Infinity)
 *
 * ตัวอย่างอื่น:
 *   Server Rack : { rack: 1, server: 10, switch: 4, ups: 2 }
 *   ระบบท่อน้ำ  : { pump: 3, valve: 10, filter: 2, tank: 1 }
 */
export const MAX_PER_TYPE: Partial<Record<EntityType, number>> = {
  gpu:         1,
  cpu:         1,
  motherboard: 1,
  // ram: ไม่ใส่ที่นี่ — ดึงจาก DYNAMIC_MAX_PER_TYPE แทน
  psu:         1,
}

/**
 * Dynamic limit — ดึง max จาก attribute ของ entity อีกตัวใน simulation
 * ใช้สำหรับ limit ที่ขึ้นกับชิ้นส่วนอื่น เช่น ram_slots ของ MB
 *
 * source_type      : entity type ที่เป็นแหล่งข้อมูล
 * source_attribute : attribute ที่เป็นตัวกำหนด limit
 * fallback         : ค่า default ถ้าหา source entity ไม่เจอ
 *
 * ตัวอย่างอื่น:
 *   Server Rack: { server: { source_type: 'rack', source_attribute: 'total_u', fallback: 42 } }
 */
export const DYNAMIC_MAX_PER_TYPE: Partial<Record<EntityType, {
  source_type:       EntityType  // entity ที่เป็น capacity (เช่น motherboard)
  source_attribute:  string      // attribute ที่เป็น limit (เช่น ram_slots)
  capacity_attribute?: string    // attribute ของ entity ในกลุ่มที่นับต่อ unit (เช่น modules)
  fallback:          number      // ค่า default ถ้าหา source ไม่เจอ
}>> = {
  // ram: ตรวจว่า total modules (modules × qty) ≤ ram_slots ของ MB
  // capacity_attribute: 'modules' หมายถึงแต่ละ kit มีกี่ module
  ram: {
    source_type:       'motherboard',
    source_attribute:  'ram_slots',
    capacity_attribute: 'modules',
    fallback:          2,
  },
}

/**
 * โหมดการเลือก quantity เมื่อ suggestion engine fill slot ที่มีหลายชิ้น
 * ระบุเป็น global default หรือ override per-type ก็ได้
 *
 * 'unique' : เลือก entity ต่างกัน — เหมาะกับ component ที่แต่ละตัวทำหน้าที่ต่างกัน
 * 'stack'  : ซื้อ entity เดิมหลายชิ้น — เหมาะกับ RAM, storage, วัสดุ
 */
export const QUANTITY_MODE: 'unique' | 'stack' = 'unique'

/**
 * Override QUANTITY_MODE เฉพาะบาง type
 * ถ้าไม่ระบุ = ใช้ QUANTITY_MODE global
 *
 * RAM ต้องเป็น 'stack' เพราะควรซื้อยี่ห้อเดิมหลายชุด ไม่ใช่คนละยี่ห้อ
 */
export const QUANTITY_MODE_PER_TYPE: Partial<Record<EntityType, 'unique' | 'stack'>> = {
  ram: 'stack',
}

/**
 * กลยุทธ์การเลือก candidate
 *
 * 'highest_cost' : แพงสุด = best spec within budget (default)
 * 'lowest_cost'  : ถูกสุด = budget-conscious
 * 'best_fit'     : ใกล้ remaining budget มากสุด = ใช้งบเต็มที่สุด
 */
export const SELECTION_STRATEGY: 'highest_cost' | 'lowest_cost' | 'best_fit' = 'highest_cost'

/**
 * สำรองงบขั้นต่ำให้แต่ละ type ก่อนที่ greedy fill จะเริ่ม
 * ป้องกัน type ต้นๆ ใน FILL_ORDER กวาดงบจนหมด ทำให้ type ท้ายๆ ไม่มีของ
 *
 * ระบุเป็น fraction ของ budget (0.0 – 1.0)
 * ผลรวมทุก type ควร <= 1.0  —  ไม่ระบุ = 0 (ไม่สำรอง)
 *
 * ตัวอย่างอื่น:
 *   Server Rack : { ups: 0.15, rack: 0.10 }  — สำรอง 15% สำหรับ UPS เสมอ
 */
export const BUDGET_FLOOR_PER_TYPE: Partial<Record<EntityType, number>> = {
  // psu: 0.08  ← uncomment เพื่อสำรอง 8% ของงบสำหรับ PSU เสมอ
}

/**
 * slot ที่ต้องผ่าน aggregate rules ก่อนเลือก (capacity containers)
 *
 * ตัวอย่างอื่น:
 *   Server Rack : ['ups']
 *   ระบบท่อน้ำ  : ['tank']
 */
/**
 * Hard minimum floor — ห้าม scale ลงต่ำกว่านี้ไม่ว่างบจะน้อยแค่ไหน
 * ระบุเป็นราคาจริง (absolute) ไม่ใช่ fraction
 * ใช้เพื่อการันตีว่า capacity container ที่สำคัญ (เช่น PSU)
 * ยังมีงบพอซื้อของพื้นฐานอยู่เสมอ
 *
 * ตัวอย่างอื่น:
 *   Server Rack : { ups: 5000 }  — สำรองอย่างน้อย 5,000 สำหรับ UPS เสมอ
 */
export const HARD_FLOOR_MIN: Partial<Record<EntityType, number>> = {
  // psu: 2000  ← uncomment เพื่อสำรองขั้นต่ำ 2,000 สำหรับ PSU เสมอ
}

/**
 * โหมดการกระจายจำนวนใน stack mode
 *
 * 'sequential' : เติม entity อันดับ 1 ให้เต็มก่อน แล้วค่อยไป 2, 3 (เดิม)
 * 'round_robin': วนแจกทีละ 1 ชิ้นต่อ entity ไปเรื่อยๆ จนเต็ม limit หรืองบหมด
 *               ป้องกัน entity อันดับต้นๆ กวาดงบจนหมด
 *
 * ตัวอย่างอื่น:
 *   สั่งซื้อวัสดุ  : 'round_robin'  (กระจายซื้อหลายรุ่นเท่าๆ กัน)
 *   เติม storage   : 'sequential'   (เอา drive รุ่นที่ดีที่สุดให้เต็มก่อน)
 */
export const STACK_DISTRIBUTE_MODE: 'sequential' | 'round_robin' = 'sequential'

export const AGGREGATE_GUARD_TYPES: EntityType[] = ['psu', 'ram']

/**
 * Rule codes สำหรับ aggregate detail ใน UI
 * primary : error rule  — exceed capacity
 * safety  : warning rule — ใกล้ exceed / null ถ้าไม่มี
 *
 * ตัวอย่างอื่น:
 *   Server Rack : { primary: 'AGG_RACK_POWER',  safety: 'AGG_RACK_POWER_SAFETY' }
 *   ระบบท่อน้ำ  : { primary: 'AGG_FLOW_RATE',   safety: null }
 */
export const AGGREGATE_DISPLAY: { primary: string; safety: string | null } = {
  primary: 'AGG_POWER_CAPACITY',
  safety:  'AGG_POWER_SAFETY',
}

/**
 * attribute key ที่ใช้เป็นราคาของ entity
 *
 * ตัวอย่างอื่น: 'price' | 'cost_thb'
 */
export const COST_ATTRIBUTE = 'unit_cost'

/**
 * จำนวนทศนิยมสำหรับราคา
 * 0 = จำนวนเต็ม (บาท), 2 = USD, 4 = crypto
 */
export const COST_PRECISION = 0

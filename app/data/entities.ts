import type { Entity } from '~/data/types'

export const ENTITIES: Entity[] = [

  // ─── Motherboards ─────────────────────────────────────────────
  {
    id: 1,
    uuid: 'mb-001',
    entity_type: 'motherboard',
    code: 'MB-B760M-WIFI',
    name: 'MSI PRO B760M-A WIFI',
    status: 'published',
    attributes: {
      socket:            'LGA1700',
      ram_type:          'DDR5',
      ram_slots:         2,
      max_ram_gb:        96,
      max_ram_speed_mhz: 6800,
      tdp_support_w:     125,
      power_draw_w:      80,
      unit_cost:         4990,
    },
  },
  {
    id: 2,
    uuid: 'mb-002',
    entity_type: 'motherboard',
    code: 'MB-Z790-PRO',
    name: 'ASUS ROG STRIX Z790-F',
    status: 'published',
    attributes: {
      socket:            'LGA1700',
      ram_type:          'DDR5',
      ram_slots:         4,
      max_ram_gb:        192,
      max_ram_speed_mhz: 7800,
      tdp_support_w:     253,
      power_draw_w:      95,
      unit_cost:         12990,
    },
  },
  {
    id: 3,
    uuid: 'mb-003',
    entity_type: 'motherboard',
    code: 'MB-B550-AM4',
    name: 'ASUS TUF GAMING B550-PLUS',
    status: 'published',
    attributes: {
      socket:            'AM4',
      ram_type:          'DDR4',
      ram_slots:         4,
      max_ram_gb:        128,
      max_ram_speed_mhz: 4400,
      tdp_support_w:     105,
      power_draw_w:      65,
      unit_cost:         3990,
    },
  },

  // ─── CPUs ──────────────────────────────────────────────────────
  // ใช้ค่า Max Turbo Power (PL2) ไม่ใช่ Base TDP
  // เพื่อให้ PSU selection คำนวณได้ถูกต้องภายใต้ load จริง
  {
    id: 4,
    uuid: 'cpu-001',
    entity_type: 'cpu',
    code: 'CPU-I5-13600K',
    name: 'Intel Core i5-13600K',
    status: 'published',
    attributes: {
      socket:         'LGA1700',
      cores:          14,
      tdp_w:          181,   // Max Turbo Power (PL2) — Base TDP คือ 125W
      pcie_version:   '5.0',
      integrated_gpu: false,
      unit_cost:      9490,
    },
  },
  {
    id: 5,
    uuid: 'cpu-002',
    entity_type: 'cpu',
    code: 'CPU-I9-13900K',
    name: 'Intel Core i9-13900K',
    status: 'published',
    attributes: {
      socket:         'LGA1700',
      cores:          24,
      tdp_w:          253,   // Max Turbo Power (PL2)
      pcie_version:   '5.0',
      integrated_gpu: false,
      unit_cost:      22990,
    },
  },
  {
    id: 6,
    uuid: 'cpu-003',
    entity_type: 'cpu',
    code: 'CPU-R7-5800X',
    name: 'AMD Ryzen 7 5800X',
    status: 'published',
    attributes: {
      socket:         'AM4',
      cores:          8,
      tdp_w:          142,   // Max Turbo Power (PPT) — Base TDP คือ 105W
      pcie_version:   '4.0',
      integrated_gpu: false,
      unit_cost:      7490,
    },
  },

  // ─── RAM ───────────────────────────────────────────────────────
  {
    id: 7,
    uuid: 'ram-001',
    entity_type: 'ram',
    code: 'RAM-DDR5-32',
    name: 'Corsair Vengeance DDR5-5600 32GB (2×16)',
    status: 'published',
    attributes: {
      ram_type:     'DDR5',
      modules:      2,
      speed_mhz:    5600,
      power_draw_w: 5,
      unit_cost:    3990,
    },
  },
  {
    id: 8,
    uuid: 'ram-002',
    entity_type: 'ram',
    code: 'RAM-DDR5-64',
    name: 'G.Skill Trident Z5 DDR5-6000 64GB (2×32)',
    status: 'published',
    attributes: {
      ram_type:     'DDR5',
      modules:      2,
      speed_mhz:    6000,
      power_draw_w: 8,
      unit_cost:    7490,
    },
  },
  {
    id: 9,
    uuid: 'ram-003',
    entity_type: 'ram',
    code: 'RAM-DDR4-32',
    name: 'Kingston Fury Beast DDR4-3200 32GB (2×16)',
    status: 'published',
    attributes: {
      ram_type:     'DDR4',
      modules:      2,
      speed_mhz:    3200,
      power_draw_w: 5,
      unit_cost:    2490,
    },
  },

  // ─── GPUs ──────────────────────────────────────────────────────
  // ใช้ค่า TBP (Total Board Power) ซึ่งเป็น real-world draw
  {
    id: 10,
    uuid: 'gpu-001',
    entity_type: 'gpu',
    code: 'GPU-RTX4070',
    name: 'NVIDIA GeForce RTX 4070',
    status: 'published',
    attributes: {
      power_draw_w: 200,   // TBP
      pcie_version: '4.0',
      unit_cost:    19990,
    },
  },
  {
    id: 11,
    uuid: 'gpu-002',
    entity_type: 'gpu',
    code: 'GPU-RTX4090',
    name: 'NVIDIA GeForce RTX 4090',
    status: 'published',
    attributes: {
      power_draw_w: 450,   // TBP
      pcie_version: '4.0',
      unit_cost:    59990,
    },
  },
  {
    id: 12,
    uuid: 'gpu-003',
    entity_type: 'gpu',
    code: 'GPU-RX7800XT',
    name: 'AMD Radeon RX 7800 XT',
    status: 'published',
    attributes: {
      power_draw_w: 263,   // TBP
      pcie_version: '4.0',
      unit_cost:    14990,
    },
  },

  // ─── PSUs ──────────────────────────────────────────────────────
  {
    id: 13,
    uuid: 'psu-001',
    entity_type: 'psu',
    code: 'PSU-RM750E',
    name: 'Corsair RM750e 750W 80+ Gold',
    status: 'published',
    attributes: {
      watt_output: 750,
      efficiency:  '80+ Gold',
      unit_cost:   3990,
    },
  },
  {
    id: 14,
    uuid: 'psu-002',
    entity_type: 'psu',
    code: 'PSU-HX1000',
    name: 'Corsair HX1000 1000W 80+ Platinum',
    status: 'published',
    attributes: {
      watt_output: 1000,
      efficiency:  '80+ Platinum',
      unit_cost:   6990,
    },
  },
  {
    id: 15,
    uuid: 'psu-003',
    entity_type: 'psu',
    code: 'PSU-SF450',
    name: 'Corsair SF450 450W 80+ Gold',
    status: 'published',
    attributes: {
      watt_output: 450,
      efficiency:  '80+ Gold',
      unit_cost:   2990,
    },
  },
  {
    id: 16,
    uuid: 'psu-004',
    entity_type: 'psu',
    code: 'PSU-RM850E',
    name: 'Corsair RM850e 850W 80+ Gold',
    status: 'published',
    attributes: {
      watt_output: 850,
      efficiency:  '80+ Gold',
      unit_cost:   4990,
    },
  },
]

export const ENTITIES_BY_TYPE = (type: string): Entity[] =>
  ENTITIES.filter((e) => e.entity_type === type)

export const ENTITY_TYPES = ['motherboard', 'cpu', 'ram', 'gpu', 'psu'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  motherboard: 'Motherboard',
  cpu:         'CPU',
  ram:         'RAM',
  gpu:         'GPU',
  psu:         'PSU',
}

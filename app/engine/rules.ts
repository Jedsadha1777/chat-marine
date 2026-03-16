import type { CompatibilityRule } from '~/data/types'

export const RULES: CompatibilityRule[] = [

  // ─── Pairwise: socket match ───────────────────────────────────
  {
    id:         1,
    code:       'SOCKET_MATCH',
    name:       'CPU Socket Must Match Motherboard',
    check_type: 'pairwise',
    severity:   'error',
    priority:   200,
    is_active:  true,
    scope: {
      match_by:      'shared_attribute',
      attribute_key: 'socket',
    },
    condition: {
      '==': [
        { var: 'source.attributes.socket' },
        { var: 'target.attributes.socket' },
      ],
    },
    message:    'Socket ไม่ตรง: :source.attributes.socket ≠ :target.attributes.socket',
    resolution: 'เลือก CPU และ Motherboard ที่ใช้ socket เดียวกัน',
  },

  // ─── Pairwise: RAM type match ─────────────────────────────────
  {
    id:         2,
    code:       'RAM_TYPE_MATCH',
    name:       'RAM Type Must Match Motherboard',
    check_type: 'pairwise',
    severity:   'error',
    priority:   190,
    is_active:  true,
    scope: {
      match_by:         'attribute_pair',
      source_attribute: 'ram_type',
      target_attribute: 'ram_type',
    },
    condition: {
      '==': [
        { var: 'source.attributes.ram_type' },
        { var: 'target.attributes.ram_type' },
      ],
    },
    message:    ':source.name ใช้ RAM :source.attributes.ram_type แต่ :target.name รองรับ :target.attributes.ram_type',
    resolution: 'เลือก RAM ที่ตรงกับ type ของ Motherboard',
  },

  // ─── Pairwise: CPU TDP ≤ MB tdp_support ──────────────────────
  {
    id:         3,
    code:       'CPU_TDP_SUPPORT',
    name:       'Motherboard Must Support CPU TDP',
    check_type: 'pairwise',
    severity:   'warning',
    priority:   150,
    is_active:  true,
    scope: {
      match_by:         'attribute_pair',
      source_attribute: 'tdp_w',
      target_attribute: 'tdp_support_w',
    },
    condition: {
      '<=': [
        { var: 'source.attributes.tdp_w' },
        { var: 'target.attributes.tdp_support_w' },
      ],
    },
    message:    'CPU TDP :source.attributes.tdp_w W เกินที่ :target.name รองรับ :target.attributes.tdp_support_w W',
    resolution: 'เลือก Motherboard ที่รองรับ TDP ของ CPU',
  },

  // ─── Aggregate: RAM modules รวม ≤ MB ram_slots ───────────────
  // ใช้ multiply_by_quantity: true เพื่อนับ modules × จำนวน kit
  // เช่น 2 kit × 2 modules = 4 modules → ต้องไม่เกิน ram_slots ของ MB
  {
    id:         4,
    code:       'AGG_RAM_SLOTS',
    name:       'Total RAM Modules Must Not Exceed Motherboard Slots',
    check_type: 'aggregate',
    severity:   'error',
    priority:   195,
    is_active:  true,
    condition: {
      aggregate: {
        function:             'sum',
        attribute:            'modules',
        from_types:           ['ram'],
        multiply_by_quantity: true,
      },
      compare_to: {
        mode:        'entity_attribute',
        entity_type: 'motherboard',
        attribute:   'ram_slots',
      },
      operator: '<=',
    },
    message:    'RAM รวม :aggregate_value โมดูล เกิน Motherboard ที่มี :capacity_value slot',
    resolution: 'ลดจำนวน RAM kit หรือเลือก Motherboard ที่มี slot มากกว่านี้',
  },

  // ─── Aggregate: Power capacity (error) ───────────────────────
  {
    id:         5,
    code:       'AGG_POWER_CAPACITY',
    name:       'Total Power Must Not Exceed PSU',
    check_type: 'aggregate',
    severity:   'error',
    priority:   200,
    is_active:  true,
    condition: {
      aggregate: {
        function:             'sum',
        attribute:            'power_draw_w',
        fallback_attributes:  ['tdp_w'],
        from_types:           ['*'],
        exclude_types:        ['psu'],
        multiply_by_quantity: true,
      },
      compare_to: {
        mode:        'entity_attribute',
        entity_type: 'psu',
        attribute:   'watt_output',
      },
      operator: '<=',
    },
    message:    'พลังงานรวม :aggregate_value W เกิน PSU :capacity_value W (:utilization_pct|round(1)%)',
    resolution: 'เลือก PSU ที่มี wattage สูงกว่า :aggregate_value W',
  },

  // ─── Aggregate: Power safety 80% (warning) ───────────────────
  {
    id:         6,
    code:       'AGG_POWER_SAFETY',
    name:       'Power Usage Should Stay Under 80% PSU Capacity',
    check_type: 'aggregate',
    severity:   'warning',
    priority:   180,
    is_active:  true,
    condition: {
      aggregate: {
        function:             'sum',
        attribute:            'power_draw_w',
        fallback_attributes:  ['tdp_w'],
        from_types:           ['*'],
        exclude_types:        ['psu'],
        multiply_by_quantity: true,
      },
      compare_to: {
        mode:          'entity_attribute',
        entity_type:   'psu',
        attribute:     'watt_output',
        safety_factor: 0.8,
      },
      operator: '<=',
    },
    message:    'พลังงานรวม :aggregate_value W เกิน 80% ของ PSU (:capacity_value|round(0) W)',
    resolution: 'แนะนำ PSU อย่างน้อย :aggregate_value|multiply(1.25)|ceil W',
  },

]

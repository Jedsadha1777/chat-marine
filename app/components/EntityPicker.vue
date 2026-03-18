<!--
  ⚠️ DO NOT USE — ไม่ได้ใช้งานใน index.vue
  Component นี้ bypass ทุก safety guard:
  - ไม่กรอง entity status (แสดง draft/archived/deprecated)
  - ไม่มี pairwise compatibility check
  - API เป็น single Entity | null ไม่รองรับ multi-item slots
  ใช้ compatibleEntitiesFor() + canAddToSlot() ใน index.vue แทน
-->

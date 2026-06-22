-- Add capacity_gb to all RAM entities based on GB in product name
UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 4)
WHERE entity_type = 'ram' AND name LIKE '% 4GB %';

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 8)
WHERE entity_type = 'ram' AND name LIKE '% 8GB %';

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 16)
WHERE entity_type = 'ram' AND name LIKE '% 16GB %';

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 32)
WHERE entity_type = 'ram' AND name LIKE '% 32GB %';

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 64)
WHERE entity_type = 'ram' AND name LIKE '% 64GB %';

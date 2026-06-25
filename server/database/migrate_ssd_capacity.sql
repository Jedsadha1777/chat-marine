-- Add capacity_gb to all SSD entities based on GB/TB in product name
UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 120)
WHERE entity_type = 'ssd' AND (name LIKE '% 120GB %' OR name LIKE '%120GB%');

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 128)
WHERE entity_type = 'ssd' AND (name LIKE '% 128GB %' OR name LIKE '%128GB%');

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 240)
WHERE entity_type = 'ssd' AND (name LIKE '% 240GB %' OR name LIKE '%240GB%');

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 250)
WHERE entity_type = 'ssd' AND (name LIKE '% 250GB %' OR name LIKE '%250GB%');

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 480)
WHERE entity_type = 'ssd' AND (name LIKE '% 480GB %' OR name LIKE '%480GB%');

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 500)
WHERE entity_type = 'ssd' AND (name LIKE '% 500GB %' OR name LIKE '%500GB%');

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 1000)
WHERE entity_type = 'ssd' AND (name LIKE '% 1TB %' OR name LIKE '%1TB%');

UPDATE entities SET attributes = json_set(attributes, '$.capacity_gb', 2000)
WHERE entity_type = 'ssd' AND (name LIKE '% 2TB %' OR name LIKE '%2TB%');

-- Seed PC component entities
-- Run after schema.sql: wrangler d1 execute chat-marine --file=server/database/seed.sql

INSERT OR IGNORE INTO entities (id, uuid, entity_type, code, name, status, unit_cost, attributes) VALUES
-- Motherboards
(1,  'mb-001', 'motherboard', 'MB-B760M-WIFI',  'MSI PRO B760M-A WIFI',         'published', 4990,  '{"socket":"LGA1700","ram_type":"DDR5","ram_slots":4,"max_ram_gb":96,"max_ram_speed_mhz":6800,"tdp_support_w":125,"power_draw_w":80,"unit_cost":4990}'),
(2,  'mb-002', 'motherboard', 'MB-Z790-PRO',    'ASUS ROG STRIX Z790-F',         'published', 12990, '{"socket":"LGA1700","ram_type":"DDR5","ram_slots":4,"max_ram_gb":192,"max_ram_speed_mhz":7800,"tdp_support_w":253,"power_draw_w":95,"unit_cost":12990}'),
(3,  'mb-003', 'motherboard', 'MB-B550-AM4',    'ASUS TUF GAMING B550-PLUS',     'published', 3990,  '{"socket":"AM4","ram_type":"DDR4","ram_slots":4,"max_ram_gb":128,"max_ram_speed_mhz":4400,"tdp_support_w":105,"power_draw_w":65,"unit_cost":3990}'),
-- CPUs (uses Max Turbo Power / PL2 for accurate PSU sizing)
(4,  'cpu-001', 'cpu',        'CPU-I5-13600K',  'Intel Core i5-13600K',          'published', 9490,  '{"socket":"LGA1700","cores":14,"l3_cache_mb":24,"tdp_w":181,"pcie_version":"5.0","integrated_gpu":false,"unit_cost":9490}'),
(5,  'cpu-002', 'cpu',        'CPU-I9-13900K',  'Intel Core i9-13900K',          'published', 22990, '{"socket":"LGA1700","cores":24,"l3_cache_mb":36,"tdp_w":253,"pcie_version":"5.0","integrated_gpu":false,"unit_cost":22990}'),
(6,  'cpu-003', 'cpu',        'CPU-R7-5800X',   'AMD Ryzen 7 5800X',             'published', 7490,  '{"socket":"AM4","cores":8,"l3_cache_mb":32,"tdp_w":142,"pcie_version":"4.0","integrated_gpu":false,"unit_cost":7490}'),
-- RAM
(7,  'ram-001', 'ram',        'RAM-DDR5-32',    'Corsair Vengeance DDR5-5600 32GB (2x16)', 'published', 3990, '{"ram_type":"DDR5","modules":2,"speed_mhz":5600,"power_draw_w":5,"unit_cost":3990}'),
(8,  'ram-002', 'ram',        'RAM-DDR5-64',    'G.Skill Trident Z5 DDR5-6000 64GB (2x32)', 'published', 7490, '{"ram_type":"DDR5","modules":2,"speed_mhz":6000,"power_draw_w":8,"unit_cost":7490}'),
(9,  'ram-003', 'ram',        'RAM-DDR4-32',    'Kingston Fury Beast DDR4-3200 32GB (2x16)', 'published', 2490, '{"ram_type":"DDR4","modules":2,"speed_mhz":3200,"power_draw_w":5,"unit_cost":2490}'),
-- GPUs (uses TBP / Total Board Power)
(10, 'gpu-001', 'gpu',        'GPU-RTX4070',    'NVIDIA GeForce RTX 4070',       'published', 19990, '{"memory_bus_bit":192,"vram_gb":12,"power_draw_w":200,"pcie_version":"4.0","unit_cost":19990}'),
(11, 'gpu-002', 'gpu',        'GPU-RTX4090',    'NVIDIA GeForce RTX 4090',       'published', 59990, '{"memory_bus_bit":384,"vram_gb":24,"power_draw_w":450,"pcie_version":"4.0","unit_cost":59990}'),
(12, 'gpu-003', 'gpu',        'GPU-RX7800XT',   'AMD Radeon RX 7800 XT',         'published', 14990, '{"memory_bus_bit":256,"vram_gb":16,"power_draw_w":263,"pcie_version":"4.0","unit_cost":14990}'),
-- PSUs
(13, 'psu-001', 'psu',        'PSU-RM750E',     'Corsair RM750e 750W 80+ Gold',  'published', 3990,  '{"watt_output":750,"efficiency":"80+ Gold","unit_cost":3990}'),
(14, 'psu-002', 'psu',        'PSU-HX1000',     'Corsair HX1000 1000W 80+ Platinum', 'published', 6990, '{"watt_output":1000,"efficiency":"80+ Platinum","unit_cost":6990}'),
(15, 'psu-003', 'psu',        'PSU-SF450',      'Corsair SF450 450W 80+ Gold',   'published', 2990,  '{"watt_output":450,"efficiency":"80+ Gold","unit_cost":2990}'),
(16, 'psu-004', 'psu',        'PSU-RM850E',     'Corsair RM850e 850W 80+ Gold',  'published', 4990,  '{"watt_output":850,"efficiency":"80+ Gold","unit_cost":4990}');

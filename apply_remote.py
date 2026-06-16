import subprocess, sys

sql = open('server/database/seed.sql').read()
statements = [s.strip() for s in sql.split(';') if s.strip()]
print(f'Total statements: {len(statements)}')

for i, stmt in enumerate(statements):
    print(f'[{i+1}/{len(statements)}] {stmt[:60].replace(chr(10)," ")}...')
    r = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'chat-marine', '--remote',
         '--command', stmt + ';'],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        print('ERROR:', r.stderr[-300:])
        sys.exit(1)
    print('  OK')

print('Done!')

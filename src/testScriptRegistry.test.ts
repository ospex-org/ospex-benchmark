import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Suite-completeness guard: every committed `*.test.ts` file under `src` (recursively) must appear in
 * the package.json `test` script. The runner reports `# fail 0` for a suite it never loaded, so a test
 * file dropped from the explicit script list would silently stop running with no failure — this test
 * makes that a loud red. The `spike` scratch conformance area (run via its own `store:spike` script) is
 * excluded.
 */
test('every src test file is registered in the package.json test script', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url))); // .../src/<file> -> repo root
  const srcDir = join(root, 'src');
  const script = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: { test: string } }).scripts.test;

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'spike') continue;
        out.push(...walk(join(dir, entry.name)));
      } else if (entry.name.endsWith('.test.ts')) {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  };

  const files = walk(srcDir).map((f) => `src/${f.slice(srcDir.length + 1).split(/[\\/]/).join('/')}`);
  const missing = files.filter((f) => !script.includes(f));
  assert.deepEqual(missing, [], `test files missing from the package.json "test" script: ${missing.join(', ')}`);
});

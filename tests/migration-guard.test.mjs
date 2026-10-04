import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertMigrationsApplied } from '../src/postgres.mjs';

const sum = text => createHash('sha256').update(text).digest('hex');
function setup(t, applied) {
  const dir = mkdtempSync(join(tmpdir(), 'jcs-migrations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;\n');
  writeFileSync(join(dir, '002_b.sql'), 'SELECT 2;\n');
  const pool = { query: async () => ({ rows: applied }) };
  return { pool, url: pathToFileURL(dir + '/') };
}

test('server starts only when every migration in the code is applied unchanged', async t => {
  const ok = setup(t, [{ version: '001_a', checksum: sum('SELECT 1;\n') }, { version: '002_b', checksum: sum('SELECT 2;\n') }]);
  assert.equal(await assertMigrationsApplied(ok.pool, ok.url), 2);

  const pending = setup(t, [{ version: '001_a', checksum: sum('SELECT 1;\n') }]);
  await assert.rejects(assertMigrationsApplied(pending.pool, pending.url), /pendentes no banco: 002_b/);

  const edited = setup(t, [{ version: '001_a', checksum: sum('SELECT 0;\n') }, { version: '002_b', checksum: sum('SELECT 2;\n') }]);
  await assert.rejects(assertMigrationsApplied(edited.pool, edited.url), /editadas no código: 001_a/);

  // Registros antigos sem checksum continuam aceitos, como no script oficial.
  const legacy = setup(t, [{ version: '001_a', checksum: null }, { version: '002_b', checksum: sum('SELECT 2;\n') }]);
  assert.equal(await assertMigrationsApplied(legacy.pool, legacy.url), 2);
});

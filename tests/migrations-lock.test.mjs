import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

// Migration aplicada em produção não pode mudar: o script de migrations confere o checksum
// de cada uma e recusa rodar qualquer migration nova quando uma antiga foi editada.
// Mudança de schema entra sempre como migration nova; depois, acrescente a linha dela em CHECKSUMS.json.
const dir = new URL('../migrations/', import.meta.url);
const checksum = file => createHash('sha256').update(readFileSync(new URL(file, dir), 'utf8').replace(/\r\n/g, '\n')).digest('hex');

test('migrations already recorded keep the exact content that production applied', () => {
  const lock = JSON.parse(readFileSync(new URL('CHECKSUMS.json', dir), 'utf8'));
  const files = readdirSync(dir).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  for (const [version, expected] of Object.entries(lock)) {
    assert.ok(files.includes(`${version}.sql`), `${version}.sql was removed or renamed`);
    assert.equal(checksum(`${version}.sql`), expected, `${version}.sql was edited after being recorded; create a new migration instead`);
  }
  const unlisted = files.map(name => name.slice(0, -4)).filter(version => !(version in lock));
  assert.deepEqual(unlisted, [], 'add the new migration checksum to migrations/CHECKSUMS.json');
});

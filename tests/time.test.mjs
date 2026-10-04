import test from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_TIME_ZONE,businessDate,reportRange } from '../src/time.mjs';

test('periodo operacional usa a meia-noite de America/Sao_Paulo',()=>{
  const range=reportRange('2026-10-03','2026-10-03');
  assert.equal(range.time_zone,BUSINESS_TIME_ZONE);
  assert.equal(range.start,'2026-10-03T03:00:00.000Z');
  assert.equal(range.end,'2026-10-04T03:00:00.000Z');
  assert.equal(businessDate(new Date('2026-10-04T02:59:59.000Z')),'2026-10-03');
  assert.equal(businessDate(new Date('2026-10-04T03:00:00.000Z')),'2026-10-04');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../src/http.mjs';
import { fixture } from './helpers.mjs';

const get = (port, path, host) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, res => {
    let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject); req.end();
});

test('Railway healthcheck host reaches only GET /health in production', async t => {
  const saved = { NODE_ENV: process.env.NODE_ENV, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN };
  process.env.NODE_ENV = 'production'; process.env.PUBLIC_ORIGIN = 'https://pdv.example.test';
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const { db } = fixture(t);
  const server = createApp(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;

  const health = await get(port, '/health', 'healthcheck.railway.app');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).databaseStatus, 'ok');
  for (const path of ['/', '/api/me', '/admin', '/health/../api/me']) assert.equal((await get(port, path, 'healthcheck.railway.app')).status, 403, path);
  assert.equal((await get(port, '/health', 'outro.example.test')).status, 403);
  assert.equal((await get(port, '/health', 'pdv.example.test')).status, 200);
});

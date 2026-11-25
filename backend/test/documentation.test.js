import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

test('serves Swagger UI and an OpenAPI operation for every registered API route', async t => {
  const app = createApp({ JWT_SECRET: 'isolated-documentation-test-key-0123456789' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;

  const page = await fetch(origin + '/doc/');
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const path of ['/doc/assets/swagger-ui.css', '/doc/assets/swagger-ui-bundle.js', '/doc/start.js']) {
    assert.ok(html.includes(path));
    const asset = await fetch(origin + path);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /text\/css|javascript/);
    assert.ok((await asset.text()).length > 50);
  }

  const specification = await fetch(origin + '/doc/openapi.json');
  assert.equal(specification.status, 200);
  const document = await specification.json();
  assert.match(document.openapi, /^3\./);
  assert.equal(document.servers[0].url, '/api/v1');
  assert.equal(document.components.securitySchemes.sessionCookie.in, 'cookie');
  const documented = Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map(method => method + ' ' + path));
  const router = app.router.stack.find(layer => layer.handle.stack?.some(entry => entry.route?.path === '/health'));
  const actual = router.handle.stack.filter(layer => layer.route).flatMap(({ route }) =>
    Object.keys(route.methods).map(method => method + ' ' + route.path.replace(/:(\w+)/g, '{$1}')));
  assert.deepEqual(documented.sort(), actual.sort());
});

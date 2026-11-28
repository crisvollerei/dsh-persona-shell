import assert from 'node:assert/strict';
import test from 'node:test';
import { readRequestBody } from '../lib/http-body.js';
import { createHostSettingsRoutes } from '../lib/host-settings-routes.js';

test('preset preview receives the original name at every UTF-8 split position', async () => {
  const handler = createHostSettingsRoutes({ ROUTE: '/persona-shell', currentSessionHint: () => null,
    previewPersona: async body => body.name, trackModelTask: task => task,
    sendJson: (res, status, value) => Object.assign(res, { status, value }) });
  const name = '小肥鱼🐳', bytes = Buffer.from(JSON.stringify({ action: 'preview', name }));
  for (let cut = 1; cut < bytes.length; cut++) {
    const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield bytes.subarray(0, cut); yield bytes.subarray(cut); } };
    const result = {};
    await handler(req, result, null, '/persona-shell/presets');
    assert.deepEqual(result, { status: 200, value: name });
  }
});

test('JSON body limits count bytes across all chunks and retain existing empty-body handling', async () => {
  assert.equal(await readRequestBody([], 3), '');
  assert.equal(await readRequestBody(['汉', Buffer.from('字')], 6), '汉字');
  assert.equal(await readRequestBody(['汉', Buffer.from('字')], 5), undefined);
});

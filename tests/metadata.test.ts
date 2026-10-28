import assert from 'node:assert/strict';
import test from 'node:test';
import { publicSite } from '../src/config/metadata';

test('only a configured HTTPS production origin is indexable; previews and local builds stay excluded', () => {
  assert.equal(publicSite({ NODE_ENV: 'production' }).indexable, false);
  assert.equal(publicSite({ NODE_ENV: 'production', SICARA_APP_ORIGIN: 'http://127.0.0.1:3000' }).indexable, false);
  assert.deepEqual(publicSite({ NODE_ENV: 'production', VERCEL_ENV: 'preview', SICARA_APP_ORIGIN: 'https://sicara.example' }), { origin: 'https://sicara.example', indexable: false });
  assert.deepEqual(publicSite({ NODE_ENV: 'production', VERCEL_ENV: 'production', SICARA_APP_ORIGIN: 'https://sicara.example' }), { origin: 'https://sicara.example', indexable: true });
  assert.equal(publicSite({ NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: 'sicara.example' }).origin, 'https://sicara.example');
  for (const origin of ['https://sicara.example/', 'https://sicara.example/path', 'https://user:password@sicara.example', 'javascript:alert(1)']) assert.throws(() => publicSite({ SICARA_APP_ORIGIN: origin }));
});

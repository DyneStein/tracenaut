import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// The protocol package is TypeScript source; bundle the one function under test.
const { redactQuery } = await (async () => {
  const out = await build({ stdin: { contents: "export { redactQuery } from './packages/protocol/src/index.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'node' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
})();

test('sensitive query values are replaced, others kept', () => {
  assert.equal(redactQuery('/api/x?token=abc&page=2'), '/api/x?token=•••&page=2');
  assert.equal(redactQuery('/cb?code=123&state=xyz'), '/cb?code=•••&state=xyz');
  assert.equal(redactQuery('/a?api_key=k&Password=p&sessionId=s&q=hello'), '/a?api_key=•••&Password=•••&sessionId=•••&q=hello');
  assert.equal(redactQuery('/plain/path'), '/plain/path');
  assert.equal(redactQuery('/a?flag'), '/a?flag');
});

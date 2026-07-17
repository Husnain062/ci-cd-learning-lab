const assert = require('node:assert');
const { test } = require('node:test');
const app = require('./index');

test('GET / returns json with a message and secret field', async () => {
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://localhost:${port}/`);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.message, 'ci-cd-learning-lab is alive');
    assert.ok('secret' in body);
  } finally {
    server.close();
  }
});

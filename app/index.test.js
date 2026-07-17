const assert = require('node:assert');
const { test } = require('node:test');

// index.js reads process.env.DEMO_SECRET per-request (inside the route
// handler), not at require/module-load time, so setting it here before the
// request is made is sufficient — no need to set it before require('./index').
process.env.DEMO_SECRET = 'test-secret-value';
const app = require('./index');

test('GET / returns json with a message and the actual DEMO_SECRET value', async () => {
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://localhost:${port}/`);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.message, 'ci-cd-learning-lab is alive');
    assert.strictEqual(body.secret, 'test-secret-value');
  } finally {
    server.close();
  }
});

const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    message: 'ci-cd-learning-lab is alive',
    secret: process.env.DEMO_SECRET || null,
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`listening on port ${port}`);
  });
}

module.exports = app;

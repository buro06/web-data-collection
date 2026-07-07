require('dotenv').config();

const express = require('express');
const path = require('path');

const { getConfig, ROOT } = require('./lib/config');
const trackRouter = require('./routes/track');

function createServer() {
  const config = getConfig();
  const app = express();

  if (config.trustProxy) app.set('trust proxy', true);

  app.use(express.json({ limit: '32kb' }));
  app.use('/api', trackRouter);
  app.use(express.static(path.join(ROOT, 'public')));

  app.get('/health', (req, res) => res.json({ ok: true }));

  return app;
}

function start() {
  const config = getConfig();
  const app = createServer();
  const port = process.env.PORT || config.port || 3000;
  return app.listen(port, () => {
    console.log(`web-data-collection listening on port ${port}`);
  });
}

module.exports = { createServer, start };

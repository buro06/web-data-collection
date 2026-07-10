require('dotenv').config();

const express = require('express');
const path = require('path');

const { getConfig, ROOT } = require('./lib/config');
const trackRouter = require('./routes/track');

function createServer() {
  const config = getConfig();
  const app = express();

  if (config.trustProxy) app.set('trust proxy', true);

  // Discourage search crawlers from indexing this tracking server. There's no
  // HTML to carry a <meta name="robots"> tag, so we set the equivalent HTTP
  // header on every response — it applies to track.js and other assets too.
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    next();
  });

  // Well-behaved crawlers check this before fetching anything.
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('' +
        'User-agent: *\nDisallow: /\n' +
        '                                                                                                                              \n' +
        '                                                                                                                                \n' +
        '                                                                                                                                \n' +
        '                                                                                                                                \n' +
        '                                                                                                                                \n' +
        '                                                                                                                                \n' +
        '#                             @@@@@@@@@@@@                                                                                      \n' +
        '#                           @@@@@@@@@@@@@@@@@                     @ @@@                                                         \n' +
        '#                          @@@@@@@@@ @@@@@@@@@@                  @ @@@@  @@@@@@@@                                               \n' +
        '#                          @@@            @@@@@                   @ @@@@@@@@@@  @@                                              \n' +
        '#                         @@@ @@@           @@@@                   @@@@@@@@@@ @@ @                                              \n' +
        '#                         @@@@@@@         @@@@@@      @@@       @@@@@@@@@  @@@@@@ @@            @@@@@@@@@                       \n' +
        '#                          @@  @          @@@@@       @@@       @@  @@@@@@@@@@@@@@ @          @@@@@@@@@@@@                      \n' +
        '#                    @@@    @@ @    @     @ @@@      @@ @@@@@@@@@ @@@@@@@@ @@@@@@@@ @@@    @@@@@@@@@@@@@@@@@                    \n' +
        '#                           @@ @@    @    @ @@@@   @@@@ @@@@@@@@@@@ @@@ @@@ @@@@@@@ @ @   @@@@@@        @@@@@                   \n' +
        '#                            @@@          @@ @@@@@@@@@@  @@@@@@@@@@ @@@@ @@@@@@ @@@@      @@@             @@@                   \n' +
        '#                             @@          @@@@@  @@@ @@@@@@@@@@@@@@@@@@@@ @@@@@  @  @@    @@@              @@                   \n' +
        '#                             @@        @@@@@@@@ @   @@@@@      @@@@ @@@ @@@ @@@@@    @   @@@@          @@ @@                   \n' +
        '#                             @@        @@@@@@@@@ @@@@             @@@@@@ @@@@@ @@   @     @@@@@ @ @ @  @@@@@                   \n' +
        '#                      @@@@@@@@@       @@@ @@@@@ @ @@  @          @ @@@@@@@ @@ @ @@        @@ @@        @  @@                   \n' +
        '#  @@@@@@@@@@@@@@@@@@@@@@@@@@@@        @@ @@ @ @@@@@ @               @  @@ @@  @@@ @@@@@@@@@@ @   @     @@@@                    \n' +
        '#  @@@@@@@@@@@@@@@@@@@@@    @@@@@      @@@@@@@  @@ @@             @  @@@@@ @@@@  @@@@@@@@@@@@@@         @@@                     \n' +
        '#   @       @@@@             @ @ @@     @@@@@@@@@  @@             @@  @@ @@@ @@ @@@@@@@ @ @@@@@         @@                      \n' +
        '#  @                          @ @         @@@@@@  @ @@@@         @@@@@ @ @@@@@  @@@@@@@@@ @ @@@         @@@@                    \n' +
        '#                             @@@      @ @  @@@@ @@@@@@@@        @ @@@ @@@@@@@@@@@@@@@@@@@@@@  @        @@@@@@@                 \n' +
        '#         @                                  @    @@@@@ @@@@     @@ @@@@@@ @@@@@@@@@@@ @@ @@@@ @          @@@@@@@@@             \n' +
        '#      @ @                                     @@@  @@            @@     @@@@ @@ @ @@  @@ @@@@@          @@   @@@@@@@@@@@@@@@@@ \n' +
        '#       @                                                          @       @@     @ @                    @        @@@@@@@@@@@@@ \n' +
        '#                          buro.6            @           @@@                @@ @@@ @            @@                    @     @@@ \n' +
        '#  @@@                                                                      @@@@@                                               \n' +
        '#  @                                          @                             @@@@@@                 @     agng.net       @    @  \n' +
        '#  @@@                                                                    @@@@                     @@                       @@  \n' +
        '#  @@@@@    @@@                                      7.4.26               @@@                @@@   @             @              \n' +
        '#     @@@@@@@@@                                                           @@                 @                            @ @   \n' +
        '#         @@@@@              @                   @@                       @@                   @                                \n' +
        '#            @@@@@@@       @@@@ @                                         @                                             @ @@    \n' +
        '#  @           @@@@@@@@@@@@@@@@                                           @          @                                  @ @     \n' +
        '#  @@     @@@@      @@@@@@@   @@               @                          @                                                   @ \n' +
        '#   @@      @@@@@@@        @   @@@@                                        @ @@@@     @                                @@@@     \n' +
        '#           @ @@@@@@@@@@@@         @@      @                               @ @@@@@ @ @@                                         \n' +
        '#   @@  @    @    @@@@@@@@@@@     @@       @                              @@@@@@@    @@                                     @@@ \n' +
        '#  @@@@@@@@@@@           @@@@@@@@@@        @@                             @@         @@                           @         @@@ \n' +
        '#  @@@@@@@@@                               @@                              @@        @@                          @ @@@@@  @  @@ \n' +
        '#  @@@@@@@@@ @@                             @@@                            @@@  @     @                          @ @   @@@@  @@ \n' +
        '#  @@   @@@@@ @                             @@ @                          @@@   @   @@                          @@ @   @   @@ @ \n' +
        '#     @@@@@@@ @                             @@                            @@@   @ @ @@@                         @@ @  @@@   @ @ \n' +
        '#   @ @@@@@@@ @                              @@                           @ @       @@@                          @    @ @   @ @ \n' +
        '#   @@@@@@@ @@@                              @@                           @ @  @    @@@                               @ @   @ @ \n' +
        '#   @@@ @@@ @@                                                             @@        @@@@@@@@@@@                 @@   @ @   @ @ \n' +
        '#    @@     @                               @@@ @                            @      @@ @@@@@@@@@@@@                @  @ @   @ @ \n' +
        '#    @@  @                             @@@@@@@@ @             @@           @@@  @  @@            @@@@@@           @@  @ @   @   \n' +
        '#   @@@ @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ @  @@@@@@@@@               @@@                     @@@@@@@@@@@@@@@@@            \n' +
        '#   @ @ @ @ @@@@@@@@@@@@@@@@@@@@@@@@@@@      @@ @                           @@                          @@   @@@@@ @@           \n' +
        '#  @@ @ @ @ @@               @               @@@                           @@@                                      @      @    \n' +
        '#  @@ @ @ @ @@                               @@@                           @ @                                             @    \n' +
        '#                                                                                                                               ');
  });

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

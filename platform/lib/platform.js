/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const signale = require('signale');
const express = require('express');
const shrinkRay = require('shrink-ray-current');
const cors = require('cors');
const ampCors = require('@ampproject/toolbox-cors');
const config = require('./config.js');
const {pagePath} = require('@lib/utils/project');
const subdomain = require('./middleware/subdomain.js');

const routers = {
  boilerplate: require('../../boilerplate/backend/'),
  example: {
    api: require('@examples'),
    embeds: require('@lib/routers/example/embeds.js'),
    sources: require('@lib/routers/example/sources.js'),
    static: require('@lib/routers/example/static.js'),
    inline: require('@lib/routers/inlineExamples.js'),
  },
  log: require('@lib/routers/runtimeLog.js'),
  go: require('@lib/routers/go.js'),
  growPages: require('@lib/routers/growPages.js'),
  growXmls: require('@lib/routers/growXmls.js'),
  healthCheck: require('@lib/routers/healthCheck.js').router,
  notFound: require('@lib/routers/notFound.js'),
  packager: require('@lib/routers/packager.js'),
  playground: require('../../playground/backend/'),
  static: require('@lib/routers/static.js'),
  templates: require('@lib/routers/templates.js'),
  whoAmI: require('@lib/routers/whoAmI.js'),
};

const HOST = config.hosts.platform.base;
const PORT = config.hosts.platform.port || process.env.APP_PORT || 80;

class Platform {
  start() {
    signale.info('Starting platform');
    return new Promise(async (resolve, reject) => {
      try {
        await this._createServer();
        this.httpServer = this.server.listen(PORT, () => {
          signale.success(`server listening on ${PORT}!`);
          resolve();
        });
        // Increase keep alive timeout
        // see https://cloud.google.com/load-balancing/docs/https/#timeouts_and_retries
        this.httpServer.keepAliveTimeout = 700 * 1000;
      } catch (err) {
        reject(err);
      }
    });
  }

  stop() {
    signale.info('Stopping platform');
    return new Promise(async (resolve, reject) => {
      this.httpServer.close(() => resolve());
    });
  }

  async _createServer() {
    signale.await(`Starting platform with environment ${config.environment} on ${HOST} ...`);
    this.server = express();

    // pass app engine HTTPS status to express app
    this.server.set('trust proxy', true);

    this._configureMiddlewares();
    await this._configureSubdomains();
    this._configureRouters();
    this._configureErrorHandlers();
  }

  _configureMiddlewares() {
    this.server.use(shrinkRay());
    this.server.use(require('./middleware/security.js'));
    this.server.use(require('./middleware/redirects.js'));
    this.server.use(require('./middleware/caching.js'));
    this.server.use(cors());
    this.server.use(ampCors({
      email: true,
    }));
    // debug computing times
    this.server.use((req, res, next) => {
      const timeStart = process.hrtime();

      res.on('finish', () => {
        const timeElapsed = process.hrtime(timeStart);
        let seconds = (timeElapsed[0] * 1000 + timeElapsed[1] / 1e6) / 1000;
        seconds = seconds.toFixed(3);
        const prefix = seconds > 1 ? 'CRITICAL_TIMING' : 'TIMING';
        let postfix = `[${res.statusCode}]`;
        if (req.header('amp-cache-transform')) {
          postfix += ' [SXG]';
        }
        console.log(`[${prefix}] ${req.get('host')}${req.originalUrl} ${seconds}s ${postfix}`);
      });

      next();
    });
  }

  async _configureSubdomains() {
    this.server.use(await subdomain.map(config.hosts.playground, routers.playground));
    this.server.use(await subdomain.map(config.hosts.go, routers.go));
    this.server.use(await subdomain.map(config.hosts.log, routers.log));
    // eslint-disable-next-line new-cap
    this.server.use(await subdomain.map(config.hosts.preview, express.Router().use([
      routers.example.api,
      routers.example.static,
      routers.example.embeds,
      routers.example.sources,
      routers.example.inline,
    ])));
  }

  _configureRouters() {
    this.server.use(routers.packager);
    this.server.use(routers.whoAmI);
    this.server.use(routers.healthCheck);
    this.server.use(routers.example.api);
    this.server.use(routers.boilerplate);
    this.server.use(routers.static);
    this.server.use(routers.templates);
    // grow xml files need to be after static xml
    this.server.use(routers.growXmls);
    // Register the following router at last as it works as a catch-all
    this.server.use(routers.growPages);
  }

  _configureErrorHandlers() {
    // handle errors
    this.server.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
      if (err) {
        console.log(err);
        res.status(500).sendFile('500.html', {root: pagePath()});
      }
    });
    // handle 404s
    this.server.use(routers.notFound);
  }
};

module.exports = Platform;

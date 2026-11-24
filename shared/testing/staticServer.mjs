/**
 * Shared repo-root static HTTP server for Chrome CDP and Firefox Wayland QA suites.
 * Serves the repository root so relative cross-sim links and `shared/` imports resolve
 * identically to production static hosting / `./launch.sh`.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});

/**
 * Starts a local HTTP server rooted at `REPO_ROOT`.
 * @param {object} [options]
 * @param {number} [options.preferredPort=0]
 * @param {string|null} [options.shotDir=null]
 * @param {boolean} [options.enableQaEndpoints=false]
 * @param {string|null} [options.injectTargetRel=null] e.g. 'blackhole-sim/index.html'
 * @param {string} [options.injectScript='']
 */
export function startStaticServer({
  preferredPort = 0,
  shotDir = null,
  enableQaEndpoints = false,
  injectTargetRel = null,
  injectScript = '',
} = {}) {
  let skyRequestCount = 0;
  let doneResolve;
  const donePromise = new Promise((resolve) => {
    doneResolve = resolve;
  });

  const normalizedInjectRel = injectTargetRel
    ? injectTargetRel.replace(/^\/+/, '')
    : null;
  const normalizedInjectBare = normalizedInjectRel
    ? normalizedInjectRel.replace(/\/index\.html$/, '')
    : null;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const urlPath = decodeURIComponent(reqUrl.pathname || '/');

      if (urlPath.endsWith('milkyway_4k.jpg')) {
        skyRequestCount++;
      }

      if (enableQaEndpoints) {
        if (req.method === 'GET' && urlPath === '/__qa_runner.js') {
          res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
          res.end(injectScript);
          return;
        }

        if (req.method === 'POST' && urlPath === '/__qa_png') {
          const name = path.basename(reqUrl.searchParams.get('name') || 'qa_out.png');
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            if (shotDir) {
              fs.mkdirSync(shotDir, { recursive: true });
              fs.writeFileSync(path.join(shotDir, name), Buffer.concat(chunks));
            }
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
          });
          return;
        }

        if (req.method === 'POST' && urlPath === '/__qa_done') {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            try {
              doneResolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (err) {
              doneResolve({ fatalError: `Malformed report JSON: ${err.message}` });
            }
          });
          return;
        }
      }

      let rel = urlPath.replace(/^\/+/, '');
      if (rel === '' || rel.endsWith('/')) {
        rel += 'index.html';
      }

      let fullPath = path.resolve(REPO_ROOT, rel);
      if (fullPath !== REPO_ROOT && !fullPath.startsWith(REPO_ROOT + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const serveHtml = (htmlFile) => {
        fs.readFile(htmlFile, 'utf8', (err, html) => {
          if (err) {
            res.writeHead(500);
            res.end(err.message);
            return;
          }
          const instrumented = html.replace(
            '</body>',
            '  <script type="module" src="/__qa_runner.js"></script>\n</body>'
          );
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(instrumented);
        });
      };

      fs.stat(fullPath, (err, stat) => {
        if (!err && stat.isDirectory()) {
          const idxPath = path.join(fullPath, 'index.html');
          fs.stat(idxPath, (err2, stat2) => {
            if (err2 || !stat2.isFile()) {
              res.writeHead(404);
              res.end('Not found');
              return;
            }
            const relIdx = path.relative(REPO_ROOT, idxPath).split(path.sep).join('/');
            if (enableQaEndpoints && normalizedInjectRel && relIdx === normalizedInjectRel) {
              serveHtml(idxPath);
              return;
            }
            res.writeHead(200, {
              'Content-Type': MIME['.html'],
              'Content-Length': stat2.size,
              'Cache-Control': 'no-cache',
            });
            fs.createReadStream(idxPath).pipe(res);
          });
          return;
        }

        if (err || !stat.isFile()) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        if (
          enableQaEndpoints &&
          normalizedInjectRel &&
          (rel === normalizedInjectRel || rel === normalizedInjectBare)
        ) {
          serveHtml(fullPath);
          return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(fullPath).pipe(res);
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRUSE' && preferredPort !== 0) {
        server.listen(0, '127.0.0.1');
      } else {
        reject(err);
      }
    });

    server.listen(preferredPort, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        getSkyRequestCount: () => skyRequestCount,
        donePromise,
      });
    });
  });
}

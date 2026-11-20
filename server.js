'use strict';

// HTTP 服务：node server.js 启动，读取 PORT，绑定 127.0.0.1。仅用 Node 内置模块。

const http = require('node:http');
const { TideStore, IngestError } = require('./lib/tide-store');
const demo = require('./lib/demo-data');
const { renderPage } = require('./lib/page');

const ROUTES = {
  '/': ['GET'],
  '/api/state': ['GET'],
  '/api/ingest': ['POST'],
  '/api/ingest/realtime': ['POST'],
  '/api/ingest/archive': ['POST'],
  '/api/reset': ['POST'],
};

const MAX_BODY = 1024 * 1024;

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 });
  }
}

function createServer() {
  let store = new TideStore();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    try {
      const allowed = ROUTES[path];
      if (!allowed) {
        sendJson(res, 404, { error: `未知路径：${path}` });
        return;
      }
      if (!allowed.includes(req.method)) {
        res.setHeader('allow', allowed.join(', '));
        sendJson(res, 405, { error: `${path} 不支持 ${req.method}，可用：${allowed.join('、')}` });
        return;
      }

      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderPage());
      } else if (path === '/api/state') {
        const mode = url.searchParams.get('mode') || 'prefer-fast';
        sendJson(res, 200, store.state(mode));
      } else if (path === '/api/ingest/realtime') {
        sendJson(res, 200, store.ingest('realtime', demo.realtimeBatch()));
      } else if (path === '/api/ingest/archive') {
        sendJson(res, 200, store.ingest('archive', demo.archiveBatch()));
      } else if (path === '/api/ingest') {
        const body = await readJson(req);
        sendJson(res, 200, store.ingest(body && body.source, body && body.records));
      } else if (path === '/api/reset') {
        store = new TideStore();
        sendJson(res, 200, { ok: true });
      }
    } catch (err) {
      if (err instanceof IngestError) {
        sendJson(res, err.statusCode, { error: err.message });
      } else if (err && err.statusCode) {
        sendJson(res, err.statusCode, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: '服务器内部错误' });
      }
    }
  });
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`港口潮位演示服务已启动：http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createServer };

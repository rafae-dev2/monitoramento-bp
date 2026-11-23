// Emula a Netlify: serve o front-end estático e roteia /.netlify/functions/* para o handler real.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import handler from '../netlify/functions/session.mjs';

const ROOT = new URL('../public/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
};

const PORT = Number(process.env.PORT || 8079);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/.netlify/functions/')) {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    await new Promise((ok) => req.on('end', ok));
    const r = new Request('https://app.example.com' + url.pathname + url.search, {
      method: req.method,
      body: partes.length ? Buffer.concat(partes) : undefined,
      headers: {
        'x-forwarded-for': req.socket.remoteAddress || 'test',
        accept: req.headers.accept || '',
        'content-type': req.headers['content-type'] || 'application/json',
      },
    });
    try {
      const out = await handler(r, {});
      const body = await out.text();
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'handler explodiu', detalhe: String(e && e.stack) }));
    }
    return;
  }

  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = normalize(p).replace(/^(\.\.[/\\])+/, '');
  try {
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, {
      'content-type': TYPES[extname(p)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404');
  }
}).listen(PORT, '0.0.0.0', () => console.log('emulador Netlify em :' + PORT));

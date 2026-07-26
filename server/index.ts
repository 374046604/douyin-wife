import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { createObserverApp, attachShutdown } from './app';
import { LiveStore } from './store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env.local');
if (existsSync(envFile)) loadEnvFile(envFile);
const port = Number(process.env.PORT ?? 8787);
const dataFile = process.env.OBSERVER_DATA_FILE ?? join(root, 'data', 'observer-store.json');
const app = createObserverApp({ store: new LiveStore(dataFile), ingestUrl: `http://127.0.0.1:${port}/api/ingest` });
const dist = join(root, 'dist');

if (existsSync(dist)) {
  app.use(express.static(dist));
  app.use((request, response, next) => {
    if (request.path.startsWith('/api/')) return next();
    response.sendFile(join(dist, 'index.html'));
  });
}

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`潮汐观察台服务已启动：http://127.0.0.1:${port}`);
});

attachShutdown(server);

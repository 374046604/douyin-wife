import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Server } from 'node:http';
import type { CollectorStatus, EventFilter, LiveRoom } from '../src/types';
import { filterEvents, isValidLiveRoomUrl, liveRoomKey, toCsv } from '../src/lib/monitoring';
import { FirecrawlError, FirecrawlScraper, type WebScraper } from './firecrawl';
import { LiveStore } from './store';
import { LocalAvatarCache, type AvatarCache } from './avatar-cache';
import { isNonAvatarImageUrl } from './avatar-policy';

type AppOptions = { store: LiveStore; ingestUrl?: string; scraper?: WebScraper; avatarCache?: AvatarCache; allowServerFirecrawlKey?: boolean; licenseRequired?: boolean };

function isRoomStatus(value: unknown): value is LiveRoom['status'] {
  return value === 'observing' || value === 'paused';
}

function parseFilter(query: Record<string, unknown>): EventFilter {
  const kind = query.kind;
  return {
    kind: kind === 'comment' || kind === 'entry' || kind === 'system' ? kind : 'all',
    query: typeof query.query === 'string' ? query.query : '',
  };
}

function validIngestKind(value: unknown): value is 'comment' | 'entry' {
  return value === 'comment' || value === 'entry';
}

function text(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength ? value.trim() : undefined;
}

function isPublicWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch { return false; }
}

function isPublicDouyinProfileUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'www.douyin.com' || parsed.hostname === 'douyin.com')
      && parsed.pathname.startsWith('/user/');
  } catch { return false; }
}

function isPublicImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
      && !isNonAvatarImageUrl(value);
  } catch { return false; }
}

function licenseToken(request: express.Request): string | undefined {
  const header = request.get('X-License-Token');
  if (header?.trim()) return header.trim();
  return typeof request.query.license === 'string' ? request.query.license : undefined;
}

export function createObserverApp({ store, ingestUrl = 'http://127.0.0.1:8787/api/ingest', scraper = new FirecrawlScraper(), avatarCache = new LocalAvatarCache(store.getDataDirectory()), allowServerFirecrawlKey = process.env.NODE_ENV !== 'production', licenseRequired = true }: AppOptions): Express {
  const app = express();
  const collectorStatuses = new Map<string, CollectorStatus>();

  app.use(express.json({ limit: '32kb' }));
  app.use(['/api/ingest', '/api/collector-status'], (_request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-License-Token');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    next();
  });

  app.use('/api', (request, response, next) => {
    const publicPaths = new Set(['/health', '/licenses/activate', '/licenses/status']);
    if (publicPaths.has(request.path)) { next(); return; }
    if (licenseRequired && !store.getLicenseStatus(licenseToken(request)).active) {
      response.status(401).json({ error: '请先激活有效卡密后再使用观察台。' });
      return;
    }
    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', mode: 'authorized-ingest', dataPolicy: 'local-json' });
  });

  app.get('/api/licenses/status', (request, response) => response.json({ license: store.getLicenseStatus(licenseToken(request)) }));
  app.post('/api/licenses/activate', (request, response) => {
    const code = text(request.body?.code, 64)?.toUpperCase();
    const deviceName = text(request.body?.deviceName, 80) ?? '未命名设备';
    if (!code || !/^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$/u.test(code)) { response.status(400).json({ error: '卡密格式无效，请检查后重试。' }); return; }
    const activated = store.activateLicense(code, deviceName);
    if ('error' in activated) {
      response.status(activated.error === 'exhausted' ? 409 : 401).json({ error: activated.error === 'exhausted' ? '该卡密的激活次数已用完。' : '卡密无效或不存在。' });
      return;
    }
    response.json(activated);
  });
  app.get('/api/rooms', (_request, response) => response.json({ rooms: store.listRooms() }));

  app.get('/api/connection', (_request, response) => {
    response.json({ ingestKey: store.getIngestKey(), ingestUrl });
  });
  app.get('/api/collector-config', (request, response) => {
    const pageUrl = typeof request.query.url === 'string' ? request.query.url : '';
    const key = liveRoomKey(pageUrl);
    if (!key) { response.status(400).json({ error: '当前页面不是有效的抖音直播间链接。' }); return; }
    const room = store.listRooms().find((item) => liveRoomKey(item.url) === key);
    if (!room) { response.status(404).json({ error: '当前直播间尚未在观察台登记。' }); return; }
    if (room.status !== 'observing') { response.status(409).json({ error: '当前直播间已暂停观察。' }); return; }
    response.json({ settings: { endpoint: ingestUrl, key: store.getIngestKey(), licenseToken: licenseToken(request), roomId: room.id, autoDetect: 'on', profileLookup: 'on', eventKind: 'comment' } });
  });
  app.get('/api/rooms/:id/collector-status', (request, response) => {
    if (!store.getRoom(request.params.id)) { response.status(404).json({ error: '未找到直播间。' }); return; }
    response.json({ status: collectorStatuses.get(request.params.id) ?? null });
  });
  app.get('/api/data-status', (_request, response) => response.json(store.getDataStatus()));
  app.post('/api/data/clear-demo', (_request, response) => response.json(store.clearDemoData()));
  app.get('/api/web-snapshots', (_request, response) => response.json({ configured: allowServerFirecrawlKey && scraper.isConfigured(), acceptsUserProvidedKey: true, snapshots: store.listWebSnapshots() }));
  app.post('/api/web-snapshots', async (request, response) => {
    const url = request.body?.url;
    if (!isPublicWebUrl(url)) { response.status(400).json({ error: '请输入可公开访问的完整 http(s) 页面链接。' }); return; }
    try {
      const userApiKey = text(request.body?.firecrawlApiKey, 512);
      const activeScraper = userApiKey ? new FirecrawlScraper(userApiKey) : scraper;
      if (!userApiKey && !allowServerFirecrawlKey) throw new FirecrawlError('请填写你自己的 Firecrawl API Key；生产环境不会使用服务方密钥。', 400);
      const snapshot = store.addWebSnapshot(await activeScraper.scrape(url));
      response.status(201).json({ snapshot });
    } catch (error) {
      if (error instanceof FirecrawlError) { response.status(error.status).json({ error: error.message }); return; }
      response.status(502).json({ error: '网页抓取失败，请稍后重试。' });
    }
  });

  app.get('/api/alert-rules', (_request, response) => response.json({ rules: store.listAlertRules() }));
  app.post('/api/alert-rules', (request, response) => {
    const keyword = text(request.body?.keyword, 60);
    if (!keyword) { response.status(400).json({ error: '请输入 1–60 个字符的告警关键词。' }); return; }
    if (store.listAlertRules().some((rule) => rule.keyword.toLocaleLowerCase() === keyword.toLocaleLowerCase())) { response.status(409).json({ error: '该告警关键词已存在。' }); return; }
    response.status(201).json({ rule: store.addAlertRule(keyword) });
  });
  app.patch('/api/alert-rules/:id', (request, response) => {
    if (typeof request.body?.enabled !== 'boolean') { response.status(400).json({ error: '请提供 enabled 布尔值。' }); return; }
    const rule = store.updateAlertRule(request.params.id, request.body.enabled);
    if (!rule) { response.status(404).json({ error: '未找到告警规则。' }); return; }
    response.json({ rule });
  });
  app.delete('/api/alert-rules/:id', (request, response) => {
    if (!store.removeAlertRule(request.params.id)) { response.status(404).json({ error: '未找到告警规则。' }); return; }
    response.json({ deleted: true });
  });
  app.get('/api/rooms/:id/alerts', (request, response) => {
    if (!store.getRoom(request.params.id)) { response.status(404).json({ error: '未找到直播间。' }); return; }
    response.json({ alerts: store.listAlerts(request.params.id) });
  });
  app.patch('/api/alerts/:id', (request, response) => {
    if (request.body?.status !== 'acknowledged') { response.status(400).json({ error: '当前只支持确认告警。' }); return; }
    const alert = store.acknowledgeAlert(request.params.id);
    if (!alert) { response.status(404).json({ error: '未找到告警。' }); return; }
    response.json({ alert });
  });

  app.post('/api/rooms', (request, response) => {
    const { url, title } = request.body as { url?: unknown; title?: unknown };
    if (typeof url !== 'string' || !isValidLiveRoomUrl(url)) {
      response.status(400).json({ error: '请输入完整的 https://live.douyin.com/直播间标识 链接。' });
      return;
    }
    if (title !== undefined && (typeof title !== 'string' || title.trim().length > 80)) {
      response.status(400).json({ error: '显示名称需为 1–80 个字符。' });
      return;
    }
    const idFromUrl = new URL(url).pathname.slice(1);
    const room = store.addRoom({ title: title?.trim() || `授权直播间 · ${idFromUrl}`, url: url.trim() });
    response.status(201).json({ room });
  });

  app.get('/api/rooms/:id/save', (request, response) => {
    const room = store.getRoom(request.params.id);
    const savePath = store.getRoomSaveFilePath(request.params.id);
    if (!room || !savePath || !existsSync(savePath)) { response.status(404).json({ error: '未找到该直播间的采集存档。' }); return; }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${room.id}.save.json"`);
    response.send(readFileSync(savePath, 'utf8'));
  });
  app.get('/api/rooms/:id/avatars/:fileName', (request, response) => {
    if (!store.getRoom(request.params.id) || !/^[a-f0-9]{24}\.(jpg|png|webp|gif)$/u.test(request.params.fileName)) {
      response.status(404).end();
      return;
    }
    const avatarPath = join(store.getDataDirectory(), 'saves', request.params.id, 'avatars', basename(request.params.fileName));
    if (!existsSync(avatarPath)) { response.status(404).end(); return; }
    response.sendFile(avatarPath);
  });
  app.post('/api/rooms/:id/snapshot', async (request, response) => {
    const room = store.getRoom(request.params.id);
    if (!room) { response.status(404).json({ error: '未找到对应的授权直播间。' }); return; }
    try {
      const userApiKey = text(request.body?.firecrawlApiKey, 512);
      const activeScraper = userApiKey ? new FirecrawlScraper(userApiKey) : scraper;
      if (!userApiKey && !allowServerFirecrawlKey) throw new FirecrawlError('请填写你自己的 Firecrawl API Key；生产环境不会使用服务方密钥。', 400);
      const scraped = await activeScraper.scrape(room.url);
      const snapshot = store.addRoomWebSnapshot(room.id, scraped);
      response.status(201).json({ snapshot });
    } catch (error) {
      if (error instanceof FirecrawlError) { response.status(error.status).json({ error: error.message }); return; }
      response.status(502).json({ error: '网页快照抓取失败，请稍后重试。' });
    }
  });

  app.patch('/api/rooms/:id', (request, response) => {
    const status = request.body?.status;
    if (!isRoomStatus(status)) {
      response.status(400).json({ error: '状态只能是 observing 或 paused。' });
      return;
    }
    const room = store.updateRoomStatus(request.params.id, status);
    if (!room) {
      response.status(404).json({ error: '未找到直播间。' });
      return;
    }
    response.json({ room });
  });

  app.delete('/api/rooms/:id', (request, response) => {
    if (!store.removeRoom(request.params.id)) { response.status(404).json({ error: '未找到直播间。' }); return; }
    response.json({ deleted: true });
  });

  app.get('/api/rooms/:id/events', (request, response) => {
    if (!store.getRoom(request.params.id)) {
      response.status(404).json({ error: '未找到直播间。' });
      return;
    }
    response.json({ events: filterEvents(store.listEvents(request.params.id), parseFilter(request.query)) });
  });

  app.get('/api/rooms/:id/export.csv', (request, response) => {
    if (!store.getRoom(request.params.id)) {
      response.status(404).json({ error: '未找到直播间。' });
      return;
    }
    const events = filterEvents(store.listEvents(request.params.id), parseFilter(request.query));
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="observer-${request.params.id}.csv"`);
    response.send(`\uFEFF${toCsv(events)}`);
  });

  const recentIngestions = new Map<string, number>();
  app.options('/api/ingest', (_request, response) => response.sendStatus(204));
  app.options('/api/collector-status', (_request, response) => response.sendStatus(204));
  app.options('/api/profile-account', (_request, response) => response.sendStatus(204));
  app.options('/api/profile-avatar', (_request, response) => response.sendStatus(204));
  app.options('/api/profile-link', (_request, response) => response.sendStatus(204));
  app.post('/api/collector-status', (request, response) => {
    const { key, roomId, state, mode, matchCount } = request.body as Record<string, unknown>;
    if (key !== store.getIngestKey()) { response.status(401).json({ error: '采集密钥无效。' }); return; }
    if (typeof roomId !== 'string' || !store.getRoom(roomId)) { response.status(404).json({ error: '未找到对应的授权直播间。' }); return; }
    if ((state !== 'active' && state !== 'matched') || (mode !== 'auto' && mode !== 'manual') || typeof matchCount !== 'number' || !Number.isInteger(matchCount) || matchCount < 0 || matchCount > 10_000) {
      response.status(400).json({ error: '采集器状态格式无效。' }); return;
    }
    const status: CollectorStatus = { state, mode, matchCount, updatedAt: new Date().toISOString() };
    collectorStatuses.set(roomId, status);
    response.json({ accepted: true, status });
  });
  app.post('/api/ingest', async (request, response) => {
    const { key, roomId, kind, nickname, publicAccountId, avatarUrl, message, observedAt } = request.body as Record<string, unknown>;
    if (key !== store.getIngestKey()) {
      response.status(401).json({ error: '采集密钥无效。' });
      return;
    }
    const room = typeof roomId === 'string' ? store.getRoom(roomId) : undefined;
    if (!room) {
      response.status(404).json({ error: '未找到对应的授权直播间。' });
      return;
    }
    if (room.status !== 'observing') {
      response.status(409).json({ error: '该直播间已暂停接收事件。' });
      return;
    }
    const safeNickname = text(nickname, 80);
    const safeMessage = text(message, 1000);
    if (!validIngestKind(kind) || !safeNickname || !safeMessage) {
      response.status(400).json({ error: '采集事件必须包含类型、昵称和内容。' });
      return;
    }
    const safeAccountId = text(publicAccountId, 120) ?? '—';
    const fingerprint = `${room.id}:${kind}:${safeNickname}:${safeAccountId}:${safeMessage}`;
    const now = Date.now();
    if ((recentIngestions.get(fingerprint) ?? 0) > now - 15_000) {
      response.status(202).json({ accepted: false, duplicate: true });
      return;
    }
    recentIngestions.set(fingerprint, now);
    for (const [entry, receivedAt] of recentIngestions) if (receivedAt < now - 60_000) recentIngestions.delete(entry);
    const parsedTime = typeof observedAt === 'string' && !Number.isNaN(Date.parse(observedAt)) ? observedAt : new Date().toISOString();
    const safeAvatarUrl = isPublicImageUrl(avatarUrl) ? avatarUrl : undefined;
    const avatarFile = safeAvatarUrl ? await avatarCache.cache(room, safeAvatarUrl) : undefined;
    const event = { id: `extension-${randomUUID()}`, roomId: room.id, timestamp: parsedTime, kind, nickname: safeNickname, publicAccountId: safeAccountId, ...(safeAvatarUrl ? { avatarUrl: safeAvatarUrl } : {}), ...(avatarFile ? { avatarFile } : {}), message: safeMessage, source: 'browser_extension' } as const;
    store.appendEvent(event);
    response.status(201).json({ accepted: true, event });
  });
  app.post('/api/profile-account', (request, response) => {
    const { key, roomId, nickname, message, publicAccountId } = request.body as Record<string, unknown>;
    if (key !== store.getIngestKey()) { response.status(401).json({ error: '采集密钥无效。' }); return; }
    const room = typeof roomId === 'string' ? store.getRoom(roomId) : undefined;
    if (!room) { response.status(404).json({ error: '未找到对应的授权直播间。' }); return; }
    const safeNickname = text(nickname, 80);
    const safeMessage = text(message, 1000);
    const safeAccountId = text(publicAccountId, 120);
    if (!safeNickname || !safeMessage || !safeAccountId || !/^[a-z0-9._-]{3,120}$/iu.test(safeAccountId)) {
      response.status(400).json({ error: '公开抖音号格式无效。' }); return;
    }
    const event = store.updatePublicAccountForEvent({ roomId: room.id, nickname: safeNickname, message: safeMessage, publicAccountId: safeAccountId });
    if (!event) { response.status(404).json({ error: '未找到可回填的对应弹幕。' }); return; }
    response.json({ accepted: true, event });
  });
  app.post('/api/profile-avatar', async (request, response) => {
    const { key, roomId, nickname, message, avatarUrl } = request.body as Record<string, unknown>;
    if (key !== store.getIngestKey()) { response.status(401).json({ error: '采集密钥无效。' }); return; }
    const room = typeof roomId === 'string' ? store.getRoom(roomId) : undefined;
    if (!room) { response.status(404).json({ error: '未找到对应的授权直播间。' }); return; }
    const safeNickname = text(nickname, 80);
    const safeMessage = text(message, 1000);
    if (!safeNickname || !safeMessage || !isPublicImageUrl(avatarUrl)) {
      response.status(400).json({ error: '公开头像链接无效。' }); return;
    }
    const avatarFile = await avatarCache.cache(room, avatarUrl);
    if (!avatarFile) { response.status(422).json({ error: '公开头像下载失败。' }); return; }
    const event = store.updateAvatarForEvent({ roomId: room.id, nickname: safeNickname, message: safeMessage, avatarUrl, avatarFile });
    if (!event) { response.status(404).json({ error: '未找到可回填的对应弹幕。' }); return; }
    response.json({ accepted: true, event });
  });
  app.post('/api/profile-link', async (request, response) => {
    const { key, roomId, nickname, message, publicProfileUrl, avatarUrl } = request.body as Record<string, unknown>;
    if (key !== store.getIngestKey()) { response.status(401).json({ error: '采集密钥无效。' }); return; }
    const room = typeof roomId === 'string' ? store.getRoom(roomId) : undefined;
    if (!room) { response.status(404).json({ error: '未找到对应的授权直播间。' }); return; }
    const safeNickname = text(nickname, 80);
    const safeMessage = text(message, 1000);
    if (!safeNickname || !safeMessage || !isPublicDouyinProfileUrl(publicProfileUrl)) {
      response.status(400).json({ error: '公开抖音主页链接无效。' }); return;
    }
    const safeAvatarUrl = isPublicImageUrl(avatarUrl) ? avatarUrl : undefined;
    const avatarFile = safeAvatarUrl ? await avatarCache.cache(room, safeAvatarUrl) : undefined;
    const event = store.updatePublicProfileForEvent({ roomId: room.id, nickname: safeNickname, message: safeMessage, publicProfileUrl, ...(safeAvatarUrl ? { avatarUrl: safeAvatarUrl } : {}), ...(avatarFile ? { avatarFile } : {}) });
    if (!event) { response.status(404).json({ error: '未找到可回填的对应弹幕。' }); return; }
    response.json({ accepted: true, event });
  });

  app.get('/api/rooms/:id/stream', (request, response) => {
    const room = store.getRoom(request.params.id);
    if (!room) {
      response.status(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ roomId: room.id })}\n\n`);
    const unsubscribe = store.subscribe((event) => {
      if (event.roomId === room.id) response.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const unsubscribeAlerts = store.subscribeAlerts((alert) => {
      if (alert.roomId === room.id) response.write(`event: alert\ndata: ${JSON.stringify(alert)}\n\n`);
    });
    request.on('close', () => { unsubscribe(); unsubscribeAlerts(); response.end(); });
  });

  return app;
}

export function attachShutdown(server: Server): void {
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AlertRule, LiveEvent, LiveRoom, MonitorAlert, WebSnapshot } from '../src/types';
import { isNonAvatarImageUrl } from './avatar-policy';

export type ObserverStoreData = {
  rooms: LiveRoom[];
  events: LiveEvent[];
  config: { ingestKey: string };
  alertRules: AlertRule[];
  alerts: MonitorAlert[];
  webSnapshots: WebSnapshot[];
  licenses: LicenseCard[];
};

type LicenseActivation = {
  tokenHash: string;
  deviceName: string;
  activatedAt: string;
  expiresAt: string;
};

type LicenseCard = {
  id: string;
  codeHash: string;
  codeHint: string;
  durationDays: number;
  maxActivations: number;
  createdAt: string;
  activations: LicenseActivation[];
};

export type LicenseStatus = {
  active: boolean;
  expiresAt?: string;
  deviceName?: string;
};

type RoomSaveData = {
  format: 'tide-observer-room-save/v1';
  room: LiveRoom;
  events: LiveEvent[];
  alerts: MonitorAlert[];
  webSnapshots: WebSnapshot[];
  createdAt: string;
  updatedAt: string;
};

function initialData(): ObserverStoreData {
  return { rooms: [], events: [], config: { ingestKey: randomUUID().replaceAll('-', '') }, alertRules: [], alerts: [], webSnapshots: [], licenses: [] };
}

function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isDemoRoom(room: LiveRoom): boolean {
  return room.id.startsWith('room-citrus') || room.id.startsWith('room-river') || room.url.includes('/demo-');
}

function isDemoEvent(event: LiveEvent, demoRoomIds: Set<string>): boolean {
  return demoRoomIds.has(event.roomId) || event.source === 'demo' || event.publicAccountId.startsWith('demo_');
}

export class LiveStore {
  private data: ObserverStoreData;
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private readonly alertListeners = new Set<(alert: MonitorAlert) => void>();

  constructor(private readonly filePath: string) {
    this.data = this.load();
    this.removeSavedNonAvatarBadges();
  }

  listRooms(): LiveRoom[] {
    return [...this.data.rooms].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getRoom(id: string): LiveRoom | undefined {
    return this.data.rooms.find((room) => room.id === id);
  }

  getRoomSaveFilePath(id: string): string | undefined {
    const room = this.getRoom(id);
    return room?.saveFile ? join(dirname(this.filePath), room.saveFile) : undefined;
  }

  getDataDirectory(): string { return dirname(this.filePath); }

  getIngestKey(): string { return this.data.config.ingestKey; }

  activateLicense(code: string, deviceName: string): { token: string; status: LicenseStatus } | { error: 'invalid' | 'exhausted' } {
    const card = this.data.licenses.find((item) => item.codeHash === secretHash(code));
    if (!card) return { error: 'invalid' };
    if (card.activations.length >= card.maxActivations) return { error: 'exhausted' };
    const token = randomBytes(32).toString('base64url');
    const activatedAt = new Date();
    const expiresAt = new Date(activatedAt.getTime() + card.durationDays * 86_400_000).toISOString();
    const activation: LicenseActivation = { tokenHash: secretHash(token), deviceName, activatedAt: activatedAt.toISOString(), expiresAt };
    card.activations.push(activation);
    this.persist();
    return { token, status: { active: true, expiresAt, deviceName } };
  }

  getLicenseStatus(token: string | undefined): LicenseStatus {
    if (!token) return { active: false };
    const activation = this.data.licenses.flatMap((card) => card.activations).find((item) => item.tokenHash === secretHash(token));
    if (!activation || Date.parse(activation.expiresAt) <= Date.now()) return { active: false };
    return { active: true, expiresAt: activation.expiresAt, deviceName: activation.deviceName };
  }

  listWebSnapshots(): WebSnapshot[] { return [...this.data.webSnapshots].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)); }

  addWebSnapshot(snapshot: Omit<WebSnapshot, 'id'>): WebSnapshot {
    const saved: WebSnapshot = { ...snapshot, id: `snapshot-${randomUUID()}` };
    this.data.webSnapshots.unshift(saved);
    this.data.webSnapshots = this.data.webSnapshots.slice(0, 100);
    this.persist();
    return saved;
  }

  addRoomWebSnapshot(roomId: string, snapshot: Omit<WebSnapshot, 'id' | 'roomId'>): WebSnapshot | undefined {
    if (!this.getRoom(roomId)) return undefined;
    const saved: WebSnapshot = { ...snapshot, id: `snapshot-${randomUUID()}`, roomId };
    this.data.webSnapshots.unshift(saved);
    this.data.webSnapshots = this.data.webSnapshots.slice(0, 100);
    this.persist();
    this.writeRoomSave(roomId);
    return saved;
  }

  getDataStatus(): { demoRoomCount: number; demoEventCount: number } {
    const demoRoomIds = new Set(this.data.rooms.filter(isDemoRoom).map((room) => room.id));
    return { demoRoomCount: demoRoomIds.size, demoEventCount: this.data.events.filter((event) => isDemoEvent(event, demoRoomIds)).length };
  }

  clearDemoData(): { demoRoomCount: number; demoEventCount: number } {
    const before = this.getDataStatus();
    const demoRoomIds = new Set(this.data.rooms.filter(isDemoRoom).map((room) => room.id));
    this.data.rooms = this.data.rooms.filter((room) => !demoRoomIds.has(room.id));
    const demoEventIds = new Set(this.data.events.filter((event) => isDemoEvent(event, demoRoomIds)).map((event) => event.id));
    this.data.events = this.data.events.filter((event) => !demoEventIds.has(event.id));
    this.data.alerts = this.data.alerts.filter((alert) => !demoRoomIds.has(alert.roomId) && !demoEventIds.has(alert.eventId));
    this.persist();
    return before;
  }

  listAlertRules(): AlertRule[] { return [...this.data.alertRules].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  addAlertRule(keyword: string): AlertRule {
    const rule: AlertRule = { id: `rule-${randomUUID()}`, keyword, enabled: true, createdAt: new Date().toISOString() };
    this.data.alertRules.unshift(rule);
    this.persist();
    return rule;
  }

  updateAlertRule(id: string, enabled: boolean): AlertRule | undefined {
    const rule = this.data.alertRules.find((item) => item.id === id);
    if (!rule) return undefined;
    rule.enabled = enabled;
    this.persist();
    return rule;
  }

  removeAlertRule(id: string): boolean {
    const count = this.data.alertRules.length;
    this.data.alertRules = this.data.alertRules.filter((item) => item.id !== id);
    if (count === this.data.alertRules.length) return false;
    this.persist();
    return true;
  }

  listAlerts(roomId: string): MonitorAlert[] {
    return this.data.alerts.filter((alert) => alert.roomId === roomId).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  acknowledgeAlert(id: string): MonitorAlert | undefined {
    const alert = this.data.alerts.find((item) => item.id === id);
    if (!alert) return undefined;
    alert.status = 'acknowledged';
    this.persist();
    return alert;
  }

  addRoom({ title, url }: Pick<LiveRoom, 'title' | 'url'>): LiveRoom {
    const id = `room-${randomUUID()}`;
    const room: LiveRoom = { id, title, url, saveFile: join('saves', `${id}.save.json`), status: 'observing', startedAt: new Date().toISOString() };
    this.data.rooms.unshift(room);
    this.appendEvent({ id: `system-${randomUUID()}`, roomId: room.id, timestamp: new Date().toISOString(), kind: 'system', nickname: '观察台', publicAccountId: '—', message: '已登记授权直播间；等待已授权数据源接入。' });
    this.persist();
    return room;
  }

  updateRoomStatus(id: string, status: LiveRoom['status']): LiveRoom | undefined {
    const room = this.getRoom(id);
    if (!room) return undefined;
    room.status = status;
    this.persist();
    this.writeRoomSave(room.id);
    return room;
  }

  removeRoom(id: string): boolean {
    const room = this.getRoom(id);
    if (!room) return false;
    const savePath = this.getRoomSaveFilePath(id);
    this.data.rooms = this.data.rooms.filter((item) => item.id !== id);
    const eventIds = new Set(this.data.events.filter((event) => event.roomId === id).map((event) => event.id));
    this.data.events = this.data.events.filter((event) => event.roomId !== id);
    this.data.alerts = this.data.alerts.filter((alert) => alert.roomId !== id && !eventIds.has(alert.eventId));
    this.data.webSnapshots = this.data.webSnapshots.filter((snapshot) => snapshot.roomId !== id);
    this.persist();
    if (savePath && existsSync(savePath)) unlinkSync(savePath);
    return true;
  }

  listEvents(roomId: string): LiveEvent[] {
    return this.data.events.filter((event) => event.roomId === roomId).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  }

  appendEvent(event: LiveEvent): void {
    this.data.events.unshift(event);
    this.data.events = this.data.events.slice(0, 1000);
    const triggered = event.kind === 'comment' ? this.data.alertRules
      .filter((rule) => rule.enabled && event.message.toLocaleLowerCase().includes(rule.keyword.toLocaleLowerCase()))
      .map((rule) => ({ id: `alert-${randomUUID()}`, eventId: event.id, roomId: event.roomId, ruleId: rule.id, keyword: rule.keyword, timestamp: new Date().toISOString(), status: 'new' as const, nickname: event.nickname, message: event.message })) : [];
    this.data.alerts.unshift(...triggered);
    this.data.alerts = this.data.alerts.slice(0, 500);
    this.persist();
    this.writeRoomSave(event.roomId);
    this.listeners.forEach((listener) => listener(event));
    triggered.forEach((alert) => this.alertListeners.forEach((listener) => listener(alert)));
  }

  updatePublicAccountForEvent({ roomId, nickname, message, publicAccountId }: Pick<LiveEvent, 'roomId' | 'nickname' | 'message' | 'publicAccountId'>): LiveEvent | undefined {
    const index = this.data.events.findIndex((event) => event.roomId === roomId
      && event.nickname === nickname
      && event.message === message
      && event.publicAccountId === '—');
    if (index < 0) return undefined;
    const event = { ...this.data.events[index], publicAccountId };
    this.data.events[index] = event;
    this.persist();
    this.writeRoomSave(roomId);
    this.listeners.forEach((listener) => listener(event));
    return event;
  }

  updateAvatarForEvent({ roomId, nickname, message, avatarUrl, avatarFile }: Pick<LiveEvent, 'roomId' | 'nickname' | 'message' | 'avatarUrl' | 'avatarFile'>): LiveEvent | undefined {
    const index = this.data.events.findIndex((event) => event.roomId === roomId
      && event.nickname === nickname
      && event.message === message
      && !event.avatarFile);
    if (index < 0) return undefined;
    const event = { ...this.data.events[index], avatarUrl, avatarFile };
    this.data.events[index] = event;
    this.persist();
    this.writeRoomSave(roomId);
    this.listeners.forEach((listener) => listener(event));
    return event;
  }

  updatePublicProfileForEvent({ roomId, nickname, message, publicProfileUrl, avatarUrl, avatarFile }: Pick<LiveEvent, 'roomId' | 'nickname' | 'message'> & { publicProfileUrl: string; avatarUrl?: string; avatarFile?: string }): LiveEvent | undefined {
    const index = this.data.events.findIndex((event) => event.roomId === roomId
      && event.nickname === nickname
      && event.message === message
      && !event.publicProfileUrl);
    if (index < 0) return undefined;
    const event = { ...this.data.events[index], publicProfileUrl, ...(avatarUrl ? { avatarUrl } : {}), ...(avatarFile ? { avatarFile } : {}) };
    this.data.events[index] = event;
    this.persist();
    this.writeRoomSave(roomId);
    this.listeners.forEach((listener) => listener(event));
    return event;
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeAlerts(listener: (alert: MonitorAlert) => void): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  private load(): ObserverStoreData {
    if (!existsSync(this.filePath)) {
      const data = initialData();
      this.write(data);
      return data;
    }
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ObserverStoreData>;
    const data: ObserverStoreData = {
      rooms: (parsed.rooms ?? []).map((room) => ({ ...room, saveFile: room.saveFile ?? join('saves', `${room.id}.save.json`) })),
      events: parsed.events ?? [],
      config: parsed.config?.ingestKey ? parsed.config : { ingestKey: randomUUID().replaceAll('-', '') },
      alertRules: parsed.alertRules ?? [],
      alerts: parsed.alerts ?? [],
      webSnapshots: parsed.webSnapshots ?? [],
      licenses: parsed.licenses ?? [],
    };
    if (!parsed.config?.ingestKey) this.write(data);
    return data;
  }

  private persist(): void { this.write(this.data); }

  /** 清掉旧版把等级徽章误保存为头像的记录与缓存文件。 */
  private removeSavedNonAvatarBadges(): void {
    const stale = this.data.events.filter((event) => isNonAvatarImageUrl(event.avatarUrl));
    if (stale.length === 0) return;
    this.data.events = this.data.events.map((event) => {
      if (!isNonAvatarImageUrl(event.avatarUrl)) return event;
      const { avatarUrl: _avatarUrl, avatarFile: _avatarFile, ...withoutBadge } = event;
      return withoutBadge;
    });
    this.persist();
    const stillReferenced = new Set(this.data.events.map((event) => event.avatarFile).filter(Boolean));
    stale.forEach((event) => {
      if (!event.avatarFile || stillReferenced.has(event.avatarFile)) return;
      const avatarsDirectory = join(dirname(this.filePath), 'saves', event.roomId, 'avatars');
      const avatarPath = join(dirname(this.filePath), event.avatarFile);
      if (avatarPath.startsWith(avatarsDirectory) && existsSync(avatarPath)) unlinkSync(avatarPath);
    });
    new Set(stale.map((event) => event.roomId)).forEach((roomId) => this.writeRoomSave(roomId));
  }

  private write(data: ObserverStoreData): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private writeRoomSave(roomId: string): void {
    const room = this.getRoom(roomId);
    if (!room) return;
    const savePath = this.getRoomSaveFilePath(roomId);
    if (!savePath) return;
    const existing = existsSync(savePath) ? JSON.parse(readFileSync(savePath, 'utf8')) as Partial<RoomSaveData> : undefined;
    const data: RoomSaveData = {
      format: 'tide-observer-room-save/v1',
      room,
      events: this.listEvents(roomId),
      alerts: this.listAlerts(roomId),
      webSnapshots: this.data.webSnapshots.filter((snapshot) => snapshot.roomId === roomId).sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)),
      createdAt: existing?.createdAt ?? room.startedAt,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf8');
  }
}

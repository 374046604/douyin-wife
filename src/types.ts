export type EventKind = 'comment' | 'entry' | 'system';

export type LiveRoom = {
  id: string;
  title: string;
  url: string;
  saveFile: string;
  status: 'observing' | 'paused';
  startedAt: string;
};

export type LiveEvent = {
  id: string;
  roomId: string;
  timestamp: string;
  kind: EventKind;
  nickname: string;
  publicAccountId: string;
  /** 仅保存资料卡实际打开的公开抖音主页，不会根据昵称猜测。 */
  publicProfileUrl?: string;
  /** 仅保存页面或资料卡实际显示的公开头像链接。 */
  avatarUrl?: string;
  /** 本机缓存的头像文件，相对于 data/ 目录。 */
  avatarFile?: string;
  message: string;
  source?: 'demo' | 'browser_extension';
};

export type BrowserConnection = {
  ingestKey: string;
  ingestUrl: string;
};

export type LicenseStatus = {
  active: boolean;
  expiresAt?: string;
  deviceName?: string;
};

export type CollectorStatus = {
  state: 'active' | 'matched';
  mode: 'auto' | 'manual';
  matchCount: number;
  updatedAt: string;
};

export type AlertRule = {
  id: string;
  keyword: string;
  enabled: boolean;
  createdAt: string;
};

export type MonitorAlert = {
  id: string;
  eventId: string;
  roomId: string;
  ruleId: string;
  keyword: string;
  timestamp: string;
  status: 'new' | 'acknowledged';
  nickname: string;
  message: string;
};

export type DataStatus = {
  demoRoomCount: number;
  demoEventCount: number;
};

export type WebSnapshot = {
  id: string;
  roomId?: string;
  url: string;
  sourceUrl: string;
  title: string;
  content: string;
  fetchedAt: string;
  provider: 'firecrawl';
};

export type EventFilter = {
  kind: EventKind | 'all';
  query: string;
};

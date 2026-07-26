import type { AlertRule, BrowserConnection, CollectorStatus, DataStatus, LicenseStatus, LiveEvent, LiveRoom, MonitorAlert, WebSnapshot } from '../types';

type ApiError = { error?: string };

let currentLicenseToken = '';

function withLicense(input: string): string {
  if (!currentLicenseToken) return input;
  const url = new URL(input, window.location.origin);
  url.searchParams.set('license', currentLicenseToken);
  return `${url.pathname}${url.search}`;
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (currentLicenseToken) headers.set('X-License-Token', currentLicenseToken);
  const response = await fetch(input, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiError;
    throw new Error(body.error ?? '服务暂时不可用，请稍后重试。');
  }
  return response.json() as Promise<T>;
}

export const observerApi = {
  setLicenseToken: (token: string) => { currentLicenseToken = token; },
  getLicenseToken: () => currentLicenseToken,
  licenseStatus: () => request<{ license: LicenseStatus }>('/api/licenses/status'),
  activateLicense: (code: string, deviceName: string) => request<{ token: string; status: LicenseStatus }>('/api/licenses/activate', { method: 'POST', body: JSON.stringify({ code, deviceName }) }),
  rooms: () => request<{ rooms: LiveRoom[] }>('/api/rooms'),
  connection: () => request<BrowserConnection>('/api/connection'),
  collectorStatus: (roomId: string) => request<{ status: CollectorStatus | null }>(`/api/rooms/${roomId}/collector-status`),
  dataStatus: () => request<DataStatus>('/api/data-status'),
  clearDemoData: () => request<DataStatus>('/api/data/clear-demo', { method: 'POST' }),
  webSnapshots: () => request<{ configured: boolean; snapshots: WebSnapshot[] }>('/api/web-snapshots'),
  createWebSnapshot: (url: string, firecrawlApiKey?: string) => request<{ snapshot: WebSnapshot }>('/api/web-snapshots', { method: 'POST', body: JSON.stringify({ url, ...(firecrawlApiKey ? { firecrawlApiKey } : {}) }) }),
  alertRules: () => request<{ rules: AlertRule[] }>('/api/alert-rules'),
  createAlertRule: (keyword: string) => request<{ rule: AlertRule }>('/api/alert-rules', { method: 'POST', body: JSON.stringify({ keyword }) }),
  updateAlertRule: (id: string, enabled: boolean) => request<{ rule: AlertRule }>(`/api/alert-rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteAlertRule: (id: string) => request<{ deleted: boolean }>(`/api/alert-rules/${id}`, { method: 'DELETE' }),
  alerts: (roomId: string) => request<{ alerts: MonitorAlert[] }>(`/api/rooms/${roomId}/alerts`),
  acknowledgeAlert: (id: string) => request<{ alert: MonitorAlert }>(`/api/alerts/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'acknowledged' }) }),
  events: (roomId: string) => request<{ events: LiveEvent[] }>(`/api/rooms/${roomId}/events`),
  createRoom: (payload: { url: string; title?: string }) => request<{ room: LiveRoom }>('/api/rooms', { method: 'POST', body: JSON.stringify(payload) }),
  updateRoom: (id: string, status: LiveRoom['status']) => request<{ room: LiveRoom }>(`/api/rooms/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  deleteRoom: (id: string) => request<{ deleted: boolean }>(`/api/rooms/${id}`, { method: 'DELETE' }),
  stream: (roomId: string) => new EventSource(withLicense(`/api/rooms/${roomId}/stream`)),
  exportUrl: (roomId: string, kind: string, query: string) => {
    const params = new URLSearchParams();
    if (kind !== 'all') params.set('kind', kind);
    if (query.trim()) params.set('query', query.trim());
    return withLicense(`/api/rooms/${roomId}/export.csv?${params.toString()}`);
  },
  saveUrl: (roomId: string) => withLicense(`/api/rooms/${roomId}/save`),
  avatarUrl: (roomId: string, fileName: string) => withLicense(`/api/rooms/${roomId}/avatars/${encodeURIComponent(fileName)}`),
  captureRoomSnapshot: (roomId: string, firecrawlApiKey?: string) => request<{ snapshot: WebSnapshot }>(`/api/rooms/${roomId}/snapshot`, { method: 'POST', body: JSON.stringify({ ...(firecrawlApiKey ? { firecrawlApiKey } : {}) }) }),
};

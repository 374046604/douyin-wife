import type { EventFilter, LiveEvent } from '../types';

export function sortEventsChronologically(events: LiveEvent[]): LiveEvent[] {
  return [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
}

export function filterEvents(events: LiveEvent[], filter: EventFilter): LiveEvent[] {
  const query = filter.query.trim().toLocaleLowerCase();

  return events.filter((event) => {
    const matchesKind = filter.kind === 'all' || event.kind === filter.kind;
    const matchesQuery = !query || [event.nickname, event.publicAccountId, event.publicProfileUrl ?? '', event.message]
      .some((value) => value.toLocaleLowerCase().includes(query));

    return matchesKind && matchesQuery;
  });
}

export function summarizeEvents(events: LiveEvent[]) {
  return {
    total: events.length,
    comments: events.filter((event) => event.kind === 'comment').length,
    entries: events.filter((event) => event.kind === 'entry').length,
    accounts: new Set(events.filter((event) => event.kind !== 'system' && (event.publicAccountId !== '—' || event.publicProfileUrl))
      .map((event) => event.publicAccountId !== '—' ? event.publicAccountId : event.publicProfileUrl)).size,
  };
}

function escapeCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function toCsv(events: LiveEvent[]): string {
  const header = ['发生时间', '事件类型', '直播间', '昵称', '公开账号标识', '公开主页链接', '公开头像链接', '本地头像文件', '内容'];
  const rows = sortEventsChronologically(events).map((event) => [
    new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false }),
    event.kind === 'comment' ? '公开弹幕' : event.kind === 'entry' ? '进入直播间' : '系统事件',
    event.roomId,
    event.nickname,
    event.publicAccountId,
    event.publicProfileUrl ?? '—',
    event.avatarUrl ?? '—',
    event.avatarFile ?? '—',
    event.message,
  ]);

  return [header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
}

export function isValidLiveRoomUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'live.douyin.com' && url.pathname.length > 1;
  } catch {
    return false;
  }
}

export function liveRoomKey(value: string): string | undefined {
  if (!isValidLiveRoomUrl(value)) return undefined;
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

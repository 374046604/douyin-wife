import { FormEvent, useEffect, useMemo, useState } from 'react';
import { observerApi } from './lib/api';
import { formatTime, sortEventsChronologically, filterEvents, summarizeEvents } from './lib/monitoring';
import type { AlertRule, BrowserConnection, CollectorStatus, DataStatus, EventFilter, EventKind, LicenseStatus, LiveEvent, LiveRoom, MonitorAlert } from './types';
import './App.css';

const eventLabels: Record<EventKind, string> = { comment: '公开弹幕', entry: '进入直播间', system: '系统弹幕' };

function douyinUserSearchUrl(nickname: string): string {
  return `https://www.douyin.com/search/${encodeURIComponent(nickname)}?type=user`;
}

function localAvatarUrl(event: LiveEvent): string | undefined {
  // Only show locally cached avatars. Don't fall back to CDN URLs that may be expired or wrong (e.g. level badges).
  if (event.avatarFile) return observerApi.avatarUrl(event.roomId, event.avatarFile.split('/').pop() ?? '');
  return undefined;
}

function App() {
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [licenseCode, setLicenseCode] = useState('');
  const [licenseError, setLicenseError] = useState('');
  const [isActivatingLicense, setIsActivatingLicense] = useState(false);
  const [isActivationFormOpen, setIsActivationFormOpen] = useState(false);
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState('');
  const [kind, setKind] = useState<EventKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [roomUrl, setRoomUrl] = useState('');
  const [roomTitle, setRoomTitle] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('正在连接本地观察服务…');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [connection, setConnection] = useState<BrowserConnection | null>(null);
  const [collectorStatus, setCollectorStatus] = useState<CollectorStatus | null>(null);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [alerts, setAlerts] = useState<MonitorAlert[]>([]);
  const [ruleKeyword, setRuleKeyword] = useState('');
  const [ruleError, setRuleError] = useState('');
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null);
  const [captureUrl, setCaptureUrl] = useState('');
  const [captureError, setCaptureError] = useState('');
  const [isStartingCapture, setIsStartingCapture] = useState(false);
  const [firecrawlApiKey, setFirecrawlApiKey] = useState(() => window.localStorage.getItem('tide-firecrawl-api-key') ?? '');

  const isLicensed = license?.active === true;

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const filteredRoomTitle = selectedRoom ? (kind !== 'all' || query ? `${kind === 'all' ? '全部事件' : eventLabels[kind]} · ${selectedRoom.title}` : selectedRoom.title) : '';

  const speakerEvents = useMemo(() => sortEventsChronologically(events.filter((event) => event.kind === 'comment' && event.avatarFile)).slice(-80), [events]);

  const filters: EventFilter = { kind, query };
  const filteredEvents = useMemo(() => filterEvents(events, filters), [events, kind, query]);
  const summary = useMemo(() => summarizeEvents(filteredEvents), [filteredEvents]);

  useEffect(() => {
    const token = window.localStorage.getItem('tide-license-token') ?? '';
    observerApi.setLicenseToken(token);
    observerApi.licenseStatus()
      .then(({ license: nextLicense }) => {
        if (!nextLicense.active) {
          window.localStorage.removeItem('tide-license-token');
          observerApi.setLicenseToken('');
        }
        setLicense(nextLicense);
      })
      .catch(() => setLicense({ active: false }));
  }, []);

  useEffect(() => {
    if (!isLicensed) return;
    let active = true;
    setIsLoading(true);
    observerApi.rooms()
      .then(({ rooms: nextRooms }) => {
        if (!active) return;
        setRooms(nextRooms);
        setSelectedRoomId((current) => current || nextRooms[0]?.id || '');
        setNotice('本地观察服务已连接；等待已授权来源写入事件。');
      })
      .catch((reason: Error) => active && setError(reason.message))
      .finally(() => active && setIsLoading(false));
    return () => { active = false; };
  }, [isLicensed]);

  useEffect(() => {
    if (!isLicensed) return;
    observerApi.connection().then(setConnection).catch(() => undefined);
    observerApi.alertRules().then(({ rules }) => setAlertRules(rules)).catch(() => undefined);
    observerApi.dataStatus().then(setDataStatus).catch(() => undefined);
  }, [isLicensed]);

  useEffect(() => {
    if (!isLicensed || !selectedRoomId) return undefined;
    let active = true;
    setError('');
    observerApi.events(selectedRoomId)
      .then(({ events: nextEvents }) => active && setEvents(nextEvents))
      .catch((reason: Error) => active && setError(reason.message));
    observerApi.alerts(selectedRoomId)
      .then(({ alerts: nextAlerts }) => active && setAlerts(nextAlerts))
      .catch((reason: Error) => active && setError(reason.message));

    const stream = observerApi.stream(selectedRoomId);
    stream.addEventListener('event', (raw) => {
      if (!active) return;
      const event = JSON.parse((raw as MessageEvent<string>).data) as LiveEvent;
      setEvents((current) => sortEventsChronologically([...current.filter((item) => item.id !== event.id), event]).slice(-1000));
    });
    stream.addEventListener('alert', (raw) => {
      if (!active) return;
      const alert = JSON.parse((raw as MessageEvent<string>).data) as MonitorAlert;
      setAlerts((current) => [alert, ...current.filter((item) => item.id !== alert.id)].slice(0, 100));
    });
    stream.onerror = () => active && setNotice('实时通道正在重连；已保存的记录仍可查看和导出。');
    return () => { active = false; stream.close(); };
  }, [isLicensed, selectedRoomId]);

  useEffect(() => {
    if (!isLicensed || !selectedRoomId) { setCollectorStatus(null); return undefined; }
    let active = true;
    const refresh = () => observerApi.collectorStatus(selectedRoomId)
      .then(({ status }) => active && setCollectorStatus(status))
      .catch(() => active && setCollectorStatus(null));
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [isLicensed, selectedRoomId]);

  async function toggleRoom() {
    if (!selectedRoom) return;
    const nextStatus = selectedRoom.status === 'observing' ? 'paused' : 'observing';
    try {
      const { room } = await observerApi.updateRoom(selectedRoom.id, nextStatus);
      setRooms((current) => current.map((item) => item.id === room.id ? room : item));
      setNotice(nextStatus === 'observing' ? '已恢复观察，等待已授权数据源写入新事件。' : '已暂停观察，现有记录仍可筛选和导出。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '更新状态失败。'); }
  }

  async function deleteRoom(room: LiveRoom) {
    if (!window.confirm(`删除“${room.title}”及其独立采集存档？此操作不可恢复。`)) return;
    try {
      await observerApi.deleteRoom(room.id);
      const nextRooms = rooms.filter((item) => item.id !== room.id);
      setRooms(nextRooms);
      setSelectedRoomId((current) => current === room.id ? nextRooms[0]?.id ?? '' : current);
      setEvents((current) => current.filter((event) => event.roomId !== room.id));
      setAlerts((current) => current.filter((alert) => alert.roomId !== room.id));
      setNotice(`已删除“${room.title}”及其独立采集存档。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除直播间失败。'); }
  }

  function clearFilters() {
    setKind('all'); setQuery(''); setNotice('已清除筛选，正在显示该直播间的全部记录。');
  }

  async function submitRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const { room } = await observerApi.createRoom({ url: roomUrl.trim(), title: roomTitle.trim() || undefined });
      setRooms((current) => [room, ...current]);
      setSelectedRoomId(room.id);
      setIsFormOpen(false); setRoomUrl(''); setRoomTitle(''); setFormError('');
      setNotice(`已添加“${room.title}”。请在已授权页面启用浏览器采集器。`);
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : '添加直播间失败。'); }
  }

  function exportEvents() {
    if (!selectedRoom) return;
    const link = document.createElement('a');
    link.href = observerApi.exportUrl(selectedRoom.id, kind, query);
    link.download = '';
    link.click();
    setNotice('已请求导出当前筛选结果。');
  }

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`已复制${label}。`);
    } catch { setNotice(`请手动复制${label}。`); }
  }

  async function clearDemoData() {
    try {
      const removed = await observerApi.clearDemoData();
      setDataStatus({ demoRoomCount: 0, demoEventCount: 0 });
      const { rooms: nextRooms } = await observerApi.rooms();
      setRooms(nextRooms);
      setSelectedRoomId((current) => nextRooms.some((room) => room.id === current) ? current : nextRooms[0]?.id ?? '');
      setEvents([]); setAlerts([]);
      setNotice(`已清除 ${removed.demoRoomCount} 个演示房间和 ${removed.demoEventCount} 条演示事件。现在只接收真实授权来源。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '清除演示数据失败。'); }
  }

  async function startCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = captureUrl.trim();
    if (!url) { setCaptureError('请先粘贴完整的抖音直播间链接。'); return; }
    setIsStartingCapture(true); setCaptureError('');
    try {
      const { room } = await observerApi.createRoom({ url });
      setRooms((current) => [room, ...current]);
      setSelectedRoomId(room.id);
      setCaptureUrl('');
      try {
        const { snapshot } = await observerApi.captureRoomSnapshot(room.id, firecrawlApiKey.trim() || undefined);
        setNotice(`已新建独立采集存档并保存真实页面快照：“${snapshot.title}”。弹幕仍等待已登录页面采集器写入。`);
      } catch (snapshotReason) {
        const detail = snapshotReason instanceof Error ? snapshotReason.message : '快照抓取失败。';
        setNotice(`已新建“${room.title}”的独立采集存档：${room.saveFile}。网页快照未完成：${detail}`);
      }
      window.open(room.url, '_blank', 'noopener,noreferrer');
    } catch (reason) { setCaptureError(reason instanceof Error ? reason.message : '创建采集存档失败。'); }
    finally { setIsStartingCapture(false); }
  }

  async function addAlertRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const { rule } = await observerApi.createAlertRule(ruleKeyword);
      setAlertRules((current) => [rule, ...current]);
      setRuleKeyword(''); setRuleError(''); setNotice(`已启用“${rule.keyword}”告警规则。`);
    } catch (reason) { setRuleError(reason instanceof Error ? reason.message : '新增告警规则失败。'); }
  }

  async function setAlertRule(rule: AlertRule, enabled: boolean) {
    try {
      const { rule: updated } = await observerApi.updateAlertRule(rule.id, enabled);
      setAlertRules((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) { setRuleError(reason instanceof Error ? reason.message : '更新告警规则失败。'); }
  }

  async function deleteAlertRule(rule: AlertRule) {
    try {
      await observerApi.deleteAlertRule(rule.id);
      setAlertRules((current) => current.filter((item) => item.id !== rule.id));
      setNotice(`已删除“${rule.keyword}”告警规则。`);
    } catch (reason) { setRuleError(reason instanceof Error ? reason.message : '删除告警规则失败。'); }
  }

  async function acknowledgeAlert(alert: MonitorAlert) {
    try {
      const { alert: updated } = await observerApi.acknowledgeAlert(alert.id);
      setAlerts((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '确认告警失败。'); }
  }

  async function activateLicense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsActivatingLicense(true);
    setLicenseError('');
    try {
      const { token, status } = await observerApi.activateLicense(licenseCode.trim(), '当前浏览器');
      window.localStorage.setItem('tide-license-token', token);
      observerApi.setLicenseToken(token);
      setLicense(status);
      setNotice('卡密已激活，欢迎使用潮汐观察台。');
    } catch (reason) {
      setLicenseError(reason instanceof Error ? reason.message : '卡密激活失败，请稍后重试。');
    } finally {
      setIsActivatingLicense(false);
    }
  }

  function updateFirecrawlApiKey(value: string) {
    setFirecrawlApiKey(value);
    if (value.trim()) window.localStorage.setItem('tide-firecrawl-api-key', value.trim());
    else window.localStorage.removeItem('tide-firecrawl-api-key');
  }

  if (!isLicensed) {
    return (
      <main className="license-page">
        <section className="license-card license-card--overview" aria-labelledby="license-heading">
          <p className="section-kicker">TIDE OBSERVER · LIVE USER INSIGHT</p>
          <h1 id="license-heading">让直播间真实公开用户信息沉淀下来</h1>
          <p>面向自有或已获授权直播间的本地观察工具：把页面实际展示的发言用户、内容与公开资料，整理成可查看、可搜索、可导出的本地记录。</p>
          {!isActivationFormOpen ? <><section className="license-user-focus" aria-labelledby="user-focus-heading"><div><p className="section-kicker">CORE VALUE</p><h2 id="user-focus-heading">识别正在直播间里发言的人</h2><p>不只看一闪而过的弹幕。系统会将每条公开发言按用户归档，让你回看“谁说了什么、何时说的、公开页面实际展示了哪些资料”。</p></div><ul><li><strong>昵称与公开弹幕</strong><span>实时记录页面可见的发言内容和发生时间。</span></li><li><strong>真实公开头像</strong><span>资料卡确实展示时，保存本地头像文件。</span></li><li><strong>公开主页链接</strong><span>页面实际打开时回填，不根据昵称猜号。</span></li></ul></section><section className="license-overview" aria-label="产品能力介绍"><article><strong>用户发言列表</strong><span>按时间沉淀已获取真实头像的发言用户，便于快速回看。</span></article><article><strong>实时事件观察</strong><span>查看已授权页面中实际可见的公开弹幕、系统提示与进场事件。</span></article><article><strong>筛选、告警与导出</strong><span>按昵称和内容筛选，配置关键词提醒，并导出当前结果。</span></article><article><strong>独立本地存档</strong><span>每个直播间单独保存，避免不同链接的数据混在一起。</span></article></section><section className="license-journey" aria-labelledby="journey-heading"><div><p className="section-kicker">HOW IT WORKS</p><h2 id="journey-heading">从直播页到可用记录，只需三步</h2></div><ol><li><strong>登记授权直播间</strong><span>输入链接后建立独立的本地存档。</span></li><li><strong>连接已登录页面</strong><span>采集器读取页面实际可见的公开信息。</span></li><li><strong>查看与整理用户记录</strong><span>实时查看、搜索、告警或导出当前结果。</span></li></ol></section><section className="license-boundary" aria-label="数据边界说明"><article><strong>会记录什么</strong><span>公开昵称、可见弹幕、时间，以及资料卡实际展示的公开头像和主页链接。</span></article><article><strong>不会获取什么</strong><span>不读取 Cookie、私信、隐藏接口数据；未公开的抖音号不会猜测或伪造。</span></article></section><button className="button license-overview__activate" type="button" disabled={license === null} onClick={() => setIsActivationFormOpen(true)}>激活后开始使用</button>{license === null && <p className="muted-copy">正在检查本机授权…</p>}</> : <><button className="license-back" type="button" onClick={() => { setLicenseError(''); setIsActivationFormOpen(false); }}>← 返回功能介绍</button><h2>激活你的使用权限</h2><p>付款后获得卡密。输入有效卡密即可在当前浏览器激活并开始使用；卡密不会显示或保存到页面。</p>{license === null ? <p className="muted-copy">正在检查本机授权…</p> : <form onSubmit={activateLicense} className="license-form"><label>卡密<input autoFocus value={licenseCode} onChange={(event) => setLicenseCode(event.target.value.toUpperCase())} placeholder="ABC123-DEF456-GHI789-JKL012" autoComplete="off" required /></label>{licenseError && <p className="form-error" role="alert">{licenseError}</p>}<button className="button" type="submit" disabled={isActivatingLicense}>{isActivatingLicense ? '正在激活…' : '激活并进入观察台'}</button></form>}</>}
          <small>卡密授权仅控制本项目功能使用；每位使用者须自行提供 Firecrawl API Key。</small>
        </section>
      </main>
    );
  }

  return (
    <main className="observer-page">
      <header className="masthead">
        <div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span>≈</span></div><div><p className="eyebrow">LIVE EVENT DESK · LOCAL STACK</p><h1>潮汐观察台</h1></div></div>
        <div className="masthead-status"><span className={`status-dot ${selectedRoom?.status === 'paused' ? 'status-dot--paused' : ''}`} aria-hidden="true" /><span>{selectedRoom?.status === 'paused' ? '当前观察已暂停' : '本地实时服务已连接'}</span><span className="time-code">SSE</span></div>
      </header>

      <section className="safety-note" aria-label="数据来源说明"><strong>真实数据优先</strong><span>仅观察自有或已获授权的直播间。新安装不会生成样本事件；记录只来自已授权页面采集器或后续官方授权数据源。</span></section>

      {dataStatus && (dataStatus.demoRoomCount > 0 || dataStatus.demoEventCount > 0) && <section className="demo-cleanup" aria-label="演示数据清理"><div><strong>检测到旧版演示数据</strong><span>{dataStatus.demoRoomCount} 个演示房间、{dataStatus.demoEventCount} 条演示事件不会作为真实数据使用。</span></div><button type="button" onClick={clearDemoData}>仅清除演示数据</button></section>}

      <section className="capture-panel" aria-labelledby="capture-heading">
        <div className="capture-panel__intro"><div><p className="section-kicker">LIVE ROOM CAPTURE</p><h2 id="capture-heading">新建直播间采集</h2><p>每次输入一个新直播链接，观察台都会在本项目的 <code>data/saves/</code> 下创建一个新的 `.save.json`。采集器只保存页面实际显示的昵称和弹幕内容。</p></div><span className="capture-status">每个链接独立存档</span></div>
        <form className="capture-form" onSubmit={startCapture}><label><span className="sr-only">抖音直播间链接</span><input type="url" value={captureUrl} onChange={(event) => setCaptureUrl(event.target.value)} placeholder="https://live.douyin.com/123456" required /></label><button className="button" type="submit" disabled={isStartingCapture}>{isStartingCapture ? '正在创建…' : '创建存档并打开直播页'}</button></form>
        <label className="firecrawl-key"><span>你的 Firecrawl API Key（仅保存在当前浏览器）</span><input type="password" value={firecrawlApiKey} onChange={(event) => updateFirecrawlApiKey(event.target.value)} placeholder="fc-…" autoComplete="off" /><small>生产环境抓取必须使用此密钥；测试环境可继续使用服务方测试密钥。</small></label>
        {captureError && <p className="form-error" role="alert">{captureError}</p>}
        <ol className="capture-steps"><li>输入链接后生成独立存档。</li><li>已登录 Chrome 打开直播页。</li><li>采集器读到可见弹幕后，实时写入该存档。</li></ol>
        {selectedRoom && <p className="capture-file"><strong>当前直播间保存位置</strong><code>data/{selectedRoom.saveFile}</code><a href={observerApi.saveUrl(selectedRoom.id)}>下载此存档</a></p>}
      </section>

      <details className="setup-details">
        <summary>采集器连接与使用说明</summary>
        {connection && selectedRoom && <section className="connection-panel" aria-labelledby="connection-heading"><div><p className="section-kicker">BROWSER CONNECTOR</p><h2 id="connection-heading">浏览器采集器已就绪</h2><p>加载 <code>extension/</code> 并刷新已登记直播页后会自动连接；下方四项只在自动连接排错时才需要手动复制。</p>{collectorStatus ? <p className="connector-live">采集器已连接：{collectorStatus.mode === 'auto' ? '自动识别' : '手动选择器'}，当前页面识别到 {collectorStatus.matchCount} 个候选节点{collectorStatus.state === 'matched' ? '，已识别到可写入的昵称与弹幕。' : '，等待新弹幕。'}</p> : <p className="connector-live connector-live--idle">尚未检测到采集器。请在 Chrome 扩展页刷新“潮汐观察台采集器”，再重新打开此直播页。</p>}</div><div className="connection-fields"><button type="button" onClick={() => copyValue(connection.ingestUrl, '本地接收地址')}><span>接收地址</span><code>{connection.ingestUrl}</code></button><button type="button" onClick={() => copyValue(connection.ingestKey, '采集密钥')}><span>采集密钥</span><code>{connection.ingestKey}</code></button><button type="button" onClick={() => copyValue(selectedRoom.id, '直播间 ID')}><span>当前直播间 ID</span><code>{selectedRoom.id}</code></button><button type="button" onClick={() => copyValue(observerApi.getLicenseToken(), '扩展授权令牌')}><span>扩展授权令牌</span><code>{observerApi.getLicenseToken()}</code></button></div></section>}
        <section className="usage-guide" aria-labelledby="usage-heading">
          <div><p className="section-kicker">HOW TO USE</p><h2 id="usage-heading">使用说明与数据规则</h2><p>这套观察台只记录已授权直播页中实际可见的内容。每个直播间链接都有一份独立本地存档，不会混在一起。</p></div>
          <ol className="usage-guide__steps"><li><strong>登记直播间</strong><span>在顶部粘贴完整直播链接。系统会创建专属 <code>.save.json</code>，并将当前直播间设为“观察中”。</span></li><li><strong>安装并刷新采集器</strong><span>在 Chrome 加载项目 <code>extension/</code> 后，刷新一次已登记的直播页。采集器会自动按链接匹配当前房间。</span></li><li><strong>确认连接状态</strong><span>“采集器已连接”表示页面采集脚本已向本地服务报到；候选节点数为 0 时，自动识别没有找到弹幕结构，需要填写手动 CSS 选择器。</span></li><li><strong>查看与导出</strong><span>新弹幕会即时显示在事件时间线，同时写入本房间存档；可用筛选、关键词告警和 CSV 导出进行整理。</span></li></ol>
          <div className="usage-guide__facts"><article><strong>会保存什么</strong><p>实际可见的昵称、弹幕内容、时间，以及资料卡实际打开的公开主页链接。</p></article><article><strong>自动查找公开主页</strong><p>采集器会依次打开已显示昵称的资料卡头像，读取真实 <code>douyin.com/user/…</code> 链接并关闭临时标签；不依赖 Codex。</p></article><article><strong>不会伪造什么</strong><p>页面未公开的抖音号、私信、Cookie、隐藏接口数据都不会采集；昵称和头像不会被推断成账号。</p></article><article><strong>点赞如何处理</strong><p>当前版本不记录“谁点赞”。页面公开展示的总点赞数可供人工查看，但不能据此识别具体点赞者。</p></article></div>
        </section>
      </details>

      {error && <div className="service-error" role="alert"><strong>无法连接服务</strong><span>{error}</span><button type="button" onClick={() => window.location.reload()}>重新连接</button></div>}

      <section className="room-panel" aria-labelledby="room-heading">
        <div className="section-heading"><div><p className="section-kicker">OBSERVATION QUEUE</p><h2 id="room-heading">授权直播间</h2></div><button className="button button--quiet" type="button" onClick={() => setIsFormOpen(true)}><span aria-hidden="true">＋</span> 添加直播间</button></div>
        <div className="room-list" role="list">
          {isLoading ? <p className="loading-copy">正在读取本地房间…</p> : rooms.map((room) => <div className={`room-item ${room.id === selectedRoomId ? 'room-item--selected' : ''}`} key={room.id} role="listitem"><button className="room-item__select" type="button" onClick={() => setSelectedRoomId(room.id)} aria-pressed={room.id === selectedRoomId}><span className={`room-pulse room-pulse--${room.status}`} aria-hidden="true" /><span className="room-copy"><strong>{room.title}</strong><small>{room.url.replace('https://', '')}</small><small>data/{room.saveFile}</small></span><span className={`room-status room-status--${room.status}`}>{room.status === 'observing' ? '观察中' : '已暂停'}</span></button><button className="room-item__delete" type="button" onClick={() => deleteRoom(room)} aria-label={`删除 ${room.title}`}>删除</button></div>)}
        </div>
      </section>

      {selectedRoom && <>
        <section className="dashboard-grid" aria-label="当前直播间概览">
          <div className="current-room"><div className="section-heading section-heading--compact"><div><p className="section-kicker">NOW WATCHING</p><h2>{selectedRoom.title}</h2></div><button className={`button ${selectedRoom.status === 'observing' ? 'button--stop' : ''}`} type="button" onClick={toggleRoom}><span aria-hidden="true">{selectedRoom.status === 'observing' ? 'Ⅱ' : '▶'}</span>{selectedRoom.status === 'observing' ? '暂停观察' : '恢复观察'}</button></div><p className="room-meta">已登记于 {formatTime(selectedRoom.startedAt)} · 本地 JSON 持久化 · SSE 实时同步</p><div className="signal-line" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div></div>
          <div className="metric-strip"><div className="metric-card"><span>当前记录</span><strong>{summary.total}</strong><small>服务端已保存</small></div><div className="metric-card"><span>公开弹幕</span><strong>{summary.comments}</strong><small>可按内容筛选</small></div><div className="metric-card"><span>进场事件</span><strong>{summary.entries}</strong><small>来自授权来源</small></div><div className="metric-card"><span>公开标识</span><strong>{summary.accounts}</strong><small>非身份验证结果</small></div></div>
        </section>

        <section className="event-panel" aria-labelledby="event-heading">
            <div className="section-heading"><div><p className="section-kicker">EVENT STREAM</p><h2 id="event-heading">{filteredRoomTitle}</h2></div><div className="filters"><select className="button button--quiet" value={kind} onChange={(e) => setKind(e.target.value as EventKind | 'all')}><option value="all">全部事件</option><option value="comment">公开弹幕</option><option value="entry">进入直播间</option><option value="system">系统弹幕</option></select><input type="text" placeholder="搜索昵称、账号、内容…" value={query} onChange={(e) => setQuery(e.target.value)} className="button button--quiet" style={{ width: '180px' }}/><button className="button button--export" type="button" onClick={exportEvents}><span aria-hidden="true">↓</span>导出 CSV</button></div></div>
            <p className="event-count"><strong>{filteredEvents.length}</strong> 条记录（共 {events.length} 条）</p>
            <div className="event-list" role="list" aria-live="polite">
              <div className="event-list__head" aria-hidden="true"><span>头像</span><span>发言人</span><span>弹幕</span><span>时间</span><span>操作</span></div>
          {filteredEvents.length === 0 ? (
            <div className="speaker-list__empty"><strong>没有匹配的事件</strong><span>尝试切换筛选条件或清除搜索。</span></div>
          ) : (
            filteredEvents.map((event) => {
              const avatar = localAvatarUrl(event);
              return (
                  <article className={`event-row event-row--${event.kind}`} key={event.id} role="listitem">
                    {avatar ? <img className="event-avatar" src={avatar} alt={`${event.nickname} 的公开头像`} /> : <span className="event-avatar event-avatar--empty" aria-label="未保存头像">—</span>}
                    <div className="event-person"><span><strong>{event.nickname}</strong>{event.publicAccountId !== '—' && <small>抖音号 {event.publicAccountId}</small>}</span></div>
                    <div className="event-message"><b className={`event-type event-type--${event.kind}`}>{eventLabels[event.kind]}</b><p>{event.message}</p></div>
                    <time className="event-time">{formatTime(event.timestamp)}</time>
                    {event.kind === 'comment' ? <a className="event-search" href={douyinUserSearchUrl(event.nickname)} target="_blank" rel="noreferrer">抖音搜索 <span aria-hidden="true">↗</span></a> : <span />}
                  </article>
                );
              })
            )}
            </div>
        </section>

        <details className="speaker-details">
          <summary><span>发言用户列表</span><small>当前直播间 · 已存头像 {speakerEvents.length} 条</small></summary>
          <section className="speaker-panel" aria-labelledby="speaker-heading">
            <div className="section-heading speaker-panel__heading"><div><p className="section-kicker">CURRENT ROOM SPEAKERS</p><h2 id="speaker-heading">发言用户列表</h2></div><span className="speaker-panel__count">按时间从早到晚</span></div>
            <p className="speaker-panel__description">只展示已经从资料卡取到并保存到本地的真实头像；当前直播间以外的数据不会混进来。</p>
            <div className="speaker-list" role="list" aria-live="polite">
              <div className="speaker-list__head" aria-hidden="true"><span>头像</span><span>昵称</span><span>发言</span><span>操作</span></div>
              <div className="speaker-rows-scroll" role="listbox">
                {speakerEvents.length === 0 ? (
                  <div className="speaker-list__empty">
                    <strong>正在获取真实头像</strong>
                    <span>新弹幕的头像保存完成后，会按时间顺序显示在这里。</span>
                  </div>
                ) : (
                  speakerEvents.map((event) => {
                    const avatar = localAvatarUrl(event);
                    return (
                      <article className="speaker-row" key={event.id} role="option">
                        {avatar && <img className="speaker-avatar" src={avatar} alt={`${event.nickname} 的公开头像`} />}
                        <strong className="speaker-row__nickname">{event.nickname}</strong>
                        <p><time>{formatTime(event.timestamp)}</time>{event.message}</p>
                        <a className="speaker-search" href={douyinUserSearchUrl(event.nickname)} target="_blank" rel="noreferrer">抖音搜索 <span aria-hidden="true">↗</span></a>
                      </article>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        </details>

        <section className="alert-panel" aria-labelledby="alert-heading"><div className="section-heading"><div><p className="section-kicker">ALERT DESK</p><h2 id="alert-heading">关键词告警</h2></div><span className="alert-summary">未确认 {alerts.filter((alert) => alert.status === 'new').length}</span></div><div className="alert-grid"><div className="rule-column"><form className="rule-form" onSubmit={addAlertRule}><label>添加关键词<input value={ruleKeyword} onChange={(event) => setRuleKeyword(event.target.value)} placeholder="例如：价格、链接、售后" maxLength={60} /></label><button className="button" type="submit">启用告警</button></form>{ruleError && <p className="form-error" role="alert">{ruleError}</p>}<div className="rule-list">{alertRules.length === 0 ? <p className="muted-copy">还没有规则。匹配到关键词的公开弹幕会出现在右侧。</p> : alertRules.map((rule) => <div className="rule-row" key={rule.id}><span><strong>{rule.keyword}</strong><small>{rule.enabled ? '已启用' : '已停用'}</small></span><button type="button" onClick={() => setAlertRule(rule, !rule.enabled)}>{rule.enabled ? '停用' : '启用'}</button><button type="button" className="rule-row__delete" onClick={() => deleteAlertRule(rule)}>删除</button></div>)}</div></div><div className="alert-list">{alerts.length === 0 ? <p className="muted-copy">当前房间没有匹配的告警。</p> : alerts.slice(0, 8).map((alert) => <article className={`alert-row alert-row--${alert.status}`} key={alert.id}><span className="alert-row__time">{formatTime(alert.timestamp)}</span><div><strong>“{alert.keyword}” · {alert.nickname}</strong><p>{alert.message}</p></div>{alert.status === 'new' ? <button type="button" onClick={() => acknowledgeAlert(alert)}>确认</button> : <span className="alert-row__done">已确认</span>}</article>)}</div></div></section>
      </>}

      <p className="notice" role="status">{notice}</p>

      {isFormOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setIsFormOpen(false)}><section className="room-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}><p className="section-kicker">ADD AUTHORIZED ROOM</p><h2 id="modal-title">添加授权直播间</h2><p>当前只保存到本地；请只填写你拥有或已获授权的直播间。登记后，需在已授权页面启用浏览器采集器。</p><form onSubmit={submitRoom}><label>直播间链接<input autoFocus value={roomUrl} onChange={(event) => setRoomUrl(event.target.value)} placeholder="https://live.douyin.com/123456" /></label><label>显示名称 <small>（可选）</small><input value={roomTitle} onChange={(event) => setRoomTitle(event.target.value)} placeholder="例如：夏日新品直播间" /></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="modal-actions"><button className="button button--quiet" type="button" onClick={() => setIsFormOpen(false)}>取消</button><button className="button" type="submit">开始观察</button></div></form></section></div>}
    </main>
  );
}

export default App;

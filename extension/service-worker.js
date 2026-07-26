function statusEndpoint(ingestEndpoint) {
  const url = new URL(ingestEndpoint);
  url.pathname = url.pathname.replace(/\/api\/ingest$/, '/api/collector-status');
  return url.toString();
}

function configEndpoint(ingestEndpoint, pageUrl) {
  const url = new URL(ingestEndpoint);
  url.pathname = url.pathname.replace(/\/api\/ingest$/, '/api/collector-config');
  url.searchParams.set('url', pageUrl);
  return url.toString();
}

function profileAccountEndpoint(ingestEndpoint) {
  const url = new URL(ingestEndpoint);
  url.pathname = url.pathname.replace(/\/api\/ingest$/, '/api/profile-account');
  return url.toString();
}

function profileAvatarEndpoint(ingestEndpoint) {
  const url = new URL(ingestEndpoint);
  url.pathname = url.pathname.replace(/\/api\/ingest$/, '/api/profile-avatar');
  return url.toString();
}

function profileLinkEndpoint(ingestEndpoint) {
  const url = new URL(ingestEndpoint);
  url.pathname = url.pathname.replace(/\/api\/ingest$/, '/api/profile-link');
  return url.toString();
}

const resolvedSettingsKey = 'tideResolvedSettings';
const pendingProfileLookups = new Map();

const enableSessionAccess = chrome.storage.session?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
const sessionAccessReady = enableSessionAccess?.catch(() => undefined);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['ingest', 'collector-status', 'profile-account', 'profile-avatar', 'profile-link', 'profile-lookup-start', 'resolve-settings'].includes(message?.type)) return undefined;
  if (message.type === 'profile-lookup-start') {
    const sourceTabId = sender.tab?.id;
    if (sourceTabId === undefined || !message.settings?.roomId || !message.payload?.nickname || !message.payload?.message) {
      sendResponse({ ok: false, error: '未能关联当前直播页。' });
      return undefined;
    }
    pendingProfileLookups.set(sourceTabId, { ...message.payload, settings: message.settings, expiresAt: Date.now() + 12_000 });
    sendResponse({ ok: true });
    return undefined;
  }
  chrome.storage.local.get(['settings'], async ({ settings: savedSettings }) => {
    if (message.type === 'resolve-settings') {
      try {
        const endpoint = new URL(configEndpoint(savedSettings?.endpoint || 'http://127.0.0.1:8787/api/ingest', message.payload?.url || ''));
        if (savedSettings?.licenseToken) endpoint.searchParams.set('license', savedSettings.licenseToken);
        const response = await fetch(endpoint, { method: 'GET' });
        const body = await response.json().catch(() => ({}));
        if (response.ok && body.settings) {
          await sessionAccessReady;
          await chrome.storage.session?.set({ [resolvedSettingsKey]: { pageUrl: message.payload?.url || '', settings: body.settings } });
        }
        sendResponse({ ok: response.ok, status: response.status, ...body });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : '本地服务不可用。' });
      }
      return;
    }
    const settings = message.settings?.endpoint && message.settings?.key && message.settings?.roomId
      ? message.settings
      : savedSettings;
    if (!settings?.endpoint || !settings?.key || !settings?.roomId) {
      sendResponse({ ok: false, error: '请先在采集器设置中填写服务地址、采集密钥和直播间 ID。' });
      return;
    }
    try {
      const endpoint = message.type === 'ingest'
        ? settings.endpoint
        : message.type === 'profile-account'
          ? profileAccountEndpoint(settings.endpoint)
        : message.type === 'profile-avatar'
          ? profileAvatarEndpoint(settings.endpoint)
          : message.type === 'profile-link'
            ? profileLinkEndpoint(settings.endpoint)
            : statusEndpoint(settings.endpoint);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(settings.licenseToken ? { 'X-License-Token': settings.licenseToken } : {}) },
        body: JSON.stringify({ ...message.payload, key: settings.key, roomId: settings.roomId }),
      });
      const body = await response.json().catch(() => ({}));
      sendResponse({ ok: response.ok, status: response.status, ...body });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '本地服务不可用。' });
    }
  });
  return true;
});

function isPublicProfileUrl(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === 'www.douyin.com' || parsed.hostname === 'douyin.com') && parsed.pathname.startsWith('/user/');
  } catch { return false; }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId === undefined) return;
  const pending = pendingProfileLookups.get(tab.openerTabId);
  if (!pending || pending.expiresAt < Date.now()) return;
  pendingProfileLookups.delete(tab.openerTabId);
  pendingProfileLookups.set(tab.id, { ...pending, temporaryProfileTab: true });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const pending = pendingProfileLookups.get(tabId);
  if (!pending) return;
  if (pending.expiresAt < Date.now()) { pendingProfileLookups.delete(tabId); return; }
  const publicProfileUrl = changeInfo.url || tab.url;
  if (!isPublicProfileUrl(publicProfileUrl)) return;
  pendingProfileLookups.delete(tabId);
  try {
    await fetch(profileLinkEndpoint(pending.settings.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(pending.settings.licenseToken ? { 'X-License-Token': pending.settings.licenseToken } : {}) },
      body: JSON.stringify({ key: pending.settings.key, roomId: pending.settings.roomId, nickname: pending.nickname, message: pending.message, publicProfileUrl, ...(pending.avatarUrl ? { avatarUrl: pending.avatarUrl } : {}) }),
    });
  } finally {
    // 资料页只用来读取公开链接；写入后关闭临时标签，不打断直播页。
    if (pending.temporaryProfileTab) chrome.tabs.remove(tabId).catch(() => undefined);
  }
});

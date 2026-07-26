const seen = new Map();
let observer;
let structuralObserver;
let pendingProfileTarget;
let profileLookupBusy = false;
const profileLookupQueue = [];
const profileLookupSeen = new Map();
const resolvedSettingsKey = 'tideResolvedSettings';

const autoEventSelector = '[data-e2e*="comment"], [data-e2e*="chat"], [class*="chatroom"] [class*="item"], [class*="comment"] [class*="item"], [class*="message"]';
const nicknameSelector = '[data-e2e*="username"], [data-e2e*="nickname"], [class*="username"], [class*="user-name"], [class*="nickname"], [class*="author"]';
const messageSelector = '[data-e2e*="content"], [data-e2e*="message"], [class*="comment-content"], [class*="message-content"], [class*="content"], [class*="message"]';
const nicknameLinePattern = /^(.{1,80}?)\s*[：:]$/u;
const nonCommentMessagePattern = /^(送出了|成为在线观众|加入了直播间|欢迎来到直播间)/u;
const publicAccountIdPattern = /(?:抖音号|douyin\s*id)\s*[：:]\s*([a-z0-9._-]{3,120})/iu;
const profileLookupDelay = 1800;

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function readElement(root, selector) {
  if (!selector) return '';
  const node = root.matches?.(selector) ? root : root.querySelector(selector);
  return clean(node?.textContent);
}

function sendCapture({ nickname, message, publicAccountId = '—', avatarUrl, eventKind = 'comment' }, settings) {
  if (!nickname || !message || nickname === message) return;
  const fingerprint = `${nickname}|${publicAccountId}|${message}`;
  const now = Date.now();
  if ((seen.get(fingerprint) ?? 0) > now - 15_000) return;
  seen.set(fingerprint, now);
  // 自动配置只保存在本次 Chrome 会话。把当前已解析的连接信息随内部消息带给
  // Service Worker，避免它只能读取“手动保存”的本地表单设置。
  chrome.runtime.sendMessage({
    type: 'ingest',
    payload: { kind: eventKind, nickname, publicAccountId, ...(avatarUrl ? { avatarUrl } : {}), message, observedAt: new Date().toISOString() },
    settings,
  });
}

function reportStatus(settings, state, matchCount = 0) {
  chrome.runtime.sendMessage({
    type: 'collector-status',
    payload: { state, mode: settings.eventSelector && settings.nicknameSelector && settings.messageSelector ? 'manual' : 'auto', matchCount },
    settings,
  });
}

function reportPublicAccount({ nickname, message, publicAccountId }, settings) {
  chrome.runtime.sendMessage({
    type: 'profile-account',
    payload: { nickname, message, publicAccountId, observedAt: new Date().toISOString() },
    settings,
  });
}

function captureManual(root, settings) {
  const nicknameNode = root.matches?.(settings.nicknameSelector) ? root : root.querySelector(settings.nicknameSelector);
  const nickname = clean(nicknameNode?.textContent);
  const message = readElement(root, settings.messageSelector);
  sendCapture({
    nickname,
    message,
    publicAccountId: readElement(root, settings.accountSelector) || '—',
    eventKind: settings.eventKind || 'comment',
  }, settings);
  if (nicknameNode) enqueueProfileLookup({ nickname, message, nicknameNode }, settings);
}

function captureAuto(node, settings) {
  const root = node.closest?.('[data-e2e*="comment"], [data-e2e*="chat"], [class*="chatroom"] [class*="item"], [class*="comment"] [class*="item"]') || node.parentElement || node;
  const nickname = readElement(root, nicknameSelector);
  const message = readElement(root, messageSelector);
  if (!nickname || !message || nickname.length > 80 || message.length > 1000) return;
  reportStatus(settings, 'matched', 1);
  // 弹幕行里的图片包含等级、勋章和粉丝牌，绝不从这里猜用户头像。
  sendCapture({ nickname, message, eventKind: settings.eventKind || 'comment' }, settings);
  const nicknameNode = root.matches?.(nicknameSelector) ? root : root.querySelector(nicknameSelector);
  if (nicknameNode) enqueueProfileLookup({ nickname, message, nicknameNode }, settings);
}

// 抖音直播页经常更换 CSS 类名，但可见弹幕仍然呈现为“昵称：”紧随“内容”。
// 这个兜底只读取当前页面实际显示的相邻节点，不请求页面接口，也不猜测账号标识。
function readStructuralComment(nicknameNode) {
  const nicknameMatch = clean(nicknameNode.textContent).match(nicknameLinePattern);
  if (!nicknameMatch) return undefined;

  let branch = nicknameNode;
  for (let depth = 0; depth < 3; depth += 1) {
    const next = branch.nextElementSibling;
    const message = clean(next?.textContent);
    if (message && message.length <= 1000 && !nonCommentMessagePattern.test(message)) {
      return { nickname: clean(nicknameMatch[1]), message };
    }
    branch = branch.parentElement;
    if (!branch) break;
  }
  return undefined;
}

function captureStructuralCandidate(nicknameNode, settings) {
  const comment = readStructuralComment(nicknameNode);
  if (!comment) return false;
  reportStatus(settings, 'matched', 1);
  sendCapture({ ...comment, eventKind: settings.eventKind || 'comment' }, settings);
  enqueueProfileLookup({ ...comment, nicknameNode }, settings);
  return true;
}

function visible(element) {
  const rect = element.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0);
}

function findProfileCard(nickname) {
  const candidates = [...document.querySelectorAll('aside, section, div')]
    .filter((element) => visible(element) && clean(element.textContent).includes(nickname))
    .map((element) => ({ element, rect: element.getBoundingClientRect(), style: getComputedStyle(element) }))
    .filter(({ rect, style }) => rect.width >= 180 && rect.width <= 1_000 && rect.height >= 110 && rect.height <= 1_000
      && (style.position === 'fixed' || style.position === 'absolute' || style.zIndex !== 'auto'))
    .sort((left, right) => (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height));
  return candidates[0]?.element;
}

function imageUrl(image) {
  return image?.currentSrc || image?.src || '';
}

function isProfileBadge(image) {
  return /(?:grade[_-]?level|user[_-]?grade|medal|badge|fans?[_-]?club|fanclub|wealth[_-]?level|membership|member[_-]?icon|vip)/iu.test(`${imageUrl(image)} ${image.className} ${image.alt}`);
}

// 资料卡左上角的大圆图才是头像；等级、会员和粉丝团图标均在其它区域或尺寸很小。
function profileAvatarImage(card) {
  const cardRect = card.getBoundingClientRect();
  const maxLeft = cardRect.left + Math.min(200, cardRect.width * 0.3);
  const maxTop = cardRect.top + Math.min(180, cardRect.height * 0.34);
  return [...card.querySelectorAll('img')]
    .filter((image) => {
      const rect = image.getBoundingClientRect();
      const ratio = rect.width / Math.max(rect.height, 1);
      return visible(image) && imageUrl(image).startsWith('https://') && !isProfileBadge(image)
        && rect.width >= 56 && rect.height >= 56 && rect.width <= 240 && rect.height <= 240
        && ratio >= 0.75 && ratio <= 1.33
        && rect.left >= cardRect.left - 8 && rect.left <= maxLeft
        && rect.top >= cardRect.top - 8 && rect.top <= maxTop;
    })
    .sort((left, right) => (right.getBoundingClientRect().width * right.getBoundingClientRect().height) - (left.getBoundingClientRect().width * left.getBoundingClientRect().height))[0];
}

function profileAvatarTarget(avatar) {
  if (!avatar) return undefined;
  // 返回可点击的包裹元素
  let target = avatar;
  for (let depth = 0; target.parentElement && depth < 3; depth += 1) {
    if (target.matches('a, button, [role="button"]') || getComputedStyle(target).cursor === 'pointer') return target;
    target = target.parentElement;
  }
  return avatar;
}

function profileNicknameTarget(nicknameNode) {
  let target = nicknameNode;
  for (let depth = 0; target?.parentElement && depth < 5; depth += 1) {
    if (target.matches('a, button, [role="button"]') || getComputedStyle(target).cursor === 'pointer') return target;
    target = target.parentElement;
  }
  return nicknameNode;
}

async function openProfileCard(nicknameNode, nickname) {
  const target = profileNicknameTarget(nicknameNode);
  for (const type of ['pointerdown', 'mousedown', 'mouseup']) {
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  await sleep(60);
  if (!readOpenProfileAvatar(nickname)) target.click();
}

function readOpenProfileAvatar(nickname) {
  const card = findProfileCard(nickname);
  const image = card && profileAvatarImage(card);
  const target = profileAvatarTarget(image);
  const avatarUrl = imageUrl(image);
  if (!target || !avatarUrl.startsWith('https://')) return undefined;
  return { target, avatarUrl };
}

function reportProfileAvatar({ nickname, message }, settings) {
  const profile = readOpenProfileAvatar(nickname);
  if (!profile) return undefined;
  chrome.runtime.sendMessage({ type: 'profile-avatar', payload: { nickname, message, avatarUrl: profile.avatarUrl }, settings });
  return profile;
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForOpenProfileAvatar(nickname, timeout = 2_200) {
  const deadline = Date.now() + timeout;
  do {
    const profile = readOpenProfileAvatar(nickname);
    if (profile) return profile;
    await sleep(80);
  } while (Date.now() < deadline);
  return undefined;
}

function enqueueProfileLookup({ nickname, message, nicknameNode }, settings) {
  if (settings.profileLookup !== 'on' || !nicknameNode?.isConnected) return;
  const fingerprint = `${nickname}|${message}`;
  const now = Date.now();
  if ((profileLookupSeen.get(fingerprint) ?? 0) > now - 5 * 60_000 || profileLookupQueue.length >= 25) return;
  profileLookupSeen.set(fingerprint, now);
  profileLookupQueue.push({ fingerprint, nickname, message, nicknameNode, settings });
  void processProfileLookupQueue();
}

async function processProfileLookupQueue() {
  if (profileLookupBusy) return;
  const item = profileLookupQueue.shift();
  if (!item) return;
  profileLookupBusy = true;
  try {
    if (!item.nicknameNode.isConnected) return;
    // 只操作页面已显示的昵称和资料卡头像；不调用隐藏接口，也不发消息、关注或点赞。
    await openProfileCard(item.nicknameNode, item.nickname);
    const profile = await waitForOpenProfileAvatar(item.nickname);
    if (!profile) return;
    chrome.runtime.sendMessage({ type: 'profile-avatar', payload: { nickname: item.nickname, message: item.message, avatarUrl: profile.avatarUrl }, settings: item.settings });
    chrome.runtime.sendMessage({ type: 'profile-lookup-start', payload: { nickname: item.nickname, message: item.message, avatarUrl: profile.avatarUrl }, settings: item.settings });
    profile.target.click();
    await sleep(profileLookupDelay);
  } finally {
    profileLookupBusy = false;
    void processProfileLookupQueue();
  }
}

function scanStructuralComments(root, settings) {
  const elements = root instanceof Element
    ? [root, ...root.querySelectorAll('*')]
    : [...document.querySelectorAll('*')];
  return elements.reduce((count, element) => count + Number(captureStructuralCandidate(element, settings)), 0);
}

function observeStructuralComments(settings) {
  structuralObserver?.disconnect();
  structuralObserver = new MutationObserver((changes) => {
    changes.forEach((change) => change.addedNodes.forEach((node) => {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) return;
      scanStructuralComments(element, settings);
      captureVisiblePublicAccount(element, settings);
    }));
  });
  structuralObserver.observe(document.documentElement, { childList: true, subtree: true });
  return scanStructuralComments(document, settings);
}

function clickedComment(target) {
  let element = target;
  for (let depth = 0; element && depth < 5; depth += 1) {
    const comment = readStructuralComment(element);
    if (comment) return comment;
    // 抖音有时只给消息文字打上通用 class，昵称所在的外层行本身并不匹配
    // autoEventSelector。点击时因此逐层读取当前行，而不是依赖这一条选择器命中。
    const eventRoot = element.closest?.(autoEventSelector) || element;
    if (eventRoot) {
      const nickname = readElement(eventRoot, nicknameSelector);
      const message = readElement(eventRoot, messageSelector);
      if (nickname && message && nickname.length <= 80 && message.length <= 1000) return { nickname, message };
    }
    element = element.parentElement;
  }
  return undefined;
}

function rememberClickedComment(target, settings) {
  const comment = clickedComment(target);
  if (!comment) return;
  pendingProfileTarget = { ...comment, expiresAt: Date.now() + 30_000 };
  // 用户已主动点开资料卡时，不必再次点击昵称；直接读取资料卡左上角实际展示的头像。
  window.setTimeout(() => { reportProfileAvatar(comment, settings); }, 280);
}

function captureVisiblePublicAccount(root, settings) {
  if (!pendingProfileTarget || pendingProfileTarget.expiresAt < Date.now()) {
    pendingProfileTarget = undefined;
    return;
  }
  const match = clean(root.textContent).match(publicAccountIdPattern);
  if (!match) return;
  reportPublicAccount({ ...pendingProfileTarget, publicAccountId: match[1] }, settings);
  pendingProfileTarget = undefined;
}

function observeMatches(selector, callback) {
  document.querySelectorAll(selector).forEach(callback);
  observer = new MutationObserver((changes) => {
    changes.forEach((change) => change.addedNodes.forEach((node) => {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) return;
      if (element.matches(selector)) callback(element);
      element.querySelectorAll?.(selector).forEach(callback);
      const parentMatch = element.closest?.(selector);
      if (parentMatch) callback(parentMatch);
    }));
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function install(settings = {}) {
  observer?.disconnect();
  structuralObserver?.disconnect();
  const hasManualSelectors = settings.eventSelector && settings.nicknameSelector && settings.messageSelector;
  if (hasManualSelectors) {
    reportStatus(settings, 'active', document.querySelectorAll(settings.eventSelector).length);
    observeMatches(settings.eventSelector, (node) => captureManual(node, settings));
    return;
  }
  if (settings.autoDetect === 'off') return;
  const selectorCount = document.querySelectorAll(autoEventSelector).length;
  observeMatches(autoEventSelector, (node) => captureAuto(node, settings));
  const structuralCount = observeStructuralComments(settings);
  reportStatus(settings, 'active', selectorCount + structuralCount);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;
    rememberClickedComment(target, settings);
    window.setTimeout(() => captureVisiblePublicAccount(document.body, settings), 0);
  });
}

function resolveAndInstall(savedSettings = {}) {
  chrome.runtime.sendMessage({ type: 'resolve-settings', payload: { url: window.location.href } }, (response) => {
    if (response?.ok && response.settings) {
      install({ ...savedSettings, ...response.settings });
      return;
    }
    if (savedSettings.manualOverride === 'on' && savedSettings.endpoint && savedSettings.key && savedSettings.roomId) install(savedSettings);
  });
  chrome.storage.session?.get?.([resolvedSettingsKey], (values) => {
    const resolved = values?.[resolvedSettingsKey];
    if (resolved?.pageUrl === window.location.href && resolved.settings) install({ ...savedSettings, ...resolved.settings });
  });
}

chrome.storage.local.get(['settings'], ({ settings = {} }) => resolveAndInstall(settings));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) resolveAndInstall(changes.settings.newValue);
  if (area === 'session' && changes[resolvedSettingsKey]?.newValue?.pageUrl === window.location.href) {
    install(changes[resolvedSettingsKey].newValue.settings);
  }
});

const form = document.querySelector('#settings-form');
const status = document.querySelector('#status');

chrome.storage.local.get(['settings'], ({ settings = {} }) => {
  Object.entries(settings).forEach(([name, value]) => { if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value; });
  if (settings.autoDetect === 'off') form.elements.namedItem('autoDetect').checked = false;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const settings = Object.fromEntries(new FormData(form).entries());
  settings.autoDetect = form.elements.namedItem('autoDetect').checked ? 'on' : 'off';
  settings.manualOverride = 'on';
  chrome.storage.local.set({ settings }, () => { status.textContent = '已保存。重新打开已登记直播页后会自动获取房间和采集配置。'; });
});

// 点击扩展图标 → 打开（或切到）控制台
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url, pinned: true });
  }
});

// 点桌面通知 → 打开帖子（通知 id = 帖子链接#时间戳）
chrome.notifications.onClicked.addListener((id) => {
  const url = id.replace(/#\d+$/, '');
  if (/^https:\/\/www\.xiaohongshu\.com\//.test(url)) chrome.tabs.create({ url });
  chrome.notifications.clear(id);
});

// 控制台标签页被关掉 → 把它开的小红书后台标签页也全部关掉
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { dashTab, workerTabs = [] } = await chrome.storage.local.get(['dashTab', 'workerTabs']);
  if (tabId !== dashTab) return;
  await Promise.all(workerTabs.map((id) => chrome.tabs.remove(id).catch(() => {})));
  await chrome.storage.local.set({ workerTabs: [], dashTab: null });
});

// 点击工具栏图标：如果已有面板在监视当前标签页（包括自动跟随加入的），就切换过去；
// 否则为当前标签页打开一个新的面板窗口。
// 抓包本身在面板页面里完成，后台只负责开窗口，避免 MV3 service worker 休眠导致数据丢失。

const VIEWER = chrome.runtime.getURL('viewer.html');

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;

  // 在面板窗口里再点图标时，不要去监视面板自己
  if (tab.url && tab.url.startsWith(VIEWER)) return;

  const existing = await chrome.runtime.sendMessage({ type: 'nm:whoMonitors', tabId: tab.id }).catch(() => null);
  if (existing && existing.ok) return;

  // 用独立的弹出窗口，不改变目标页面的窗口尺寸（部分网站靠尺寸变化检测开发者工具）
  await chrome.windows.create({
    url: `${VIEWER}?tabId=${tab.id}`,
    type: 'popup',
    width: 1280,
    height: 800,
    focused: true,
  });
});

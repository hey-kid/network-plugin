// 通过 chrome.debugger（Chrome DevTools Protocol）抓取指定标签页的网络流量。
//
// 只启用 Network 域（以及子目标自动附加所需的 Target 域），刻意不启用
// Debugger / Runtime / Console：页面里的 `debugger;` 陷阱不会暂停，
// 基于控制台 getter 的开发者工具检测也不会被触发。

const PROTOCOL_VERSION = '1.3';

const NETWORK_ENABLE_PARAMS = {
  maxTotalBufferSize: 200 * 1024 * 1024,
  maxResourceBufferSize: 50 * 1024 * 1024,
  maxPostDataSize: 1024 * 1024,
};

// 需要附加并抓包的子目标类型（跨进程 iframe、Worker 等）
const CHILD_TYPES_WITH_NETWORK = new Set(['iframe', 'worker', 'shared_worker', 'service_worker']);

function lastErrorMessage() {
  const err = chrome.runtime.lastError;
  return err ? err.message || String(err) : null;
}

function cdp(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const msg = lastErrorMessage();
      if (msg) reject(new Error(msg));
      else resolve(result);
    });
  });
}

export class TabCapture {
  /**
   * @param {number} tabId
   * @param {{ onEvent: (method: string, params: any, sessionId?: string) => void,
   *           onDetach: (reason: string) => void }} handlers
   */
  constructor(tabId, handlers) {
    this.tabId = tabId;
    this.handlers = handlers;
    this.attached = false;
    this.mainFrameId = null;
    this.sessions = new Set(); // 子目标 sessionId
    this.cacheDisabled = false;
    this._onEvent = this._onEvent.bind(this);
    this._onDetach = this._onDetach.bind(this);
  }

  target(sessionId) {
    return sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
  }

  send(method, params, sessionId) {
    return cdp(this.target(sessionId), method, params);
  }

  async attach() {
    chrome.debugger.onEvent.addListener(this._onEvent);
    chrome.debugger.onDetach.addListener(this._onDetach);

    try {
      await new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId: this.tabId }, PROTOCOL_VERSION, () => {
          const msg = lastErrorMessage();
          if (msg) reject(new Error(msg));
          else resolve();
        });
      });
    } catch (e) {
      this._removeListeners();
      throw e;
    }
    this.attached = true;

    // 尽快启用 Network，新打开的窗口越早启用漏掉的请求越少
    await this.send('Network.enable', NETWORK_ENABLE_PARAMS);
    this.enabledAt = Date.now();
    if (this.cacheDisabled) await this.send('Network.setCacheDisabled', { cacheDisabled: true });

    // 页面目标的 targetId 就是主框架的 frameId，用来识别主框架导航
    try {
      const targets = await chrome.debugger.getTargets();
      const t = targets.find((x) => x.tabId === this.tabId && x.type === 'page');
      if (t) this.mainFrameId = t.id;
    } catch (_) { /* 忽略 */ }

    // 自动附加跨进程 iframe / worker，让它们的请求也能被看到
    try {
      await this.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      this.autoAttach = true;
    } catch (e) {
      this.autoAttach = false;
      console.warn('子目标自动附加不可用：', e.message);
    }
  }

  async detach() {
    if (!this.attached) {
      this._removeListeners();
      return;
    }
    this.attached = false;
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId: this.tabId }, () => {
        lastErrorMessage();
        resolve();
      });
    });
    this._removeListeners();
  }

  async setCacheDisabled(disabled) {
    this.cacheDisabled = disabled;
    if (!this.attached) return;
    const all = [undefined, ...this.sessions];
    await Promise.all(all.map((s) =>
      this.send('Network.setCacheDisabled', { cacheDisabled: disabled }, s).catch(() => {})));
  }

  getResponseBody(requestId, sessionId) {
    return this.send('Network.getResponseBody', { requestId }, sessionId);
  }

  getRequestPostData(requestId, sessionId) {
    return this.send('Network.getRequestPostData', { requestId }, sessionId);
  }

  _removeListeners() {
    chrome.debugger.onEvent.removeListener(this._onEvent);
    chrome.debugger.onDetach.removeListener(this._onDetach);
  }

  async _onChildAttached(params, parentSessionId) {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    try {
      if (CHILD_TYPES_WITH_NETWORK.has(targetInfo.type)) {
        this.sessions.add(sessionId);
        await this.send('Network.enable', NETWORK_ENABLE_PARAMS, sessionId).catch(() => {});
        if (this.cacheDisabled) {
          await this.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId).catch(() => {});
        }
        // 嵌套的 iframe / worker
        await this.send('Target.setAutoAttach', {
          autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        }, sessionId).catch(() => {});
      }
    } finally {
      // 无论如何都要放行，否则子页面会一直挂起
      if (waitingForDebugger) {
        await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      }
    }
  }

  _onEvent(source, method, params) {
    if (source.tabId !== this.tabId) return;
    const sessionId = source.sessionId;

    if (method === 'Target.attachedToTarget') {
      this._onChildAttached(params, sessionId);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      this.sessions.delete(params.sessionId);
      return;
    }
    this.handlers.onEvent(method, params, sessionId);
  }

  _onDetach(source, reason) {
    if (source.tabId !== this.tabId) return;
    this.attached = false;
    this.sessions.clear();
    this._removeListeners();
    this.handlers.onDetach(reason);
  }
}

export function explainAttachError(message) {
  const m = message || '';
  if (/Another debugger is already attached/i.test(m)) {
    return '该标签页已被其他调试器（例如另一个插件）占用。请关闭占用它的插件或工具后重试。';
  }
  if (/Cannot access|Cannot attach to this target|chrome:\/\/|edge:\/\/|extensions gallery/i.test(m)) {
    return '浏览器不允许插件调试此页面（例如 edge:// 内部页面、扩展商店或其他插件的页面）。请在普通网页上使用。';
  }
  if (/No tab with given id/i.test(m)) {
    return '目标标签页已关闭。请在上方下拉框中选择其他标签页。';
  }
  if (/policy|not allowed|disabled/i.test(m)) {
    return '浏览器策略禁止了调试功能（通常是公司或学校的组策略禁用了开发者工具）。这种情况下插件无法抓取响应内容。';
  }
  return '';
}

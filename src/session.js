// 监视会话：同时监视多个标签页，并自动跟随从这些标签页打开的新标签页 / 新窗口。
import { TabCapture, explainAttachError } from './capture.js';
import { hostOf } from './filter.js';
import { siteOf } from './util.js';

const SELF = chrome.runtime.getURL('');

function isAttachable(url) {
  if (!url) return true; // 新标签页还没有网址时先尝试连接
  return /^(https?|file|data|blob|about):/i.test(url) && !url.startsWith(SELF);
}

export class CaptureSession {
  /**
   * @param {{ onEvent: (tabId, method, params, sessionId) => void,
   *           onChange: () => void,
   *           onTabAdded?: (info) => void,
   *           onDetachedAll?: (reason) => void }} handlers
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.tabs = new Map();     // tabId -> info
    this.nextIndex = 1;
    this.rootSites = new Set(); // 手动加入的标签页所属网站，用于"同网站自动加入"
    this.options = {
      followOpened: true,
      sameSite: true,
      reloadOnJoin: false,
    };
    this.cacheDisabled = false;
    this._bind();
  }

  // ---------------- 查询 ----------------

  get(tabId) { return this.tabs.get(tabId); }

  has(tabId) { return this.tabs.has(tabId); }

  list() { return [...this.tabs.values()].sort((a, b) => a.index - b.index); }

  getCapture(tabId) {
    const t = this.tabs.get(tabId);
    return t && t.capture;
  }

  activeCount() {
    return this.list().filter((t) => t.status === 'ok').length;
  }

  primary() {
    return this.list().find((t) => !t.closed) || this.list()[0];
  }

  // ---------------- 增删 ----------------

  /**
   * @param {number} tabId
   * @param {{ reason?: 'manual'|'opener'|'site', openerTabId?: number, url?: string }} opts
   */
  async add(tabId, opts = {}) {
    if (this.tabs.has(tabId)) {
      const t = this.tabs.get(tabId);
      if (t.status === 'ok' || t.status === 'connecting') return t;
      return this.reconnect(tabId);
    }
    const info = {
      tabId,
      index: this.nextIndex++,
      reason: opts.reason || 'manual',
      openerTabId: opts.openerTabId,
      title: '',
      url: opts.url || '',
      status: 'connecting', // connecting | ok | error | detached
      error: '',
      closed: false,
      capture: null,
      mainFrameId: null,
      addedAt: Date.now(),
    };
    this.tabs.set(tabId, info);
    this.handlers.onChange();
    // 先连接（越早越好），标签页标题等信息并行获取
    const infoReady = this._refreshInfo(info).then(() => {
      if (info.reason === 'manual' && info.url) {
        const s = siteOf(hostOf(info.url));
        if (s) this.rootSites.add(s);
      }
    });
    await Promise.all([this._attach(info), infoReady]);
    this.handlers.onChange();
    if (this.handlers.onTabAdded) this.handlers.onTabAdded(info);
    if (info.status === 'ok' && info.reason !== 'manual' && this.options.reloadOnJoin) {
      chrome.tabs.reload(tabId).catch(() => {});
    }
    return info;
  }

  async remove(tabId) {
    const info = this.tabs.get(tabId);
    if (!info) return;
    this.tabs.delete(tabId);
    if (info.capture) await info.capture.detach().catch(() => {});
    this.handlers.onChange();
  }

  async reconnect(tabId) {
    const info = this.tabs.get(tabId);
    if (!info || info.closed) return info;
    if (info.capture) await info.capture.detach().catch(() => {});
    info.status = 'connecting';
    info.error = '';
    this.handlers.onChange();
    await this._attach(info);
    return info;
  }

  async reconnectAll() {
    await Promise.all(this.list().filter((t) => !t.closed && t.status !== 'ok').map((t) => this.reconnect(t.tabId)));
  }

  async detachAll() {
    await Promise.all(this.list().map((t) => (t.capture ? t.capture.detach().catch(() => {}) : null)));
  }

  async setCacheDisabled(disabled) {
    this.cacheDisabled = disabled;
    await Promise.all(this.list().map((t) => (t.capture ? t.capture.setCacheDisabled(disabled) : null)));
  }

  isSameSite(url) {
    const s = siteOf(hostOf(url || ''));
    return !!s && this.rootSites.has(s);
  }

  // ---------------- 内部 ----------------

  async _refreshInfo(info) {
    try {
      const tab = await chrome.tabs.get(info.tabId);
      info.title = tab.title || '';
      info.url = tab.url || tab.pendingUrl || info.url;
      info.windowId = tab.windowId;
    } catch (_) { /* 标签页可能已关闭 */ }
  }

  async _attach(info) {
    const cap = new TabCapture(info.tabId, {
      onEvent: (method, params, sessionId) => this.handlers.onEvent(info.tabId, method, params, sessionId),
      onDetach: (reason) => this._onDetach(info, cap, reason),
    });
    cap.cacheDisabled = this.cacheDisabled;
    info.capture = cap;
    try {
      await cap.attach();
      if (info.capture !== cap) return; // 期间被移除或重连
      info.mainFrameId = cap.mainFrameId;
      info.status = 'ok';
      info.error = '';
      // 补录连接前（或断开期间）发出的请求
      if (this.handlers.onAttached) this.handlers.onAttached(info, info.detachedAt || 0, cap.enabledAt || Date.now());
    } catch (err) {
      if (info.capture !== cap) return;
      info.status = 'error';
      info.error = explainAttachError(err.message) || err.message;
      info.rawError = err.message;
    }
    this.handlers.onChange();
  }

  _onDetach(info, cap, reason) {
    if (info.capture !== cap) return;
    info.status = 'detached';
    info.detachedAt = Date.now();
    info.detachReason = reason;
    info.error = reason === 'canceled_by_user'
      ? '浏览器顶部的调试提示条被关闭'
      : (info.closed ? '标签页已关闭' : '标签页跳转到了无法调试的页面，或已关闭');
    this.handlers.onChange();
    if (reason === 'canceled_by_user' && this.handlers.onDetachedAll) {
      // 关闭提示条会断开本插件的全部调试连接
      clearTimeout(this._detachAllTimer);
      this._detachAllTimer = setTimeout(() => this.handlers.onDetachedAll(reason), 50);
    }
  }

  _bind() {
    // 从被监视的标签页打开的新标签页 / 新窗口（target=_blank、window.open 等）
    this._onCreatedNavTarget = (d) => {
      if (!this.options.followOpened) return;
      if (!this.tabs.has(d.sourceTabId) || this.tabs.has(d.tabId)) return;
      if (!isAttachable(d.url)) return;
      this.add(d.tabId, { reason: 'opener', openerTabId: d.sourceTabId, url: d.url });
    };
    this._onTabCreated = (tab) => {
      if (!this.options.followOpened) return;
      if (tab.openerTabId == null || !this.tabs.has(tab.openerTabId) || this.tabs.has(tab.id)) return;
      const url = tab.pendingUrl || tab.url;
      // 用户按 Ctrl+T 新建的标签页也会带 openerTabId，只跟随真正打开了网页的
      if (!url || !/^(https?|file):/i.test(url)) return;
      this.add(tab.id, { reason: 'opener', openerTabId: tab.openerTabId, url });
    };
    this._onTabUpdated = (tabId, change, tab) => {
      const info = this.tabs.get(tabId);
      if (info) {
        let changed = false;
        if (change.title != null && change.title !== info.title) { info.title = change.title; changed = true; }
        if (change.url != null && change.url !== info.url) { info.url = change.url; changed = true; }
        if (changed) this.handlers.onChange();
        // 跳转回可调试页面后自动重连
        if (info.status === 'detached' && info.detachReason === 'target_closed' && change.status === 'complete' && isAttachable(tab.url)) {
          this.reconnect(tabId);
        }
        return;
      }
      if (!this.options.sameSite || !change.url) return;
      if (tab.url && tab.url.startsWith(SELF)) return;
      if (this.isSameSite(change.url)) this.add(tabId, { reason: 'site', url: change.url });
    };
    this._onTabRemoved = (tabId) => {
      const info = this.tabs.get(tabId);
      if (!info) return;
      info.closed = true;
      info.status = 'detached';
      info.error = '标签页已关闭';
      this.handlers.onChange();
    };

    if (chrome.webNavigation) chrome.webNavigation.onCreatedNavigationTarget.addListener(this._onCreatedNavTarget);
    chrome.tabs.onCreated.addListener(this._onTabCreated);
    chrome.tabs.onUpdated.addListener(this._onTabUpdated);
    chrome.tabs.onRemoved.addListener(this._onTabRemoved);
  }
}

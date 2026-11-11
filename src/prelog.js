// 用 webRequest 接口给调试器"补漏"。
//
// chrome.debugger 有两种情况会漏掉请求：
//   1. 新窗口刚打开时，页面本身和首批资源在调试器连上之前就已发出；
//   2. 页面跳转换进程的一瞬间，新页面最早发出的几个资源请求。
// 这里持续缓存最近的 webRequest 记录：
//   - 标签页加入监视时，把连接前的记录补进列表（take）；
//   - 被监视标签页的每个请求结束后稍等片刻，如果调试器没有对应记录，也补进列表（onCandidate）。
// webRequest 拿不到响应内容，所以补录的请求只有网址、标头和状态。

const KEEP_MS = 60 * 1000;
const MAX_RECORDS = 3000;
const CHECK_DELAY_MS = 800;

export class PreAttachLog {
  /**
   * @param {{ isMonitored: (tabId) => boolean,
   *           onCandidate: (rec) => void,   // 请求已结束、可能被调试器漏掉，交给调用方核对后补录
   *           onUpdate: (rec) => void }} handlers   // 已补录的记录有新进展
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.recs = new Map();     // key -> record（按插入顺序）
    this.current = new Map();  // webRequest requestId -> 当前 key（重定向会产生新 key）
    this.seq = 0;
    this.available = !!(chrome.webRequest && chrome.webRequest.onBeforeRequest);
  }

  start() {
    if (!this.available) return;
    const W = chrome.webRequest;
    const filter = { urls: ['<all_urls>'] };
    const safe = (fn) => (d) => { try { fn(d); } catch (e) { console.warn(e); } };

    W.onBeforeRequest.addListener(safe((d) => this._begin(d)), filter, ['requestBody']);
    W.onSendHeaders.addListener(safe((d) => this._patch(d, { requestHeaders: d.requestHeaders })),
      filter, ['requestHeaders', 'extraHeaders']);
    W.onHeadersReceived.addListener(safe((d) => this._patch(d, {
      responseHeaders: d.responseHeaders, statusCode: d.statusCode, statusLine: d.statusLine, responseAt: d.timeStamp,
    })), filter, ['responseHeaders', 'extraHeaders']);
    W.onBeforeRedirect.addListener(safe((d) => this._patch(d, {
      statusCode: d.statusCode, statusLine: d.statusLine, redirectUrl: d.redirectUrl, ip: d.ip,
      fromCache: d.fromCache, endAt: d.timeStamp, done: true,
    })), filter);
    W.onCompleted.addListener(safe((d) => this._patch(d, {
      statusCode: d.statusCode, statusLine: d.statusLine, ip: d.ip, fromCache: d.fromCache, endAt: d.timeStamp, done: true,
    })), filter);
    W.onErrorOccurred.addListener(safe((d) => this._patch(d, { error: d.error, endAt: d.timeStamp, done: true })), filter);
  }

  _begin(d) {
    if (d.tabId == null || d.tabId < 0) return;
    const key = `${d.requestId}#${++this.seq}`;
    this.current.set(d.requestId, key);
    this.recs.set(key, {
      key,
      tabId: d.tabId,
      url: d.url,
      method: d.method,
      type: d.type,
      frameId: d.frameId,
      timeStamp: d.timeStamp,
      requestBody: d.requestBody,
      taken: false,
    });
    this._prune(d.timeStamp);
  }

  _patch(d, fields) {
    const key = this.current.get(d.requestId);
    const rec = key && this.recs.get(key);
    if (!rec) return;
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) rec[k] = v;
    if (rec.taken) {
      this.handlers.onUpdate(rec);
    } else if (fields.done && this.handlers.isMonitored(rec.tabId)) {
      // 等调试器的事件都到齐了再核对
      setTimeout(() => {
        if (rec.taken || !this.handlers.isMonitored(rec.tabId)) return;
        rec.taken = true;
        this.handlers.onCandidate(rec);
      }, CHECK_DELAY_MS);
    }
  }

  _prune(now) {
    for (const [key, rec] of this.recs) {
      if (this.recs.size <= MAX_RECORDS && rec.timeStamp >= now - KEEP_MS) break;
      this.recs.delete(key);
    }
    if (this.current.size > MAX_RECORDS * 2) {
      for (const [id, key] of this.current) {
        if (!this.recs.has(key)) this.current.delete(id);
        if (this.current.size <= MAX_RECORDS) break;
      }
    }
  }

  /** 取出某标签页在 [fromMs, toMs) 之间开始的、尚未处理的记录（连接前 / 断开期间发出的请求） */
  take(tabId, fromMs, toMs) {
    const out = [];
    for (const rec of this.recs.values()) {
      if (rec.taken || rec.tabId !== tabId) continue;
      if (rec.timeStamp < fromMs || rec.timeStamp >= toMs) continue;
      rec.taken = true;
      out.push(rec);
    }
    return out;
  }
}

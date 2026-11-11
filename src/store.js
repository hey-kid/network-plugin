// 把 CDP 的 Network 事件合并成一条条"请求记录"。

const MAX_ENTRIES = 20000;

// 加载完成后立即拉取响应体的资源类型（避免被浏览器缓冲区淘汰）。
// 图片 / 媒体 / 字体体积大，等到查看时再拉取。
const EAGER_BODY_TYPES = new Set([
  'XHR', 'Fetch', 'Document', 'Script', 'Stylesheet', 'Manifest', 'Other', 'Preflight', 'TextTrack',
]);

const TEXT_MIME_RE = /^(text\/|application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded|[\w.+-]*\+(json|xml)))|json|xml|javascript/i;

export function isTextMime(mime) {
  return !!mime && TEXT_MIME_RE.test(mime);
}

function headerObj(h) {
  return h && typeof h === 'object' ? { ...h } : {};
}

export class NetworkStore {
  constructor() {
    this.entries = [];          // 按开始顺序
    this.byKey = new Map();     // `${tabId}:${requestId}` -> entry
    this.pendingExtra = new Map(); // 先于主事件到达的 ExtraInfo
    this.nextId = 1;
    this.recording = true;
    this.listeners = new Set();
    this.session = null;        // CaptureSession，用于拉取响应体、识别主框架
    this.preserveLog = true;
    this.clockOffset = null;    // wallTime - CDP 单调时间（秒），用于换算补录请求的时间
    this.wrEntries = new Map(); // 补录记录 key -> entry
    this.bodyQueue = [];
    this.bodyInFlight = 0;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(kind, entry) { for (const fn of this.listeners) fn(kind, entry); }

  /** 不传 tabId 清空全部；传 tabId 只清空该标签页的记录 */
  clear(tabId) {
    if (tabId == null) {
      this.entries = [];
      this.byKey.clear();
      this.pendingExtra.clear();
      this.bodyQueue = [];
      this.wrEntries.clear();
    } else {
      this.entries = this.entries.filter((e) => e.tabId !== tabId);
      for (const [k, e] of this.byKey) if (e.tabId === tabId) this.byKey.delete(k);
      for (const [k, e] of this.wrEntries) if (e.tabId === tabId) this.wrEntries.delete(k);
      this.bodyQueue = this.bodyQueue.filter((e) => e.tabId !== tabId);
    }
    this.emit('clear', tabId);
  }

  // 同一标签页内按 requestId 匹配，不区分会话：跨进程 iframe 的导航请求
  // 会在父会话里开始、在子会话里收到响应。
  key(requestId, tabId) { return `${tabId}:${requestId}`; }

  get(requestId, tabId) { return this.byKey.get(this.key(requestId, tabId)); }

  _create(requestId, tabId, sessionId, init) {
    const entry = {
      id: this.nextId++,
      requestId,
      tabId,
      sessionId: sessionId || null,
      url: '',
      method: 'GET',
      type: 'Other',
      mimeType: '',
      requestHeaders: {},
      requestHeadersExtra: null,
      postData: undefined,
      hasPostData: false,
      status: 0,
      statusText: '',
      protocol: '',
      remoteAddress: '',
      responseHeaders: {},
      responseHeadersExtra: null,
      responseHeadersText: '',
      initiator: null,
      referrerPolicy: '',
      startTime: 0,
      wallTime: 0,
      responseTime: 0,
      endTime: 0,
      timing: null,
      transferSize: 0,
      resourceSize: 0,
      cache: '',              // '' | 'memory' | 'disk' | 'prefetch' | 'serviceworker'
      finished: false,
      failed: false,
      canceled: false,
      errorText: '',
      blockedReason: '',
      body: null,             // { text, base64Encoded } | { error }
      bodyPromise: null,
      frames: null,           // WebSocket / EventSource 消息
      isNavigation: false,
      frameId: '',
      ...init,
    };
    const k = this.key(requestId, tabId);
    this.byKey.set(k, entry);
    this.entries.push(entry);

    const extra = this.pendingExtra.get(k);
    if (extra) {
      this.pendingExtra.delete(k);
      if (extra.req) entry.requestHeadersExtra = extra.req;
      if (extra.res) this._applyResponseExtra(entry, extra.res);
    }

    if (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      for (const r of removed) this.byKey.delete(this.key(r.requestId, r.tabId));
      if (this.wrEntries.size) {
        const gone = new Set(removed);
        for (const [k, e] of this.wrEntries) if (gone.has(e)) this.wrEntries.delete(k);
      }
      this.emit('trim');
    }
    this.emit('add', entry);
    return entry;
  }

  _update(entry) { this.emit('update', entry); }

  _applyResponse(entry, response, timestamp, type) {
    entry.status = response.status;
    entry.statusText = response.statusText || '';
    entry.mimeType = response.mimeType || entry.mimeType;
    entry.responseHeaders = headerObj(response.headers);
    entry.protocol = response.protocol || entry.protocol;
    if (response.remoteIPAddress) {
      entry.remoteAddress = response.remoteIPAddress.includes(':')
        ? `[${response.remoteIPAddress}]:${response.remotePort}`
        : `${response.remoteIPAddress}:${response.remotePort}`;
    }
    entry.timing = response.timing || entry.timing;
    if (response.fromDiskCache) entry.cache = 'disk';
    if (response.fromServiceWorker) entry.cache = 'serviceworker';
    if (response.fromPrefetchCache) entry.cache = 'prefetch';
    if (response.headersText) entry.responseHeadersText = response.headersText;
    if (response.securityDetails) entry.securityDetails = response.securityDetails;
    entry.responseTime = timestamp || entry.responseTime;
    if (type) entry.type = type;
  }

  _applyResponseExtra(entry, p) {
    entry.responseHeadersExtra = headerObj(p.headers);
    if (p.headersText) entry.responseHeadersText = p.headersText;
    if (p.statusCode && !entry.status) entry.status = p.statusCode;
  }

  _stashExtra(k, field, value) {
    const cur = this.pendingExtra.get(k) || {};
    cur[field] = value;
    this.pendingExtra.set(k, cur);
    if (this.pendingExtra.size > 2000) {
      // 防止无主的 ExtraInfo 无限堆积
      const first = this.pendingExtra.keys().next().value;
      this.pendingExtra.delete(first);
    }
  }

  handleEvent(method, p, sessionId, tabId) {
    switch (method) {
      case 'Network.requestWillBeSent': return this._onRequestWillBeSent(p, sessionId, tabId);
      case 'Network.requestWillBeSentExtraInfo': {
        const e = this.get(p.requestId, tabId);
        if (e) { e.requestHeadersExtra = headerObj(p.headers); this._update(e); }
        else this._stashExtra(this.key(p.requestId, tabId), 'req', headerObj(p.headers));
        return;
      }
      case 'Network.responseReceived': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        e.sessionId = sessionId || null; // 响应体存放在收到响应的那个会话里
        this._applyResponse(e, p.response, p.timestamp, p.type);
        this._update(e);
        return;
      }
      case 'Network.responseReceivedExtraInfo': {
        const e = this.get(p.requestId, tabId);
        if (e) { this._applyResponseExtra(e, p); this._update(e); }
        else this._stashExtra(this.key(p.requestId, tabId), 'res', p);
        return;
      }
      case 'Network.requestServedFromCache': {
        const e = this.get(p.requestId, tabId);
        if (e) { e.cache = e.cache || 'memory'; this._update(e); }
        return;
      }
      case 'Network.dataReceived': {
        const e = this.get(p.requestId, tabId);
        if (e) { e.resourceSize += p.dataLength || 0; }
        return;
      }
      case 'Network.loadingFinished': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        e.sessionId = sessionId || null;
        e.finished = true;
        e.endTime = p.timestamp;
        e.transferSize = p.encodedDataLength || 0;
        this._update(e);
        if (EAGER_BODY_TYPES.has(e.type) || isTextMime(e.mimeType)) this._queueBody(e);
        return;
      }
      case 'Network.loadingFailed': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        e.finished = true;
        e.failed = true;
        e.canceled = !!p.canceled;
        e.errorText = p.errorText || '';
        e.blockedReason = p.blockedReason || (p.corsErrorStatus ? `CORS: ${p.corsErrorStatus.corsError}` : '');
        e.endTime = p.timestamp;
        if (p.type) e.type = p.type;
        this._update(e);
        return;
      }

      // ---- WebSocket ----
      case 'Network.webSocketCreated': {
        if (!this.recording) return;
        const old = this.get(p.requestId, tabId);
        if (old) return;
        this._create(p.requestId, tabId, sessionId, {
          url: p.url, type: 'WebSocket', method: 'GET', initiator: p.initiator || null, frames: [],
        });
        return;
      }
      case 'Network.webSocketWillSendHandshakeRequest': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        e.startTime = p.timestamp;
        e.wallTime = p.wallTime;
        e.requestHeaders = headerObj(p.request && p.request.headers);
        this._update(e);
        return;
      }
      case 'Network.webSocketHandshakeResponseReceived': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        e.status = p.response.status;
        e.statusText = p.response.statusText || '';
        e.responseHeaders = headerObj(p.response.headers);
        if (p.response.requestHeaders) e.requestHeadersExtra = headerObj(p.response.requestHeaders);
        if (p.response.headersText) e.responseHeadersText = p.response.headersText;
        e.responseTime = p.timestamp;
        this._update(e);
        return;
      }
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        const r = p.response || {};
        e.frames.push({
          dir: method === 'Network.webSocketFrameSent' ? 'send' : 'recv',
          time: p.timestamp,
          opcode: r.opcode,
          data: r.payloadData || '',
        });
        e.endTime = p.timestamp;
        this._update(e);
        return;
      }
      case 'Network.webSocketFrameError': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        e.frames.push({ dir: 'error', time: p.timestamp, opcode: -1, data: p.errorMessage || '' });
        this._update(e);
        return;
      }
      case 'Network.webSocketClosed': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        e.finished = true;
        e.endTime = p.timestamp;
        this._update(e);
        return;
      }
      case 'Network.eventSourceMessageReceived': {
        const e = this.get(p.requestId, tabId);
        if (!e) return;
        if (!e.frames) e.frames = [];
        e.frames.push({
          dir: 'recv', time: p.timestamp, opcode: 1, data: p.data || '',
          eventName: p.eventName, eventId: p.eventId,
        });
        this._update(e);
        return;
      }
      default:
    }
  }

  _onRequestWillBeSent(p, sessionId, tabId) {
    const k = this.key(p.requestId, tabId);
    const existing = this.byKey.get(k);

    // 重定向：同一个 requestId 会再次触发 requestWillBeSent
    if (existing && p.redirectResponse) {
      this._applyResponse(existing, p.redirectResponse, p.timestamp);
      existing.finished = true;
      existing.endTime = p.timestamp;
      existing.transferSize = existing.transferSize || p.redirectResponse.encodedDataLength || 0;
      existing.redirectedTo = p.request.url;
      // 把旧记录挪到一个新键名下，新键名留给重定向后的请求
      this.byKey.delete(k);
      existing.requestId = `${p.requestId}#redirect${existing.id}`;
      this.byKey.set(this.key(existing.requestId, tabId), existing);
      this._update(existing);
    } else if (existing) {
      return;
    }

    const tabInfo = this.session && this.session.get(tabId);
    const mainFrameId = tabInfo && tabInfo.mainFrameId;
    const isMainNav = !sessionId && p.type === 'Document' && p.requestId === p.loaderId
      && mainFrameId && p.frameId === mainFrameId && !p.redirectResponse;
    // 不保留日志时，只清空发生跳转的那个标签页的记录
    if (isMainNav && !this.preserveLog && this.recording) this.clear(tabId);

    if (!this.recording && !existing) return;

    if (p.wallTime && this.clockOffset == null) {
      this.clockOffset = p.wallTime - p.timestamp;
      this._fixWebRequestClock();
    }

    const req = p.request;
    // 同一个请求如果已经被"连接前补录"记下来了，用调试器拿到的完整记录替换它
    if (this.wrEntries.size) this._dropWebRequestDup(tabId, req.url + (req.urlFragment || ''), req.method, p.wallTime);

    this._create(p.requestId, tabId, sessionId, {
      url: req.url + (req.urlFragment || ''),
      method: req.method,
      type: p.type || 'Other',
      requestHeaders: headerObj(req.headers),
      postData: req.postData,
      hasPostData: !!req.hasPostData || req.postData != null,
      initiator: p.initiator || null,
      referrerPolicy: req.referrerPolicy || '',
      startTime: p.timestamp,
      wallTime: p.wallTime,
      isNavigation: isMainNav,
      frameId: p.frameId || '',
      redirectedFrom: existing ? existing.url : undefined,
      priority: req.initialPriority || '',
    });
  }

  // ---- 连接前补录（webRequest） ----

  _mono(ms) {
    return this.clockOffset == null ? 0 : ms / 1000 - this.clockOffset;
  }

  _fixWebRequestClock() {
    for (const e of this.wrEntries.values()) {
      if (e.wallStartMs) e.startTime = this._mono(e.wallStartMs);
      if (e.wallRespMs) e.responseTime = this._mono(e.wallRespMs);
      if (e.wallEndMs) e.endTime = this._mono(e.wallEndMs);
    }
  }

  _dropWebRequestDup(tabId, url, method, wallTime) {
    const u = stripHash(url);
    for (const [key, e] of this.wrEntries) {
      // 只处理刚在连接时补录的记录：它们可能与连接瞬间调试器抓到的请求重复
      if (!e.preAttach || Date.now() - e.addedAt > 5000) continue;
      if (e.tabId !== tabId || stripHash(e.url) !== u || e.method !== method) continue;
      if (wallTime && Math.abs(e.wallStartMs - wallTime * 1000) > 1500) continue;
      this.wrEntries.delete(key);
      this.entries = this.entries.filter((x) => x !== e);
      this.byKey.delete(this.key(e.requestId, e.tabId));
      this.emit('remove', e);
      return true;
    }
    return false;
  }

  /** 找调试器抓到的同一个请求（一一对应，避免把相邻的同名请求当成一个） */
  findCdpMatch(tabId, url, method, wallMs) {
    const u = stripHash(url);
    let best = null;
    let bestD = 1500;
    for (let i = this.entries.length - 1, n = 0; i >= 0 && n < 1000; i--, n++) {
      const e = this.entries[i];
      if (e.source || e.tabId !== tabId || e._wrMatched || stripHash(e.url) !== u) continue;
      if (e.type === 'WebSocket') return e;
      if (e.method !== method) continue;
      const d = Math.abs(e.wallTime * 1000 - wallMs);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best;
  }

  /** 把 webRequest 记录补进列表；与调试器已有记录重复时跳过 */
  addWebRequestRecord(rec, { preAttach = false } = {}) {
    const match = this.findCdpMatch(rec.tabId, rec.url, rec.method, rec.timeStamp);
    if (match) { match._wrMatched = true; return null; }
    const entry = this._create(`wr:${rec.key}`, rec.tabId, null, {
      source: 'webRequest',
      url: rec.url,
      method: rec.method,
      type: WR_TYPE[rec.type] || 'Other',
      wallTime: rec.timeStamp / 1000,
      wallStartMs: rec.timeStamp,
      startTime: this._mono(rec.timeStamp),
      isNavigation: rec.type === 'main_frame',
      body: { error: preAttach ? PRE_ATTACH_BODY_MSG : MISSED_BODY_MSG },
      preAttach,
      addedAt: Date.now(),
    });
    const pd = requestBodyToString(rec.requestBody);
    if (pd != null) { entry.postData = pd; entry.hasPostData = true; }
    this.wrEntries.set(rec.key, entry);
    // 按开始时间插到正确的位置（补录的请求比连接后抓到的请求更早）
    const list = this.entries;
    let i = list.length - 1;
    if (list[i] === entry) {
      while (i > 0 && list[i - 1].wallTime && list[i - 1].wallTime > entry.wallTime) {
        list[i] = list[i - 1];
        i--;
      }
      list[i] = entry;
    }
    this._applyWebRequest(entry, rec);
    return entry;
  }

  updateWebRequestRecord(rec) {
    const e = this.wrEntries.get(rec.key);
    if (!e) return;
    this._applyWebRequest(e, rec);
    this._update(e);
  }

  _applyWebRequest(e, rec) {
    if (rec.requestHeaders) {
      e.requestHeaders = headerArrayToObj(rec.requestHeaders);
      e.requestHeadersExtra = e.requestHeaders;
    }
    if (rec.responseHeaders) {
      e.responseHeaders = headerArrayToObj(rec.responseHeaders);
      const ct = Object.entries(e.responseHeaders).find(([k]) => k.toLowerCase() === 'content-type');
      if (ct) e.mimeType = String(ct[1]).split(';')[0].trim();
      const cl = Object.entries(e.responseHeaders).find(([k]) => k.toLowerCase() === 'content-length');
      if (cl) e.resourceSize = Number(cl[1]) || 0;
    }
    if (rec.statusCode) {
      e.status = rec.statusCode;
      const m = /^(\S+)\s+\d+\s*(.*)$/.exec(rec.statusLine || '');
      if (m) { e.protocol = m[1].toLowerCase(); e.statusText = m[2]; }
    }
    if (rec.ip) e.remoteAddress = rec.ip;
    if (rec.fromCache) e.cache = 'disk';
    if (rec.responseAt) { e.wallRespMs = rec.responseAt; e.responseTime = this._mono(rec.responseAt); }
    if (rec.redirectUrl) e.redirectedTo = rec.redirectUrl;
    if (rec.done) {
      e.finished = true;
      e.wallEndMs = rec.endAt;
      e.endTime = this._mono(rec.endAt);
    }
    if (rec.error) {
      e.failed = true;
      e.canceled = /ERR_ABORTED/.test(rec.error);
      e.errorText = rec.error;
    }
  }

  // ---- 响应体 ----

  _queueBody(entry) {
    if (entry.body || entry.bodyPromise) return;
    this.bodyQueue.push(entry);
    this._pumpBodies();
  }

  _pumpBodies() {
    while (this.bodyInFlight < 6 && this.bodyQueue.length) {
      const e = this.bodyQueue.shift();
      if (e.body || e.bodyPromise) continue;
      this.bodyInFlight++;
      this.loadBody(e).finally(() => { this.bodyInFlight--; this._pumpBodies(); });
    }
  }

  /** 拉取（或返回已缓存的）响应体 */
  captureFor(entry) {
    const cap = this.session && this.session.getCapture(entry.tabId);
    return cap && cap.attached ? cap : null;
  }

  loadBody(entry) {
    if (entry.body) return Promise.resolve(entry.body);
    if (entry.bodyPromise) return entry.bodyPromise;
    const realId = String(entry.requestId).split('#')[0];
    if (entry.redirectedTo) {
      entry.body = { error: '重定向响应没有可用的响应内容' };
      return Promise.resolve(entry.body);
    }
    const cap = this.captureFor(entry);
    if (!cap) {
      return Promise.resolve({ error: '与该标签页的连接已断开，无法获取响应内容（已获取过的内容不受影响）' });
    }
    entry.bodyPromise = cap.getResponseBody(realId, entry.sessionId || undefined)
      .then((r) => {
        entry.body = { text: r.body, base64Encoded: !!r.base64Encoded };
        return entry.body;
      })
      .catch((err) => {
        entry.body = { error: friendlyBodyError(err.message) };
        return entry.body;
      })
      .finally(() => { entry.bodyPromise = null; this.emit('body', entry); });
    return entry.bodyPromise;
  }

  /** 请求体过大时 requestWillBeSent 里不带，需要单独拉取 */
  async loadPostData(entry) {
    if (entry.postData != null || !entry.hasPostData) return entry.postData;
    const cap = this.captureFor(entry);
    if (!cap) return undefined;
    try {
      const r = await cap.getRequestPostData(String(entry.requestId).split('#')[0], entry.sessionId || undefined);
      entry.postData = r.postData;
    } catch (_) {
      entry.postData = undefined;
    }
    return entry.postData;
  }
}

const PRE_ATTACH_BODY_MSG = '这条请求在插件连接到此标签页之前就已发出，浏览器不提供它的响应内容。'
  + '需要的话，可在右上角勾选「自动加入后刷新一次」，或手动刷新该页面。';

const MISSED_BODY_MSG = '这条请求发生在页面切换的瞬间，调试器没有抓到，是事后补录的，所以没有响应内容。'
  + '刷新该页面通常就能完整抓到。';

const WR_TYPE = {
  main_frame: 'Document', sub_frame: 'Document', stylesheet: 'Stylesheet', script: 'Script',
  image: 'Image', imageset: 'Image', font: 'Font', xmlhttprequest: 'XHR', ping: 'Ping',
  csp_report: 'CSPViolationReport', media: 'Media', websocket: 'WebSocket', object: 'Other', other: 'Other',
};

function stripHash(url) {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

function headerArrayToObj(arr) {
  const out = {};
  for (const h of arr || []) {
    const v = h.value != null ? h.value : (h.binaryValue ? String.fromCharCode(...h.binaryValue) : '');
    out[h.name] = out[h.name] != null ? `${out[h.name]}\n${v}` : v;
  }
  return out;
}

function requestBodyToString(rb) {
  if (!rb) return undefined;
  if (rb.formData) {
    const sp = new URLSearchParams();
    for (const [k, vs] of Object.entries(rb.formData)) for (const v of vs) sp.append(k, v);
    return sp.toString();
  }
  if (rb.raw && rb.raw.length) {
    const parts = rb.raw.filter((r) => r.bytes).map((r) => new Uint8Array(r.bytes));
    if (!parts.length) return rb.raw.some((r) => r.file) ? '（上传的文件，内容不可用）' : undefined;
    const total = parts.reduce((s, p) => s + p.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    return new TextDecoder('utf-8').decode(all);
  }
  return undefined;
}

function friendlyBodyError(msg) {
  if (/No resource with given identifier/i.test(msg) || /No data found/i.test(msg)) {
    return '响应内容已不可用（可能已被浏览器释放，或请求尚未完成/没有响应体）。';
  }
  return `无法获取响应内容：${msg}`;
}

// 请求详情面板：标头 / 载荷 / 预览 / 响应 / 消息 / 发起程序 / 时间
import { el, formatBytes, formatMs, formatClock, statusColor, base64ToBytes, downloadBlob, nameOf, store as prefs } from './util.js';
import { renderJson, tryParseJson } from './jsonview.js';
import { effectiveRequestHeaders, effectiveResponseHeaders, headersToText, decodeBodyText } from './export.js';
import { isTextMime } from './store.js';

const TAB_LABELS = {
  headers: '标头',
  payload: '载荷',
  preview: '预览',
  response: '响应',
  messages: '消息',
  initiator: '发起程序',
  timing: '时间',
};

function getHeader(obj, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj || {})) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

function sortedHeaderRows(obj) {
  const rows = [];
  for (const [k, v] of Object.entries(obj || {})) {
    for (const x of String(v).split('\n')) rows.push([k, x]);
  }
  rows.sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
  return rows;
}

function kvGrid(rows) {
  const g = el('div', 'kv');
  for (const [k, v] of rows) {
    g.append(el('div', 'k', k), el('div', 'v', v));
  }
  return g;
}

function isImage(e) {
  return e.type === 'Image' || /^image\//i.test(e.mimeType || '');
}

function signature(e) {
  return [e.status, e.finished, e.failed, e.frames ? e.frames.length : -1, !!e.body,
    Object.keys(e.responseHeaders || {}).length, Object.keys(e.responseHeadersExtra || {}).length,
    Object.keys(e.requestHeadersExtra || {}).length, e.postData != null].join('|');
}

export class DetailView {
  constructor({ tabsEl, bodyEl, netStore, toast, copy }) {
    this.tabsEl = tabsEl;
    this.bodyEl = bodyEl;
    this.netStore = netStore;
    this.toast = toast;
    this.copy = copy;
    this.entry = null;
    this.tab = prefs.get('detailTab', 'headers');
    this.closedSections = new Set(prefs.get('closedSections', []));
    this.rawSections = new Set();
    this.prettyResponse = true;
    this.msgSel = -1;
    this.msgFilter = '';
    this.sig = '';
    this._refreshTimer = null;
  }

  availableTabs(e) {
    const tabs = ['headers'];
    let hasQuery = false;
    try { hasQuery = !!new URL(e.url).search; } catch (_) { /* 忽略 */ }
    if (hasQuery || e.hasPostData || e.postData != null) tabs.push('payload');
    if (e.type !== 'WebSocket') tabs.push('preview', 'response');
    if (e.frames) tabs.push('messages');
    if (e.initiator) tabs.push('initiator');
    tabs.push('timing');
    return tabs;
  }

  show(entry) {
    this.entry = entry;
    this.msgSel = -1;
    this.msgAtBottom = true;
    this.msgScroll = 0;
    this.sig = signature(entry);
    this.render(false);
  }

  /** 选中记录有更新时调用（节流） */
  refresh(entry) {
    if (!this.entry || entry !== this.entry) return;
    const sig = signature(entry);
    if (sig === this.sig) return;
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      if (this.entry !== entry) return;
      this.sig = signature(entry);
      this.render(true);
    }, 250);
  }

  render(keepScroll) {
    const e = this.entry;
    if (!e) return;
    this.sig = signature(e);
    const tabs = this.availableTabs(e);
    let tab = this.tab;
    if (!tabs.includes(tab)) tab = tab === 'messages' ? 'headers' : (e.frames && tab !== 'headers' ? 'messages' : 'headers');

    this.tabsEl.replaceChildren(...tabs.map((t) => {
      const b = el('button', 'tab' + (t === tab ? ' on' : ''), TAB_LABELS[t]);
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => {
        this.tab = t;
        prefs.set('detailTab', t);
        this.render(false);
      });
      return b;
    }));

    const scroll = keepScroll ? this.bodyEl.scrollTop : 0;
    const content = el('div');
    switch (tab) {
      case 'headers': this.renderHeaders(e, content); break;
      case 'payload': this.renderPayload(e, content); break;
      case 'preview': this.renderBody(e, content, true); break;
      case 'response': this.renderBody(e, content, false); break;
      case 'messages': this.renderMessages(e, content); break;
      case 'initiator': this.renderInitiator(e, content); break;
      case 'timing': this.renderTiming(e, content); break;
      default:
    }
    this.bodyEl.replaceChildren(content);
    this.bodyEl.scrollTop = scroll;
  }

  section(id, title, bodyNode, { actions = [], note = '' } = {}) {
    const sec = el('div', 'sec' + (this.closedSections.has(id) ? ' closed' : ''));
    const head = el('div', 'sec-head');
    head.append(el('span', 'arrow', '▼'), el('span', null, title));
    if (actions.length) {
      const a = el('span', 'actions');
      for (const [label, fn] of actions) {
        const b = el('button', 'link-btn', label);
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        a.append(b);
      }
      head.append(a);
    }
    head.addEventListener('click', () => {
      sec.classList.toggle('closed');
      if (sec.classList.contains('closed')) this.closedSections.add(id);
      else this.closedSections.delete(id);
      prefs.set('closedSections', [...this.closedSections]);
    });
    const body = el('div', 'sec-body');
    body.append(bodyNode);
    sec.append(head);
    if (note) sec.append(el('div', 'sec-note', note));
    sec.append(body);
    return sec;
  }

  // ---------- 标头 ----------
  renderHeaders(e, root) {
    const general = [['请求网址', e.url], ['请求方法', e.method]];
    const statusNode = el('div', 'v');
    if (e.failed) {
      statusNode.textContent = e.canceled ? '(已取消)' : `(失败) ${e.errorText}${e.blockedReason ? ' · ' + e.blockedReason : ''}`;
      statusNode.style.color = 'var(--error)';
    } else if (e.status) {
      const dot = el('span', 'status-dot');
      dot.style.background = statusColor(e);
      statusNode.append(dot, document.createTextNode(`${e.status} ${e.statusText || ''}`.trim()
        + (e.cache ? `（来自${{ memory: '内存缓存', disk: '磁盘缓存', prefetch: '预提取缓存', serviceworker: 'Service Worker' }[e.cache]}）` : '')));
    } else {
      statusNode.textContent = '(待处理)';
    }
    const g = el('div', 'kv');
    for (const [k, v] of general) g.append(el('div', 'k', k), el('div', 'v', v));
    g.append(el('div', 'k', '状态代码'), statusNode);
    if (e.remoteAddress) g.append(el('div', 'k', '远程地址'), el('div', 'v', e.remoteAddress));
    if (e.referrerPolicy) g.append(el('div', 'k', '引用站点策略'), el('div', 'v', e.referrerPolicy));
    if (e.protocol) g.append(el('div', 'k', '协议'), el('div', 'v', e.protocol));
    if (e.redirectedTo) g.append(el('div', 'k', '重定向到'), el('div', 'v', e.redirectedTo));
    if (e.wallTime) g.append(el('div', 'k', '开始时间'), el('div', 'v', formatClock(e.wallTime)));
    root.append(this.section('general', '常规', g, {
      actions: [['复制网址', () => this.copy(e.url, '网址')]],
      note: e.source === 'webRequest'
        ? (e.preAttach
          ? 'ⓘ 这条请求在插件连接到此标签页之前就已发出，是事后补录的：有网址、标头和状态码，但没有响应内容和详细耗时。'
          : 'ⓘ 这条请求发生在页面切换的瞬间，调试器没有抓到，是事后补录的：有网址、标头和状态码，但没有响应内容和详细耗时。')
        : '',
    }));

    const resH = effectiveResponseHeaders(e);
    const reqH = effectiveRequestHeaders(e);
    const resRaw = this.rawSections.has('resH');
    const reqRaw = this.rawSections.has('reqH');

    const resBody = resRaw
      ? el('pre', 'raw', e.responseHeadersText || headersToText(resH))
      : kvGrid(sortedHeaderRows(resH));
    root.append(this.section('resH', `响应标头 (${sortedHeaderRows(resH).length})`, resBody, {
      actions: [
        [resRaw ? '格式化' : '原始', () => { this.toggleRaw('resH'); }],
        ['复制', () => this.copy(headersToText(resH), '响应标头')],
      ],
    }));

    const reqBody = reqRaw ? el('pre', 'raw', headersToText(reqH)) : kvGrid(sortedHeaderRows(reqH));
    const provisional = !e.requestHeadersExtra && Object.keys(reqH || {}).length && e.type !== 'WebSocket'
      ? '⚠ 显示的是临时标头（浏览器未提供实际发送的完整标头，Cookie 等可能缺失）' : '';
    root.append(this.section('reqH', `请求标头 (${sortedHeaderRows(reqH).length})`, reqBody, {
      note: e.cache ? '' : provisional,
      actions: [
        [reqRaw ? '格式化' : '原始', () => { this.toggleRaw('reqH'); }],
        ['复制', () => this.copy(headersToText(reqH), '请求标头')],
      ],
    }));
  }

  toggleRaw(id) {
    if (this.rawSections.has(id)) this.rawSections.delete(id);
    else this.rawSections.add(id);
    this.render(true);
  }

  // ---------- 载荷 ----------
  renderPayload(e, root) {
    let params = [];
    let rawQuery = '';
    try {
      const u = new URL(e.url);
      rawQuery = u.search.slice(1);
      params = [...u.searchParams.entries()];
    } catch (_) { /* 忽略 */ }

    if (rawQuery) {
      const raw = this.rawSections.has('query');
      root.append(this.section('query', `查询字符串参数 (${params.length})`,
        raw ? el('pre', 'raw', rawQuery) : kvGrid(params.map(([k, v]) => [k, v])), {
          actions: [[raw ? '查看解码结果' : '查看源代码', () => this.toggleRaw('query')]],
        }));
    }

    if (e.hasPostData || e.postData != null) {
      const holder = el('div');
      root.append(holder);
      const draw = (data) => {
        holder.replaceChildren();
        if (data == null) {
          holder.append(this.section('body', '请求负载', el('div', 'notice', '请求体不可用')));
          return;
        }
        const ct = (getHeader(effectiveRequestHeaders(e), 'content-type') || '').toLowerCase();
        const raw = this.rawSections.has('body');
        const actions = [['复制', () => this.copy(data, '请求体')]];
        let node;
        let title = '请求负载';
        if (ct.includes('application/x-www-form-urlencoded')) {
          title = '表单数据';
          const sp = new URLSearchParams(data);
          node = raw ? el('pre', 'raw', data) : kvGrid([...sp.entries()]);
          actions.unshift([raw ? '查看解码结果' : '查看源代码', () => this.toggleRaw('body')]);
        } else {
          const json = tryParseJson(data);
          if (json !== undefined && !raw) node = renderJson(json, { autoDepth: 2 });
          else node = el('pre', 'raw', data);
          if (json !== undefined) actions.unshift([raw ? '格式化' : '查看源代码', () => this.toggleRaw('body')]);
        }
        holder.append(this.section('body', title, node, { actions }));
      };
      if (e.postData != null) draw(e.postData);
      else {
        holder.append(el('div', 'notice', '正在加载请求体…'));
        this.netStore.loadPostData(e).then((d) => { if (this.entry === e) draw(d); });
      }
    }
  }

  // ---------- 预览 / 响应 ----------
  renderBody(e, root, preview) {
    if (!e.finished) {
      root.append(el('div', 'notice', '请求尚未完成，完成后会自动显示响应内容。'));
      return;
    }
    if (e.failed) {
      root.append(el('div', 'notice err', `请求失败：${e.errorText || '未知错误'}，没有响应内容。`));
      return;
    }
    if (!e.body) {
      root.append(el('div', 'notice', '正在加载响应内容…'));
      this.netStore.loadBody(e).then(() => { if (this.entry === e) this.render(true); });
      return;
    }
    if (e.body.error) {
      root.append(el('div', 'notice err', e.body.error));
      return;
    }

    const { base64Encoded } = e.body;
    const textual = !base64Encoded || isTextMime(e.mimeType);
    const text = textual ? decodeBodyText(e.body) : '';
    const byteLen = base64Encoded ? Math.floor(e.body.text.length * 3 / 4) : new Blob([e.body.text]).size;

    const bar = el('div', 'body-toolbar');
    bar.append(el('span', 'info', `${e.mimeType || '未知类型'} · ${formatBytes(byteLen)}`));
    const btnCopy = el('button', 'mini-btn', '复制');
    btnCopy.addEventListener('click', () => this.copy(textual ? text : e.body.text, textual ? '响应内容' : '响应内容（Base64）'));
    const btnSave = el('button', 'mini-btn', '另存为');
    btnSave.addEventListener('click', () => {
      const blob = base64Encoded
        ? new Blob([base64ToBytes(e.body.text)], { type: e.mimeType || 'application/octet-stream' })
        : new Blob([e.body.text], { type: e.mimeType || 'text/plain' });
      downloadBlob(blob, (nameOf(e.url).replace(/[?#].*$/, '') || 'response').replace(/[\\/:*?"<>|]/g, '_'));
    });

    // 预览
    if (preview) {
      if (isImage(e)) {
        let src;
        if (base64Encoded) src = `data:${e.mimeType};base64,${e.body.text}`;
        else if (/svg/i.test(e.mimeType)) src = URL.createObjectURL(new Blob([e.body.text], { type: 'image/svg+xml' }));
        if (src) {
          const wrap = el('div', 'img-preview');
          const img = el('img');
          img.src = src;
          const info = el('div', 'info');
          img.addEventListener('load', () => { info.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${formatBytes(byteLen)} · ${e.mimeType}`; });
          wrap.append(img, info);
          root.append(wrap);
          return;
        }
      }
      const json = textual ? tryParseJson(text) : undefined;
      if (json !== undefined) {
        bar.append(btnCopy);
        root.append(bar, renderJson(json, { autoDepth: 1 }));
        return;
      }
      if (!textual) {
        bar.append(btnSave);
        root.append(bar, el('div', 'notice', '二进制内容，无法预览。可在「响应」标签中另存为文件。'));
        return;
      }
      bar.append(btnCopy);
      root.append(bar, el('pre', 'raw', text || '（空）'));
      return;
    }

    // 响应
    if (!textual) {
      bar.append(btnCopy, btnSave);
      root.append(bar, el('div', 'notice', `二进制内容（${formatBytes(byteLen)}）。可「另存为」文件，或「复制」Base64 编码。`));
      return;
    }
    const json = tryParseJson(text);
    if (json !== undefined) {
      const btnPretty = el('button', 'mini-btn' + (this.prettyResponse ? ' on' : ''), '{ } 格式化');
      btnPretty.addEventListener('click', () => { this.prettyResponse = !this.prettyResponse; this.render(true); });
      bar.append(btnPretty);
    }
    bar.append(btnCopy, btnSave);
    const shown = json !== undefined && this.prettyResponse ? JSON.stringify(json, null, 2) : text;
    root.append(bar, el('pre', 'raw', shown || '（空）'));
  }

  // ---------- 消息（WebSocket / EventSource） ----------
  renderMessages(e, root) {
    const wrap = el('div', 'msg-wrap');
    const filterBar = el('div', 'msg-filter');
    const input = el('input');
    input.placeholder = '筛选消息';
    input.value = this.msgFilter;
    const count = el('span', 'info');
    filterBar.append(input, count);
    const list = el('div', 'msg-list');
    const detail = el('div', 'msg-detail hidden');
    wrap.append(filterBar, list, detail);
    root.append(wrap);
    root.style.height = '100%';

    const base = e.wallTime && e.startTime ? e.wallTime - e.startTime : 0;
    const drawList = () => {
      const q = this.msgFilter.toLowerCase();
      list.replaceChildren();
      const frag = document.createDocumentFragment();
      let shown = 0;
      e.frames.forEach((f, i) => {
        if (q && !String(f.data).toLowerCase().includes(q)) return;
        shown++;
        const row = el('div', `msg ${f.dir}` + (i === this.msgSel ? ' sel' : ''));
        const arrow = f.dir === 'send' ? '↑' : f.dir === 'recv' ? '↓' : '!';
        const dataText = f.opcode === 2 ? `二进制消息（Base64）${f.data.slice(0, 80)}` : String(f.data).slice(0, 300);
        row.append(
          el('span', 'd', arrow),
          el('span', 'data', (f.eventName && f.eventName !== 'message' ? `[${f.eventName}] ` : '') + dataText),
          el('span', 'len', formatBytes(f.data.length)),
          el('span', 'time', formatClock(base + f.time)),
        );
        row.addEventListener('click', () => {
          this.msgSel = i;
          list.querySelectorAll('.msg.sel').forEach((x) => x.classList.remove('sel'));
          row.classList.add('sel');
          drawDetail();
        });
        frag.append(row);
      });
      list.append(frag);
      count.textContent = `${shown} / ${e.frames.length} 条消息`;
    };
    const drawDetail = () => {
      const f = e.frames[this.msgSel];
      if (!f) { detail.classList.add('hidden'); return; }
      detail.classList.remove('hidden');
      const bar = el('div', 'body-toolbar');
      bar.append(el('span', 'info', `${f.dir === 'send' ? '发送' : f.dir === 'recv' ? '接收' : '错误'} · ${formatClock(base + f.time)} · ${formatBytes(f.data.length)}`));
      const btn = el('button', 'mini-btn', '复制');
      btn.addEventListener('click', () => this.copy(f.data, '消息'));
      bar.append(btn);
      const json = tryParseJson(f.data);
      detail.replaceChildren(bar, json !== undefined ? renderJson(json, { autoDepth: 2 }) : el('pre', 'raw', f.data));
    };
    input.addEventListener('input', () => { this.msgFilter = input.value; drawList(); });
    drawList();
    drawDetail();
    if (!e.frames.length) list.append(el('div', 'notice', '还没有消息'));

    // 保持滚动位置；停在底部时自动跟随新消息
    requestAnimationFrame(() => {
      if (this.msgAtBottom !== false) list.scrollTop = list.scrollHeight;
      else list.scrollTop = this.msgScroll || 0;
    });
    list.addEventListener('scroll', () => {
      this.msgScroll = list.scrollTop;
      this.msgAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    });
  }

  // ---------- 发起程序 ----------
  renderInitiator(e, root) {
    const ini = e.initiator;
    const g = el('div', 'kv');
    const typeName = { parser: '解析器', script: '脚本', preload: '预加载', SignedExchange: 'SignedExchange', preflight: '预检请求', other: '其他' }[ini.type] || ini.type;
    g.append(el('div', 'k', '类型'), el('div', 'v', typeName));
    if (ini.url) g.append(el('div', 'k', '来源'), el('div', 'v', ini.url + (ini.lineNumber != null ? `:${ini.lineNumber + 1}` : '')));
    if (e.redirectedFrom) g.append(el('div', 'k', '重定向自'), el('div', 'v', e.redirectedFrom));
    root.append(this.section('ini', '发起程序', g));

    if (ini.stack) {
      const box = el('div', 'stack');
      let st = ini.stack;
      let first = true;
      while (st) {
        if (!first) box.append(el('div', 'async', `(异步) ${st.description || ''}`));
        for (const f of st.callFrames || []) {
          const fr = el('div', 'fr');
          fr.append(el('span', 'fn', f.functionName || '(匿名)'),
            el('span', 'loc', `${f.url || '(内联脚本)'}:${f.lineNumber + 1}:${f.columnNumber + 1}`));
          box.append(fr);
        }
        first = false;
        st = st.parent;
      }
      root.append(this.section('stack', '调用堆栈', box));
    }
  }

  // ---------- 时间 ----------
  renderTiming(e, root) {
    const wrap = el('div', 'timing');
    const total = e.endTime && e.startTime ? (e.endTime - e.startTime) * 1000 : 0;
    const t = e.timing;
    const phases = [];
    if (t && e.startTime) {
      const base = (t.requestTime - e.startTime) * 1000; // 相对 startTime 的毫秒偏移
      const at = (ms) => base + ms;
      const firstNet = [t.dnsStart, t.connectStart, t.sendStart].find((x) => x >= 0) ?? 0;
      phases.push(['group', '资源调度']);
      phases.push(['排队', 0, Math.max(0, base), 'var(--wf-queue)']);
      phases.push(['group', '连接开始']);
      phases.push(['停滞', at(0), at(firstNet), 'var(--wf-queue)']);
      if (t.dnsStart >= 0) phases.push(['DNS 查找', at(t.dnsStart), at(t.dnsEnd), 'var(--wf-dns)']);
      if (t.connectStart >= 0) phases.push(['初始连接', at(t.connectStart), at(t.connectEnd), 'var(--wf-conn)']);
      if (t.sslStart >= 0) phases.push(['SSL', at(t.sslStart), at(t.sslEnd), 'var(--wf-ssl)']);
      phases.push(['group', '请求/响应']);
      phases.push(['已发送请求', at(t.sendStart), at(t.sendEnd), 'var(--wf-send)']);
      phases.push(['等待服务器响应 (TTFB)', at(t.sendEnd), at(t.receiveHeadersEnd), 'var(--wf-wait)']);
      if (e.endTime) phases.push(['内容下载', at(t.receiveHeadersEnd), total, 'var(--wf-dl)']);
    } else {
      phases.push(['group', '概要']);
      if (e.responseTime && e.startTime) {
        phases.push(['等待响应', 0, (e.responseTime - e.startTime) * 1000, 'var(--wf-wait)']);
        if (e.endTime) phases.push(['内容下载', (e.responseTime - e.startTime) * 1000, total, 'var(--wf-dl)']);
      } else if (total) {
        phases.push(['总耗时', 0, total, 'var(--wf-dl)']);
      }
    }

    const scale = Math.max(total, ...phases.filter((p) => p[0] !== 'group').map((p) => p[2] || 0), 1);
    const table = el('table');
    for (const p of phases) {
      const tr = el('tr');
      if (p[0] === 'group') {
        tr.className = 'group';
        const td = el('td', null, p[1]);
        td.colSpan = 3;
        tr.append(td);
      } else {
        const [label, start, end, color] = p;
        const dur = Math.max(0, end - start);
        const bar = el('td', 'bar');
        const track = el('div', 'track');
        const i = el('i');
        i.style.left = `${(Math.max(0, start) / scale) * 100}%`;
        i.style.width = `${(dur / scale) * 100}%`;
        i.style.background = color;
        track.append(i);
        bar.append(track);
        tr.append(el('td', null, label), bar, el('td', 'ms', formatMs(dur)));
      }
      table.append(tr);
    }
    const tr = el('tr', 'total');
    const td = el('td', null, '总计');
    td.colSpan = 2;
    tr.append(td, el('td', 'ms', e.endTime ? formatMs(total) : '(待处理)'));
    table.append(tr);
    wrap.append(table);
    if (e.cache) wrap.append(el('div', 'notice', '该请求来自缓存，部分时间信息不可用。'));
    root.append(wrap);
  }
}

import { CaptureSession } from './session.js';
import { PreAttachLog } from './prelog.js';
import { NetworkStore } from './store.js';
import { TYPE_CHIPS, categoryOf, compileFilter, hostOf } from './filter.js';
import {
  buildHar, toCurl, toFetch, decodeBodyText, effectiveRequestHeaders, effectiveResponseHeaders, headersToText,
} from './export.js';
import { DetailView } from './detail.js';
import {
  esc, nameOf, formatBytes, formatMs, shortLocation, siteOf, copyText, downloadBlob, store as prefs,
} from './util.js';

const $ = (id) => document.getElementById(id);
const ROW_H = 22;

const COLUMNS = [
  { id: 'name', label: '名称', width: 'minmax(180px, 3fr)' },
  { id: 'tab', label: '标签页', width: 'minmax(90px, 1fr)', multiOnly: true },
  { id: 'status', label: '状态', width: '72px' },
  { id: 'method', label: '方法', width: '64px' },
  { id: 'type', label: '类型', width: '84px' },
  { id: 'initiator', label: '发起程序', width: 'minmax(110px, 1.4fr)' },
  { id: 'size', label: '大小', width: '86px', right: true },
  { id: 'time', label: '时间', width: '76px', right: true },
  { id: 'waterfall', label: '瀑布', width: 'minmax(120px, 1.6fr)' },
];

const ICON = { xhr: 'X', doc: 'D', css: 'C', js: 'J', font: 'F', img: 'I', media: 'M', manifest: 'M', ws: 'W', wasm: 'W', other: '•' };
const CACHE_LABEL = { memory: '(内存缓存)', disk: '(磁盘缓存)', prefetch: '(预提取缓存)', serviceworker: '(ServiceWorker)' };
const REASON_LABEL = { manual: '手动添加', opener: '自动跟随', site: '同网站' };

// ------------------------------------------------------------------
// 状态
// ------------------------------------------------------------------
const netStore = new NetworkStore();
const state = {
  initialTabId: Number(new URLSearchParams(location.search).get('tabId')) || null,
  selectedId: null,
  types: new Set(prefs.get('types', ['all'])),
  text: '',
  invert: false,
  searchBody: prefs.get('searchBody', false),
  opts: prefs.get('opts', { hideData: false, hideExt: false, onlyErrors: false, onlyThirdParty: false }),
  domains: new Set(),
  showDomains: prefs.get('showDomains', false),
  tabFilter: null,
  multiTab: false,
  sort: { col: null, dir: 1 },
  filtered: [],
  dirty: true,
  stick: true,
  domainSig: '',
  tabsSig: '',
};

// 用 webRequest 给调试器补漏：连接前发出的请求、页面切换进程时漏掉的请求
const prelog = new PreAttachLog({
  isMonitored: (tabId) => {
    const t = netStore.recording && session.get(tabId);
    return !!t && t.status === 'ok';
  },
  onCandidate: (rec) => netStore.addWebRequestRecord(rec),
  onUpdate: (rec) => netStore.updateWebRequestRecord(rec),
});
prelog.start();

const session = new CaptureSession({
  onEvent: (tabId, method, params, sessionId) => netStore.handleEvent(method, params, sessionId, tabId),
  onAttached: (info, fromMs, toMs) => {
    if (!netStore.recording) return;
    for (const rec of prelog.take(info.tabId, fromMs, toMs)) netStore.addWebRequestRecord(rec, { preAttach: true });
  },
  onChange: () => { state.tabsDirty = true; schedule(); },
  onTabAdded: (info) => {
    if (info.reason !== 'manual') {
      if (info.status === 'ok') toast(`已自动加入 #${info.index}：${info.title || hostOf(info.url) || '新标签页'}`);
      else toast(`#${info.index} 无法监视：${info.error}`);
    }
  },
  onDetachedAll: () => {
    showBanner('监视已停止：浏览器顶部的「正在调试此浏览器」提示条被关闭了。已记录的请求仍可查看。', {
      action: { label: '全部重新连接', fn: () => { showBanner(null); session.reconnectAll(); } },
    });
  },
});
session.options = { ...session.options, ...prefs.get('sessionOpts', {}) };
netStore.session = session;

const detail = new DetailView({
  tabsEl: $('detailTabs'),
  bodyEl: $('detailBody'),
  netStore,
  toast,
  copy: (text, label) => copyAndToast(text, label),
});

// ------------------------------------------------------------------
// 渲染
// ------------------------------------------------------------------
let rafPending = false;
function schedule(full = true) {
  if (full) state.dirty = true;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderAll();
  });
}

function host(e) {
  if (e._host === undefined) e._host = hostOf(e.url);
  return e._host;
}

function isErr(e) {
  return e.failed || e.status >= 400;
}

/** 被监视的网站（用于区分第一方 / 第三方） */
function firstPartySites() {
  const s = new Set(session.rootSites);
  for (const t of session.list()) {
    const site = siteOf(hostOf(t.url));
    if (site) s.add(site);
  }
  return s;
}

function recompute() {
  const pred = compileFilter(state.text, { searchBody: state.searchBody });
  const sites = firstPartySites();
  const allTypes = state.types.has('all');
  const counts = new Map();
  const out = [];
  for (const e of netStore.entries) {
    const o = state.opts;
    if (state.tabFilter != null && e.tabId !== state.tabFilter) continue;
    if (o.hideData && (e.url.startsWith('data:') || e.url.startsWith('blob:'))) continue;
    if (o.hideExt && /^(chrome|edge|moz)-extension:/.test(e.url)) continue;
    if (o.onlyErrors && !isErr(e)) continue;
    const h = host(e);
    if (o.onlyThirdParty && sites.has(siteOf(h))) continue;
    if (!allTypes && !state.types.has(categoryOf(e))) continue;
    if (pred) {
      const m = pred(e);
      if (state.invert ? m : !m) continue;
    }
    counts.set(h, (counts.get(h) || 0) + 1);
    if (state.domains.size && !state.domains.has(h)) continue;
    out.push(e);
  }
  if (state.sort.col) {
    const key = sortKey(state.sort.col);
    const dir = state.sort.dir;
    out.sort((a, b) => {
      const x = key(a); const y = key(b);
      return (x < y ? -1 : x > y ? 1 : a.id - b.id) * dir;
    });
  }
  state.filtered = out;
  state.domainCounts = counts;
  state.sites = sites;
}

function sortKey(col) {
  switch (col) {
    case 'name': return (e) => nameOf(e.url).toLowerCase();
    case 'tab': return (e) => { const t = session.get(e.tabId); return t ? t.index : 0; };
    case 'status': return (e) => (e.failed ? -1 : e.status);
    case 'method': return (e) => e.method;
    case 'type': return (e) => typeText(e);
    case 'initiator': return (e) => initiatorText(e);
    case 'size': return (e) => e.transferSize || e.resourceSize;
    case 'time': return (e) => (e.endTime ? e.endTime - e.startTime : Infinity);
    case 'waterfall': return (e) => e.startTime;
    default: return (e) => e.id;
  }
}

function typeText(e) {
  if (e.type === 'Image' && e.mimeType) return e.mimeType.split('/')[1].replace('+xml', '');
  if (e.type === 'EventSource') return 'eventsource';
  return (e.type || 'other').toLowerCase();
}

function statusText(e) {
  if (e.failed) return e.canceled ? '(已取消)' : '(失败)';
  if (!e.status) return e.finished ? '' : '(待处理)';
  return String(e.status);
}

function statusTitle(e) {
  if (e.failed) return `${e.errorText}${e.blockedReason ? ' · ' + e.blockedReason : ''}`;
  return `${e.status || ''} ${e.statusText || ''}`.trim();
}

function sizeText(e) {
  if (e.source === 'webRequest') return e.cache ? CACHE_LABEL[e.cache] : (e.resourceSize ? formatBytes(e.resourceSize) : '—');
  if (e.cache) return CACHE_LABEL[e.cache];
  if (e.type === 'WebSocket') return e.frames ? `${e.frames.length} 条消息` : '';
  if (!e.finished) return '';
  return formatBytes(e.transferSize);
}

function timeText(e) {
  if (e.source === 'webRequest' && e.wallEndMs) return formatMs(e.wallEndMs - e.wallStartMs);
  if (!e.endTime) return e.failed ? '' : '(待处理)';
  return formatMs((e.endTime - e.startTime) * 1000);
}

function initiatorText(e) {
  const ini = e.initiator;
  if (e.redirectedFrom) return `${nameOf(e.redirectedFrom)}（重定向）`;
  if (!ini) return '';
  if (ini.type === 'parser' && ini.url) return shortLocation(ini.url, ini.lineNumber);
  if (ini.type === 'script') {
    let st = ini.stack;
    while (st) {
      const f = (st.callFrames || []).find((x) => x.url);
      if (f) return shortLocation(f.url, f.lineNumber);
      st = st.parent;
    }
    return ini.url ? shortLocation(ini.url, ini.lineNumber) : '脚本';
  }
  if (ini.type === 'preflight') return '预检';
  if (ini.type === 'preload') return ini.url ? shortLocation(ini.url, ini.lineNumber) : '预加载';
  if (ini.url) return shortLocation(ini.url, ini.lineNumber);
  return '其他';
}

function initiatorTitle(e) {
  const ini = e.initiator;
  if (e.redirectedFrom) return e.redirectedFrom;
  if (!ini) return '';
  if (ini.stack) {
    let st = ini.stack;
    while (st) {
      const f = (st.callFrames || []).find((x) => x.url);
      if (f) return `${f.url}:${f.lineNumber + 1}`;
      st = st.parent;
    }
  }
  return ini.url || '';
}

function tabLabel(t) {
  if (!t) return '';
  return `#${t.index} ${t.title || hostOf(t.url) || '新标签页'}`;
}

function waterfallHtml(e, min, range) {
  if (!e.startTime || !range) return '';
  const end = e.endTime || state.maxTs || e.startTime;
  const resp = e.responseTime && e.responseTime <= end ? e.responseTime : end;
  const pct = (t) => ((t - min) / range) * 100;
  const left = pct(e.startTime);
  const mid = pct(resp);
  const right = pct(end);
  const wait = Math.max(0.15, mid - left);
  const dl = Math.max(0, right - mid);
  return `<div class="wf"><i class="w" style="left:${left}%;width:${wait}%"></i>${
    dl > 0 ? `<i class="d" style="left:${mid}%;width:${Math.max(0.15, dl)}%"></i>` : ''}</div>`;
}

const CELL = {
  name: (e) => {
    const cat = categoryOf(e);
    const note = e.source === 'webRequest' ? '\n（调试器没抓到，已用 webRequest 补录标头，没有响应内容）' : '';
    return `<div class="cell c-name" title="${esc(e.url + note)}"><span class="ticon ${cat}">${ICON[cat]}</span><span class="t">${esc(nameOf(e.url))}</span></div>`;
  },
  tab: (e) => {
    const t = session.get(e.tabId);
    return `<div class="cell c-tab dim" title="${esc(t ? `${t.title}\n${t.url}` : '')}"><span class="t">${esc(tabLabel(t))}</span></div>`;
  },
  status: (e) => `<div class="cell c-status" title="${esc(statusTitle(e))}"><span class="t">${esc(statusText(e))}</span></div>`,
  method: (e) => `<div class="cell c-method dim"><span class="t">${esc(e.method)}</span></div>`,
  type: (e) => `<div class="cell c-type dim"><span class="t">${esc(typeText(e))}</span></div>`,
  initiator: (e) => `<div class="cell c-initiator dim" title="${esc(initiatorTitle(e))}"><span class="t">${esc(initiatorText(e))}</span></div>`,
  size: (e) => `<div class="cell c-size right" title="已传输 ${formatBytes(e.transferSize)}，资源大小 ${formatBytes(e.resourceSize)}"><span class="t">${esc(sizeText(e))}</span></div>`,
  time: (e) => `<div class="cell c-time right"><span class="t">${esc(timeText(e))}</span></div>`,
  waterfall: (e, min, range) => `<div class="cell c-waterfall">${waterfallHtml(e, min, range)}</div>`,
};

function visibleColumns() {
  return COLUMNS.filter((c) => !c.multiOnly || state.multiTab);
}

function rowHtml(e, i, min, range, cols) {
  const cls = `row${i % 2 ? ' alt' : ''}${e.id === state.selectedId ? ' sel' : ''}${isErr(e) ? ' err' : ''}${!e.finished ? ' pending' : ''}${e.source === 'webRequest' ? ' wr' : ''}`;
  let html = `<div class="${cls}" data-id="${e.id}" data-idx="${i}">`;
  for (const c of cols) html += CELL[c.id](e, min, range);
  return html + '</div>';
}

function applyColumns() {
  const cols = visibleColumns();
  document.documentElement.style.setProperty('--cols', cols.map((c) => c.width).join(' '));
  const thead = $('thead');
  thead.innerHTML = cols.map((c) => {
    const sorted = state.sort.col === c.id;
    const arrow = sorted ? `<span class="sort">${state.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
    return `<div class="th c-${c.id}${c.right ? ' right' : ''}" data-col="${c.id}">${esc(c.label)}${arrow}</div>`;
  }).join('');
}

function renderRows() {
  const tbody = $('tbody');
  const list = state.filtered;
  const n = list.length;
  $('sizer').style.height = `${n * ROW_H}px`;
  if (state.stick && !state.sort.col) tbody.scrollTop = tbody.scrollHeight;

  const top = tbody.scrollTop;
  const h = tbody.clientHeight || 600;
  const start = Math.max(0, Math.floor(top / ROW_H) - 8);
  const end = Math.min(n, Math.ceil((top + h) / ROW_H) + 8);

  let min = Infinity; let max = 0;
  for (const e of list) {
    if (e.startTime && e.startTime < min) min = e.startTime;
    const t = e.endTime || e.responseTime || e.startTime;
    if (t > max) max = t;
  }
  state.maxTs = Math.max(max, state.maxTs || 0);
  const range = isFinite(min) ? Math.max(state.maxTs - min, 0.001) : 0;

  const cols = visibleColumns();
  let html = '';
  for (let i = start; i < end; i++) html += rowHtml(list[i], i, min, range, cols);
  const rows = $('rows');
  rows.style.transform = `translateY(${start * ROW_H}px)`;
  rows.innerHTML = html;
}

function renderStatus() {
  const all = netStore.entries;
  const f = state.filtered;
  const sum = (arr, k) => arr.reduce((s, e) => s + (e[k] || 0), 0);
  let min = Infinity; let max = 0;
  for (const e of f) {
    if (e.startTime && e.startTime < min) min = e.startTime;
    if (e.endTime > max) max = e.endTime;
  }
  const parts = [
    `${f.length} / ${all.length} 个请求`,
    `已传输 ${formatBytes(sum(f, 'transferSize'))} / ${formatBytes(sum(all, 'transferSize'))}`,
    `资源 ${formatBytes(sum(f, 'resourceSize'))} / ${formatBytes(sum(all, 'resourceSize'))}`,
  ];
  if (isFinite(min) && max > min) parts.push(`用时 ${formatMs((max - min) * 1000)}`);
  const n = session.list().length;
  if (n > 1) parts.push(`监视 ${session.activeCount()} / ${n} 个标签页`);
  if (!netStore.recording) parts.push('⏸ 已暂停记录');
  $('statusbar').innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('');
}

function renderEmpty() {
  const box = $('empty');
  const total = netStore.entries.length;
  const connected = session.activeCount() > 0;
  if ((!connected && !total) || state.filtered.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (!total && netStore.recording) {
    box.innerHTML = '<div class="big">正在记录网络活动…</div>'
      + '<div>插件连接之前页面已发出的请求不会被记录。<br>点击「重新加载页面」可从头记录页面加载过程中的全部请求。</div>'
      + '<button id="btnEmptyReload">重新加载页面</button>';
    $('btnEmptyReload').addEventListener('click', reloadTarget);
  } else if (!total) {
    box.innerHTML = '<div class="big">未在记录网络活动</div><div>点击左上角的记录按钮（Ctrl+E）开始记录。</div>';
  } else {
    box.innerHTML = '<div class="big">没有符合筛选条件的请求</div><div>调整上方的筛选文本、类型、标签页或域名。</div>';
  }
}

function renderDomains() {
  const pane = $('domainPane');
  pane.classList.toggle('hidden', !state.showDomains);
  $('btnDomains').classList.toggle('active', state.showDomains);
  if (!state.showDomains) return;
  const counts = state.domainCounts || new Map();
  const sites = state.sites || new Set();
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sig = items.map((x) => x.join('=')).join('|') + '#' + [...state.domains].join(',') + '#' + [...sites].join(',');
  if (sig === state.domainSig) return;
  state.domainSig = sig;

  const first = items.filter(([h]) => sites.has(siteOf(h)));
  const third = items.filter(([h]) => !sites.has(siteOf(h)));
  const total = items.reduce((s, x) => s + x[1], 0);
  const li = (h, c) => `<li data-host="${esc(h)}" class="${state.domains.has(h) ? 'on' : ''}" title="${esc(h)}"><span class="host">${esc(h || '(无域名)')}</span><span class="count">${c}</span></li>`;
  let html = `<li data-host="*" class="${state.domains.size ? '' : 'on'}"><span class="host">全部域名</span><span class="count">${total}</span></li>`;
  if (first.length) html += `<li class="group">监视的网站（${esc([...sites].join('、'))}）</li>` + first.map(([h, c]) => li(h, c)).join('');
  if (third.length) html += '<li class="group">第三方</li>' + third.map(([h, c]) => li(h, c)).join('');
  $('domainList').innerHTML = html;
}

function renderChips() {
  $('typeChips').innerHTML = TYPE_CHIPS.map((c) => `<button class="chip${state.types.has(c.id) ? ' on' : ''}" data-type="${c.id}">${esc(c.label)}</button>`).join('');
}

/** 右上角按钮、标签页弹窗、标签页筛选下拉框 */
function renderTabs() {
  const tabs = session.list();
  const counts = new Map();
  for (const e of netStore.entries) counts.set(e.tabId, (counts.get(e.tabId) || 0) + 1);

  const multi = tabs.length > 1;
  if (multi !== state.multiTab) {
    state.multiTab = multi;
    applyColumns();
  }

  // 按钮
  const active = session.activeCount();
  const busy = tabs.some((t) => t.status === 'connecting');
  const dot = $('connDot');
  dot.className = 'conn-dot ' + (busy ? 'busy' : !tabs.length ? '' : active === tabs.filter((t) => !t.closed).length && active ? 'ok' : active ? 'warn' : 'err');
  const p = session.primary();
  $('tabsLabel').textContent = !tabs.length ? '选择要监视的标签页'
    : tabs.length === 1 ? (p.title || hostOf(p.url) || `标签页 ${p.tabId}`)
      : `监视 ${tabs.length} 个标签页（${active} 个已连接）`;
  document.title = p ? `网络 · ${p.title || hostOf(p.url)}${multi ? ` 等 ${tabs.length} 个标签页` : ''}` : '网络请求监视器';

  // 同网站说明
  const sites = [...session.rootSites];
  $('sameSiteLabel').textContent = sites.length ? `访问同一网站（${sites.join('、')}）的其他标签页` : '访问同一网站的其他标签页';

  // 弹窗里的列表
  const sig = JSON.stringify(tabs.map((t) => [t.tabId, t.status, t.title, t.url, t.error, t.closed, counts.get(t.tabId) || 0]));
  if (sig !== state.tabsSig) {
    state.tabsSig = sig;
    $('tabsList').innerHTML = tabs.map((t) => {
      const cls = t.status === 'ok' ? 'ok' : t.status === 'connecting' ? 'busy' : 'err';
      const opener = t.openerTabId && session.get(t.openerTabId) ? `由 #${session.get(t.openerTabId).index} 打开` : REASON_LABEL[t.reason];
      const sub = t.status === 'ok' || t.status === 'connecting'
        ? `<div class="tab-sub">${esc(hostOf(t.url) || t.url)} · ${esc(opener)} · ${counts.get(t.tabId) || 0} 个请求</div>`
        : `<div class="tab-sub err">${esc(t.error || '未连接')} · ${counts.get(t.tabId) || 0} 个请求</div>`;
      const btns = [];
      if (!t.closed) btns.push('<button class="link-btn" data-act="focus">切换到</button>');
      if (!t.closed && t.status === 'ok') btns.push('<button class="link-btn" data-act="reload">刷新</button>');
      if (!t.closed && t.status !== 'ok' && t.status !== 'connecting') btns.push('<button class="link-btn" data-act="reconnect">重连</button>');
      btns.push('<button class="link-btn" data-act="remove">移除</button>');
      return `<li class="tab-item${t.closed ? ' closed' : ''}" data-tab="${t.tabId}"><span class="conn-dot ${cls}"></span>`
        + `<span class="tab-idx">#${t.index}</span><div class="tab-meta"><div class="tab-title" title="${esc(t.url)}">${esc(t.title || t.url || '新标签页')}</div>${sub}</div>${btns.join('')}</li>`;
    }).join('') || '<li class="tab-item"><span class="tab-sub">还没有监视任何标签页，请在下方添加。</span></li>';

    // 标签页筛选
    const sel = $('selTabFilter');
    sel.classList.toggle('hidden', !multi);
    if (state.tabFilter != null && !session.has(state.tabFilter)) state.tabFilter = null;
    sel.innerHTML = '<option value="">全部标签页</option>'
      + tabs.map((t) => `<option value="${t.tabId}">${esc(tabLabel(t).slice(0, 40))}</option>`).join('');
    sel.value = state.tabFilter != null ? String(state.tabFilter) : '';
    sel.classList.toggle('on', state.tabFilter != null);
  }
}

function renderAll() {
  if (state.tabsDirty) {
    state.tabsDirty = false;
    renderTabs();
  }
  if (state.dirty) {
    recompute();
    state.dirty = false;
  }
  renderRows();
  renderStatus();
  renderEmpty();
  renderDomains();
}

// ------------------------------------------------------------------
// 选择与详情
// ------------------------------------------------------------------
function findEntry(id) {
  return netStore.entries.find((e) => e.id === id);
}

function select(id, { scroll = false } = {}) {
  const e = findEntry(id);
  if (!e) return;
  state.selectedId = id;
  state.stick = false;
  $('main').classList.add('detail-open');
  $('detailPane').classList.remove('hidden');
  $('splitter').classList.remove('hidden');
  detail.show(e);
  if (scroll) {
    const idx = state.filtered.indexOf(e);
    const tbody = $('tbody');
    const top = idx * ROW_H;
    if (top < tbody.scrollTop) tbody.scrollTop = top;
    else if (top + ROW_H > tbody.scrollTop + tbody.clientHeight) tbody.scrollTop = top + ROW_H - tbody.clientHeight;
  }
  schedule(false);
}

function closeDetail() {
  state.selectedId = null;
  detail.entry = null;
  $('main').classList.remove('detail-open');
  $('detailPane').classList.add('hidden');
  $('splitter').classList.add('hidden');
  schedule(false);
}

// ------------------------------------------------------------------
// 标签页管理
// ------------------------------------------------------------------
function showBanner(msg, { error = false, action } = {}) {
  const b = $('banner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.className = 'banner' + (error ? ' error' : '');
  b.replaceChildren();
  const span = document.createElement('span');
  span.textContent = msg;
  b.append(span);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', action.fn);
    b.append(btn);
  }
}

async function addManual(tabId) {
  const info = await session.add(tabId, { reason: 'manual' });
  if (info && info.status === 'error') {
    showBanner(`无法监视 #${info.index}「${info.title || info.url}」：${info.error}${info.rawError && info.rawError !== info.error ? `（${info.rawError}）` : ''}`, {
      error: true,
      action: { label: '重试', fn: () => { showBanner(null); session.reconnect(tabId).then(() => schedule()); } },
    });
  }
  schedule();
}

async function refreshAddList() {
  const sel = $('selAddTab');
  const self = chrome.runtime.getURL('');
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) { /* 忽略 */ }
  tabs = tabs.filter((t) => !(t.url || '').startsWith(self) && !session.has(t.id));
  sel.innerHTML = tabs.length
    ? tabs.map((t) => `<option value="${t.id}">${esc((t.title || t.url || '').slice(0, 50))}${hostOf(t.url) ? ` — ${esc(hostOf(t.url))}` : ''}</option>`).join('')
    : '<option value="">（没有其他标签页）</option>';
}

function targetTabForReload() {
  if (state.tabFilter != null) return state.tabFilter;
  const p = session.list().find((t) => !t.closed && t.status === 'ok');
  return p ? p.tabId : null;
}

function reloadTarget() {
  const id = targetTabForReload();
  if (id == null) return;
  chrome.tabs.reload(id).catch(() => {});
}

// ------------------------------------------------------------------
// 复制 / 导出
// ------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

async function copyAndToast(text, label) {
  const ok = await copyText(text ?? '');
  toast(ok ? `已复制${label ? '：' + label : ''}` : '复制失败');
}

async function loadBodies(entries) {
  const todo = entries.filter((e) => e.finished && !e.failed && !e.body && e.type !== 'WebSocket');
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const e = todo[i++];
      await netStore.loadBody(e);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

async function exportHar() {
  const entries = state.filtered.slice().sort((a, b) => (a.wallTime || 0) - (b.wallTime || 0) || a.id - b.id);
  if (!entries.length) { toast('没有可导出的请求'); return; }
  toast(`正在准备 ${entries.length} 个请求…`);
  await loadBodies(entries);
  await Promise.all(entries.map((e) => netStore.loadPostData(e)));
  const har = buildHar(entries, document.title);
  const p0 = session.primary();
  const h = (p0 && hostOf(p0.url)) || 'network';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  downloadBlob(new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' }), `${h}_${stamp}.har`);
  toast(`已导出 ${entries.length} 个请求`);
}

// ------------------------------------------------------------------
// 右键菜单
// ------------------------------------------------------------------
function showContextMenu(x, y, e) {
  const menu = $('ctxMenu');
  const h = host(e);
  const t = session.get(e.tabId);
  const items = [
    ['在新标签页中打开', () => chrome.tabs.create({ url: e.url })],
    '-',
    ['复制网址', () => copyAndToast(e.url, '网址')],
    ['复制为 cURL (cmd)', async () => { await netStore.loadPostData(e); copyAndToast(toCurl(e, 'cmd'), 'cURL (cmd)'); }],
    ['复制为 cURL (bash)', async () => { await netStore.loadPostData(e); copyAndToast(toCurl(e, 'bash'), 'cURL (bash)'); }],
    ['复制为 fetch', async () => { await netStore.loadPostData(e); copyAndToast(toFetch(e), 'fetch'); }],
    ['复制响应内容', async () => {
      const b = await netStore.loadBody(e);
      if (b.error) toast(b.error); else copyAndToast(decodeBodyText(b) || b.text, '响应内容');
    }],
    ['复制请求标头', () => copyAndToast(headersToText(effectiveRequestHeaders(e)), '请求标头')],
    ['复制响应标头', () => copyAndToast(headersToText(effectiveResponseHeaders(e)), '响应标头')],
    '-',
    ['复制列表中所有网址', () => copyAndToast(state.filtered.map((x) => x.url).join('\n'), `${state.filtered.length} 个网址`)],
    '-',
    [`只看此域名（${h}）`, () => { state.domains = new Set([h]); state.showDomains = true; prefs.set('showDomains', true); schedule(); }],
    [`隐藏此域名（${h}）`, () => {
      const f = $('txtFilter');
      f.value = `${f.value.trim()} -domain:${h}`.trim();
      state.text = f.value;
      schedule();
    }],
  ];
  if (state.multiTab && t) {
    items.push([`只看此标签页（#${t.index}）`, () => { state.tabFilter = t.tabId; state.tabsSig = ''; state.tabsDirty = true; schedule(); }]);
  }
  menu.replaceChildren(...items.map((it) => {
    if (it === '-') return document.createElement('hr');
    const b = document.createElement('button');
    b.textContent = it[0];
    b.addEventListener('click', () => { hideContextMenu(); it[1](); });
    return b;
  }));
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
}

function hideContextMenu() {
  $('ctxMenu').classList.add('hidden');
}

// ------------------------------------------------------------------
// 事件绑定
// ------------------------------------------------------------------
function bind() {
  netStore.subscribe((kind, entry) => {
    if (kind === 'clear') {
      if (state.selectedId != null && !findEntry(state.selectedId)) closeDetail();
      if (entry == null) state.maxTs = 0;
    }
    if ((kind === 'update' || kind === 'body') && entry && entry.id === state.selectedId) detail.refresh(entry);
    if ((kind === 'trim' || kind === 'remove') && state.selectedId != null && !findEntry(state.selectedId)) closeDetail();
    if (kind === 'add' || kind === 'clear') state.tabsDirty = true; // 更新各标签页的请求数
    schedule();
  });

  $('btnRecord').addEventListener('click', toggleRecord);
  $('btnClear').addEventListener('click', () => { netStore.clear(); });
  $('btnReload').addEventListener('click', reloadTarget);
  $('btnExport').addEventListener('click', exportHar);

  const chkPreserve = $('chkPreserve');
  chkPreserve.checked = prefs.get('preserve2', true);
  netStore.preserveLog = chkPreserve.checked;
  chkPreserve.addEventListener('change', () => {
    netStore.preserveLog = chkPreserve.checked;
    prefs.set('preserve2', chkPreserve.checked);
  });

  const chkCache = $('chkDisableCache');
  chkCache.checked = prefs.get('disableCache', false);
  session.cacheDisabled = chkCache.checked;
  chkCache.addEventListener('change', () => {
    prefs.set('disableCache', chkCache.checked);
    session.setCacheDisabled(chkCache.checked);
  });

  const txt = $('txtFilter');
  txt.addEventListener('input', () => { state.text = txt.value; schedule(); });
  $('chkInvert').addEventListener('change', (ev) => { state.invert = ev.target.checked; schedule(); });
  const chkBody = $('chkBody');
  chkBody.checked = state.searchBody;
  chkBody.addEventListener('change', () => {
    state.searchBody = chkBody.checked;
    prefs.set('searchBody', state.searchBody);
    schedule();
  });
  $('btnFilterHelp').addEventListener('click', () => $('filterHelp').classList.toggle('hidden'));

  // 更多筛选
  const pop = $('morePop');
  for (const input of pop.querySelectorAll('input[data-opt]')) {
    input.checked = !!state.opts[input.dataset.opt];
    input.addEventListener('change', () => {
      state.opts[input.dataset.opt] = input.checked;
      prefs.set('opts', state.opts);
      updateMoreLabel();
      schedule();
    });
  }
  updateMoreLabel();
  $('btnMore').addEventListener('click', (ev) => { ev.stopPropagation(); $('tabsPop').classList.add('hidden'); pop.classList.toggle('hidden'); });
  pop.addEventListener('click', (ev) => ev.stopPropagation());

  // 标签页弹窗
  const tabsPop = $('tabsPop');
  $('btnTabs').addEventListener('click', (ev) => {
    ev.stopPropagation();
    pop.classList.add('hidden');
    tabsPop.classList.toggle('hidden');
    if (!tabsPop.classList.contains('hidden')) refreshAddList();
  });
  tabsPop.addEventListener('click', (ev) => ev.stopPropagation());
  for (const input of tabsPop.querySelectorAll('input[data-sopt]')) {
    input.checked = !!session.options[input.dataset.sopt];
    input.addEventListener('change', () => {
      session.options[input.dataset.sopt] = input.checked;
      prefs.set('sessionOpts', session.options);
    });
  }
  $('tabsList').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const tabId = Number(btn.closest('[data-tab]').dataset.tab);
    const t = session.get(tabId);
    if (!t) return;
    switch (btn.dataset.act) {
      case 'focus':
        try {
          const tab = await chrome.tabs.update(tabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (_) { toast('无法切换到该标签页'); }
        break;
      case 'reload': chrome.tabs.reload(tabId).catch(() => {}); break;
      case 'reconnect': session.reconnect(tabId); break;
      case 'remove':
        await session.remove(tabId);
        refreshAddList();
        break;
      default:
    }
  });
  $('btnAddTab').addEventListener('click', async () => {
    const id = Number($('selAddTab').value);
    if (!id) return;
    await addManual(id);
    refreshAddList();
  });

  // 标签页筛选
  $('selTabFilter').addEventListener('change', (ev) => {
    state.tabFilter = ev.target.value ? Number(ev.target.value) : null;
    ev.target.classList.toggle('on', state.tabFilter != null);
    schedule();
  });

  // 类型标签
  $('typeChips').addEventListener('click', (ev) => {
    const b = ev.target.closest('.chip');
    if (!b) return;
    const id = b.dataset.type;
    if (id === 'all') state.types = new Set(['all']);
    else if (ev.ctrlKey || ev.metaKey) {
      state.types.delete('all');
      if (state.types.has(id)) state.types.delete(id); else state.types.add(id);
      if (!state.types.size) state.types.add('all');
    } else {
      state.types = new Set([id]);
    }
    prefs.set('types', [...state.types]);
    renderChips();
    schedule();
  });

  // 域名分类
  $('btnDomains').addEventListener('click', () => {
    state.showDomains = !state.showDomains;
    prefs.set('showDomains', state.showDomains);
    if (!state.showDomains) state.domains.clear();
    state.domainSig = '';
    schedule();
  });
  $('domainList').addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-host]');
    if (!li) return;
    const h = li.dataset.host;
    if (h === '*') state.domains.clear();
    else if (ev.ctrlKey || ev.metaKey) {
      if (state.domains.has(h)) state.domains.delete(h); else state.domains.add(h);
    } else if (state.domains.size === 1 && state.domains.has(h)) state.domains.clear();
    else state.domains = new Set([h]);
    schedule();
  });

  // 表头排序
  $('thead').addEventListener('click', (ev) => {
    const th = ev.target.closest('.th');
    if (!th) return;
    const col = th.dataset.col;
    if (state.sort.col !== col) state.sort = { col, dir: 1 };
    else if (state.sort.dir === 1) state.sort.dir = -1;
    else state.sort = { col: null, dir: 1 };
    applyColumns();
    schedule();
  });

  // 列表
  const tbody = $('tbody');
  tbody.addEventListener('scroll', () => {
    state.stick = tbody.scrollTop + tbody.clientHeight >= tbody.scrollHeight - ROW_H;
    schedule(false);
  });
  tbody.addEventListener('click', (ev) => {
    const row = ev.target.closest('.row');
    if (row) select(Number(row.dataset.id));
  });
  tbody.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    ev.preventDefault();
    const e = findEntry(Number(row.dataset.id));
    if (!e) return;
    select(e.id);
    showContextMenu(ev.clientX, ev.clientY, e);
  });
  tbody.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const list = state.filtered;
    if (!list.length) return;
    let idx = list.findIndex((e) => e.id === state.selectedId);
    idx = ev.key === 'ArrowDown' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1);
    select(list[idx].id, { scroll: true });
  });
  new ResizeObserver(() => schedule(false)).observe(tbody);

  $('btnCloseDetail').addEventListener('click', closeDetail);

  // 分隔条
  const splitter = $('splitter');
  const savedW = prefs.get('listWidth', 340);
  document.documentElement.style.setProperty('--list-w', `${savedW}px`);
  splitter.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    splitter.classList.add('drag');
    const listLeft = $('listPane').getBoundingClientRect().left;
    const move = (e) => {
      const w = Math.max(160, Math.min(window.innerWidth - 300, e.clientX - listLeft));
      document.documentElement.style.setProperty('--list-w', `${w}px`);
      prefs.set('listWidth', w);
    };
    const up = () => {
      splitter.classList.remove('drag');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // 点击工具栏图标时，后台会询问"谁在监视这个标签页"，由已打开的面板接手
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'nm:whoMonitors') return undefined;
    if (!session.has(msg.tabId)) return undefined;
    chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { focused: true })).catch(() => {});
    sendResponse({ ok: true });
    return undefined;
  });

  // 全局
  document.addEventListener('click', () => { hideContextMenu(); pop.classList.add('hidden'); tabsPop.classList.add('hidden'); });
  window.addEventListener('blur', hideContextMenu);
  document.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'e') { ev.preventDefault(); toggleRecord(); }
    else if (mod && ev.key.toLowerCase() === 'f') { ev.preventDefault(); txt.focus(); txt.select(); }
    else if (ev.key === 'Escape') {
      if (!$('ctxMenu').classList.contains('hidden')) hideContextMenu();
      else if (!pop.classList.contains('hidden')) pop.classList.add('hidden');
      else if (!tabsPop.classList.contains('hidden')) tabsPop.classList.add('hidden');
      else if (state.selectedId != null) closeDetail();
    }
  });
  window.addEventListener('beforeunload', () => { session.detachAll(); });
}

function updateMoreLabel() {
  const n = Object.values(state.opts).filter(Boolean).length;
  $('btnMore').firstChild.textContent = n ? `更多筛选 (${n}) ` : '更多筛选 ';
}

function toggleRecord() {
  netStore.recording = !netStore.recording;
  const b = $('btnRecord');
  b.classList.toggle('on', netStore.recording);
  b.title = netStore.recording ? '停止记录网络日志 (Ctrl+E)' : '开始记录网络日志 (Ctrl+E)';
  schedule();
}

// 方便在面板页自己的控制台里调试
globalThis.__netMonitor = { netStore, state, session };

applyColumns();
renderChips();
bind();
state.tabsDirty = true;
if (state.initialTabId) addManual(state.initialTabId);
else {
  showBanner('请点击右上角，选择要监视的标签页。');
  schedule();
}

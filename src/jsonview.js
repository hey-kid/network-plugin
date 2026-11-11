// 可折叠的 JSON 树（子节点按需渲染，大 JSON 也不卡）
import { el } from './util.js';

const CHUNK = 500;

function primitive(v) {
  if (v === null) return el('span', 'jt-null', 'null');
  switch (typeof v) {
    case 'string': return el('span', 'jt-str', JSON.stringify(v));
    case 'number': return el('span', 'jt-num', String(v));
    case 'boolean': return el('span', 'jt-bool', String(v));
    default: return el('span', 'jt-null', String(v));
  }
}

function summary(v) {
  if (Array.isArray(v)) return `Array(${v.length})`;
  const keys = Object.keys(v);
  const parts = [];
  let len = 0;
  for (const k of keys) {
    const x = v[k];
    let s;
    if (x === null) s = 'null';
    else if (Array.isArray(x)) s = `Array(${x.length})`;
    else if (typeof x === 'object') s = '{…}';
    else if (typeof x === 'string') s = JSON.stringify(x.length > 30 ? x.slice(0, 30) + '…' : x);
    else s = String(x);
    const item = `${k}: ${s}`;
    len += item.length;
    parts.push(item);
    if (len > 80) { parts.push('…'); break; }
  }
  return `{${parts.join(', ')}}`;
}

function keyLabel(key) {
  if (key == null) return null;
  const frag = document.createDocumentFragment();
  frag.append(el('span', 'jt-key', String(key)), document.createTextNode(': '));
  return frag;
}

function makeNode(key, value, depth, autoDepth) {
  const isObj = value !== null && typeof value === 'object';
  const node = el('div', 'jt-node');
  if (!isObj) {
    node.classList.add('jt-leaf');
    const k = keyLabel(key);
    if (k) node.append(k);
    node.append(primitive(value));
    return node;
  }

  const head = el('div', 'jt-head');
  head.append(el('span', 'jt-tog', '▶'));
  const k = keyLabel(key);
  if (k) head.append(k);
  head.append(el('span', 'jt-sum', summary(value)));
  const kids = el('div', 'jt-kids');
  node.append(head, kids);

  const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
  let rendered = 0;
  const renderMore = () => {
    const end = Math.min(keys.length, rendered + CHUNK);
    const frag = document.createDocumentFragment();
    for (let i = rendered; i < end; i++) frag.append(makeNode(keys[i], value[keys[i]], depth + 1, autoDepth));
    rendered = end;
    const oldMore = kids.querySelector(':scope > .jt-more');
    if (oldMore) oldMore.remove();
    kids.append(frag);
    if (rendered < keys.length) {
      const more = el('div', 'jt-more', `显示更多（还有 ${keys.length - rendered} 项）`);
      more.addEventListener('click', (ev) => { ev.stopPropagation(); renderMore(); });
      kids.append(more);
    }
  };
  const toggle = (open) => {
    if (open && rendered === 0) renderMore();
    node.classList.toggle('open', open);
  };
  head.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggle(!node.classList.contains('open'));
  });
  if (depth < autoDepth) toggle(true);
  return node;
}

export function renderJson(value, { autoDepth = 1 } = {}) {
  const root = el('div', 'jt');
  root.append(makeNode(null, value, 0, autoDepth));
  return root;
}

export function tryParseJson(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (!t || !(t[0] === '{' || t[0] === '[' || t[0] === '"')) {
    // JSONP / 带前缀的 JSON：)]}' 之类
    const m = /^\)\]\}'?,?\s*([\s\S]+)$/.exec(t);
    if (!m) return undefined;
    try { return JSON.parse(m[1]); } catch (_) { return undefined; }
  }
  try { return JSON.parse(t); } catch (_) { return undefined; }
}

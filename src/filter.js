// 类型分类与筛选语法（与 DevTools 网络面板基本一致）

export const TYPE_CHIPS = [
  { id: 'all', label: '全部' },
  { id: 'xhr', label: 'Fetch/XHR' },
  { id: 'doc', label: '文档' },
  { id: 'css', label: 'CSS' },
  { id: 'js', label: 'JS' },
  { id: 'font', label: '字体' },
  { id: 'img', label: 'Img' },
  { id: 'media', label: '媒体' },
  { id: 'manifest', label: '清单' },
  { id: 'ws', label: '套接字' },
  { id: 'wasm', label: 'Wasm' },
  { id: 'other', label: '其他' },
];

export function categoryOf(e) {
  if (e.mimeType === 'application/wasm') return 'wasm';
  switch (e.type) {
    case 'XHR': case 'Fetch': case 'EventSource': return 'xhr';
    case 'Document': return 'doc';
    case 'Stylesheet': return 'css';
    case 'Script': return 'js';
    case 'Font': return 'font';
    case 'Image': return 'img';
    case 'Media': case 'TextTrack': return 'media';
    case 'Manifest': return 'manifest';
    case 'WebSocket': case 'WebTransport': return 'ws';
    default: return 'other';
  }
}

export function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

function wildcardToRegex(s) {
  return new RegExp('^' + s.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
}

function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(k|m)?b?$/i.exec(s.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  return unit === 'k' ? n * 1024 : unit === 'm' ? n * 1024 * 1024 : n;
}

function headerValue(e, name) {
  const lower = name.toLowerCase();
  for (const src of [e.responseHeadersExtra, e.responseHeaders]) {
    if (!src) continue;
    for (const k of Object.keys(src)) if (k.toLowerCase() === lower) return src[k];
  }
  return undefined;
}

function tokenize(text) {
  const out = [];
  const re = /(-?)(?:([\w-]+):)?("([^"]*)"|\/((?:\\\/|[^/])+)\/(i?)(?=\s|$)|\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      neg: m[1] === '-',
      key: m[2] ? m[2].toLowerCase() : '',
      quoted: m[4],
      regex: m[5],
      regexFlags: m[6],
      raw: m[3],
    });
  }
  return out;
}

const KEYS = new Set([
  'domain', 'method', 'status-code', 'mime-type', 'larger-than', 'scheme',
  'has-response-header', 'resource-type', 'is', 'url',
]);

/**
 * 编译筛选文本。返回 (entry, bodyText?) => boolean
 * 语法：
 *   普通文本            网址包含（不区分大小写）
 *   /正则/              网址匹配正则
 *   -xxx                排除
 *   domain:*.qq.com     域名（支持 * 通配）
 *   method:POST         请求方法
 *   status-code:404     状态码（支持 4xx 写法）
 *   mime-type:json      MIME 类型包含
 *   larger-than:10k     传输大小大于
 *   scheme:https        协议
 *   has-response-header:set-cookie
 *   is:running          尚未完成
 */
export function compileFilter(text, { searchBody = false } = {}) {
  const tokens = tokenize(text || '');
  if (!tokens.length) return null;

  const preds = tokens.map((t) => {
    let pred;
    const key = KEYS.has(t.key) ? t.key : '';
    const value = t.quoted != null ? t.quoted : (key ? t.raw : (t.key ? `${t.key}:${t.raw}` : t.raw));

    if (!key) {
      let re = null;
      if (t.regex != null && !t.key) {
        try { re = new RegExp(t.regex, t.regexFlags || 'i'); } catch (_) { re = null; }
      }
      const needle = value.toLowerCase();
      const matchText = (s) => (s ? (re ? re.test(s) : s.toLowerCase().includes(needle)) : false);
      pred = (e) => {
        if (matchText(e.url)) return true;
        if (!searchBody) return false;
        if (typeof e.postData === 'string' && matchText(e.postData)) return true;
        if (e.body && !e.body.error && !e.body.base64Encoded && matchText(e.body.text)) return true;
        if (e.frames && e.frames.some((f) => matchText(f.data))) return true;
        return false;
      };
    } else {
      switch (key) {
        case 'domain': {
          const re = wildcardToRegex(value);
          pred = (e) => re.test(hostOf(e.url));
          break;
        }
        case 'method': pred = (e) => e.method.toUpperCase() === value.toUpperCase(); break;
        case 'status-code': {
          const v = value.toLowerCase();
          if (/^\dxx$/.test(v)) pred = (e) => String(e.status).startsWith(v[0]);
          else pred = (e) => String(e.status) === v;
          break;
        }
        case 'mime-type': pred = (e) => (e.mimeType || '').toLowerCase().includes(value.toLowerCase()); break;
        case 'larger-than': {
          const n = parseSize(value);
          pred = (e) => (e.transferSize || e.resourceSize) > n;
          break;
        }
        case 'scheme': pred = (e) => e.url.toLowerCase().startsWith(value.toLowerCase() + ':'); break;
        case 'has-response-header': pred = (e) => headerValue(e, value) !== undefined; break;
        case 'resource-type': pred = (e) => e.type.toLowerCase() === value.toLowerCase(); break;
        case 'url': pred = (e) => e.url.toLowerCase().includes(value.toLowerCase()); break;
        case 'is':
          pred = value === 'running' ? (e) => !e.finished : () => true;
          break;
        default: pred = () => true;
      }
    }
    return t.neg ? (e) => !pred(e) : pred;
  });

  return (e) => preds.every((p) => p(e));
}

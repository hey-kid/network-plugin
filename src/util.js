export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1000 / 1000).toFixed(1)} MB`;
}

export function formatMs(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

export function formatClock(epochSec) {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** DevTools 风格的"名称"：路径最后一段 + 查询串 */
export function nameOf(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url.slice(0, 60) + (url.length > 60 ? '…' : '');
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/');
    let last = segs.pop();
    if (last === '' && segs.length > 1) last = segs.pop() + '/';
    if (!last || last === '/') last = u.host + (u.pathname === '/' ? '/' : '');
    let search = u.search;
    try { last = decodeURIComponent(last); } catch (_) { /* 保留原样 */ }
    try { search = decodeURIComponent(search.replace(/\+/g, ' ')); } catch (_) { /* 保留原样 */ }
    return last + search;
  } catch (_) {
    return url;
  }
}

export function shortLocation(url, line) {
  const n = nameOf(url).replace(/\?.*$/, '') || url;
  return line != null && line >= 0 ? `${n}:${line + 1}` : n;
}

export function statusColor(e) {
  if (e.failed) return 'var(--error)';
  if (!e.status) return 'var(--fg-faint)';
  if (e.status >= 400) return 'var(--error)';
  if (e.status >= 300) return '#f29900';
  return '#1e8e3e';
}

export function siteOf(host) {
  // 粗略取"可注册域名"：最后两段；常见二级后缀取三段
  const h = (host || '').replace(/:\d+$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(']')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const sld = parts.slice(-2).join('.');
  if (/^(com|net|org|gov|edu|co|ac)\.(cn|hk|tw|uk|jp|kr|au)$/.test(sld)) return parts.slice(-3).join('.');
  return sld;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const store = {
  get(key, def) {
    try {
      const v = localStorage.getItem('nm:' + key);
      return v == null ? def : JSON.parse(v);
    } catch (_) { return def; }
  },
  set(key, value) {
    try { localStorage.setItem('nm:' + key, JSON.stringify(value)); } catch (_) { /* 忽略 */ }
  },
};

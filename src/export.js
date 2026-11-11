// HAR 导出、复制为 cURL / fetch

export function effectiveRequestHeaders(e) {
  return e.requestHeadersExtra && Object.keys(e.requestHeadersExtra).length
    ? e.requestHeadersExtra : e.requestHeaders;
}

export function effectiveResponseHeaders(e) {
  return e.responseHeadersExtra && Object.keys(e.responseHeadersExtra).length
    ? e.responseHeadersExtra : e.responseHeaders;
}

function headerList(obj) {
  const out = [];
  for (const [name, value] of Object.entries(obj || {})) {
    // CDP 用换行合并同名头（如多个 Set-Cookie）
    for (const v of String(value).split('\n')) out.push({ name, value: v });
  }
  return out;
}

function getHeader(obj, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj || {})) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

function queryList(url) {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch (_) { return []; }
}

function parseCookieHeader(v) {
  if (!v) return [];
  return v.split(/;\s*/).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? { name: p, value: '' } : { name: p.slice(0, i), value: p.slice(i + 1) };
  });
}

function parseSetCookie(v) {
  if (!v) return [];
  return String(v).split('\n').map((line) => {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
  });
}

function httpVersion(e) {
  const p = (e.protocol || '').toLowerCase();
  if (p === 'h2') return 'HTTP/2.0';
  if (p === 'h3') return 'HTTP/3';
  if (p.startsWith('http/')) return p.toUpperCase();
  return p || 'HTTP/1.1';
}

function harTimings(e) {
  const t = e.timing;
  const total = e.endTime && e.startTime ? (e.endTime - e.startTime) * 1000 : -1;
  if (!t) {
    return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: Math.max(0, total), receive: 0 };
  }
  const span = (a, b) => (a >= 0 && b >= 0 ? Math.max(0, b - a) : -1);
  const blocked = Math.max(0, (t.requestTime - e.startTime) * 1000)
    + (t.dnsStart >= 0 ? t.dnsStart : t.connectStart >= 0 ? t.connectStart : t.sendStart);
  const send = span(t.sendStart, t.sendEnd);
  const wait = span(t.sendEnd, t.receiveHeadersEnd);
  const headersEndAbs = t.requestTime * 1000 + t.receiveHeadersEnd;
  const receive = e.endTime ? Math.max(0, e.endTime * 1000 - headersEndAbs) : 0;
  return {
    blocked: Math.max(0, blocked),
    dns: span(t.dnsStart, t.dnsEnd),
    connect: span(t.connectStart, t.connectEnd),
    ssl: span(t.sslStart, t.sslEnd),
    send: Math.max(0, send),
    wait: Math.max(0, wait),
    receive,
  };
}

export function entryToHar(e) {
  const reqHeaders = effectiveRequestHeaders(e);
  const resHeaders = effectiveResponseHeaders(e);
  const timings = harTimings(e);
  const time = Object.values(timings).reduce((s, v) => s + (v > 0 ? v : 0), 0);

  const content = { size: e.resourceSize || 0, mimeType: e.mimeType || 'x-unknown' };
  if (e.body && !e.body.error) {
    content.text = e.body.text;
    if (e.body.base64Encoded) content.encoding = 'base64';
  }

  const har = {
    startedDateTime: new Date((e.wallTime || 0) * 1000).toISOString(),
    time,
    request: {
      method: e.method,
      url: e.url,
      httpVersion: httpVersion(e),
      headers: headerList(reqHeaders),
      queryString: queryList(e.url),
      cookies: parseCookieHeader(getHeader(reqHeaders, 'cookie')),
      headersSize: -1,
      bodySize: typeof e.postData === 'string' ? e.postData.length : 0,
    },
    response: {
      status: e.status || 0,
      statusText: e.statusText || '',
      httpVersion: httpVersion(e),
      headers: headerList(resHeaders),
      cookies: parseSetCookie(getHeader(resHeaders, 'set-cookie')),
      content,
      redirectURL: getHeader(resHeaders, 'location') || '',
      headersSize: -1,
      bodySize: e.transferSize || -1,
      _transferSize: e.transferSize || 0,
      _error: e.failed ? e.errorText : undefined,
    },
    cache: {},
    timings,
    serverIPAddress: e.remoteAddress ? e.remoteAddress.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') : undefined,
    _resourceType: (e.type || 'other').toLowerCase(),
    _initiator: e.initiator || undefined,
  };
  if (typeof e.postData === 'string') {
    har.request.postData = {
      mimeType: getHeader(reqHeaders, 'content-type') || '',
      text: e.postData,
    };
  }
  if (e.frames && e.type === 'WebSocket') {
    har._webSocketMessages = e.frames.map((f) => ({
      type: f.dir === 'send' ? 'send' : 'receive',
      time: f.time,
      opcode: f.opcode,
      data: f.data,
    }));
  }
  return har;
}

export function buildHar(entries, pageTitle) {
  return {
    log: {
      version: '1.2',
      creator: { name: '网络请求监视器', version: chrome.runtime.getManifest().version },
      pages: [],
      entries: entries.map(entryToHar),
      comment: pageTitle || '',
    },
  };
}

// ---- 复制为 cURL / fetch（转义规则参考 Chromium DevTools） ----

const IGNORED_HEADERS = new Set(['host', 'method', 'path', 'scheme', 'version', 'content-length', 'authority']);

function escapePosix(str) {
  if (/[\0-\x1F\x7F-\x9F!]|'/.test(str)) {
    const esc = (x) => '\\u' + x.charCodeAt(0).toString(16).padStart(4, '0');
    return "$'" + str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r').replace(/[\0-\x1F\x7F-\x9F!]/g, esc) + "'";
  }
  return "'" + str + "'";
}

function escapeWin(str) {
  const enc = '^"';
  return enc + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/[^a-zA-Z0-9\s_\-:=+~'/.',?;()*`&]/g, '^$&')
    .replace(/%(?=[a-zA-Z0-9_])/g, '%^')
    .replace(/\r?\n|\r/g, '^\n\n') + enc;
}

export function toCurl(e, platform = 'bash') {
  const esc = platform === 'cmd' ? escapeWin : escapePosix;
  const parts = [];
  parts.push('curl ' + esc(e.url.replace(/#.*$/, '')));

  const headers = effectiveRequestHeaders(e);
  let inferredMethod = 'GET';
  const data = [];
  if (typeof e.postData === 'string') {
    inferredMethod = 'POST';
    data.push('--data-raw ' + esc(e.postData));
  }
  if (e.method !== inferredMethod) parts.push('-X ' + esc(e.method));

  let compressed = false;
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.replace(/^:/, '').toLowerCase();
    if (name.startsWith(':') || IGNORED_HEADERS.has(lower)) continue;
    if (lower === 'accept-encoding') { compressed = /gzip|deflate|br|zstd/.test(value); continue; }
    if (lower === 'cookie') { parts.push('-b ' + esc(value)); continue; }
    parts.push('-H ' + esc(`${name}: ${value}`));
  }
  parts.push(...data);
  if (compressed) parts.push('--compressed');

  const joiner = platform === 'cmd' ? ' ^\n  ' : ' \\\n  ';
  return parts.join(joiner);
}

export function toFetch(e) {
  const headers = {};
  const skip = new Set([...IGNORED_HEADERS, 'cookie', 'user-agent', 'referer', 'accept-encoding', 'connection',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'origin']);
  const src = effectiveRequestHeaders(e) || {};
  for (const [name, value] of Object.entries(src)) {
    if (name.startsWith(':') || skip.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  const init = { headers };
  const referer = getHeader(src, 'referer');
  if (referer) init.referrer = referer;
  if (typeof e.postData === 'string') init.body = e.postData;
  init.method = e.method;
  init.mode = 'cors';
  init.credentials = getHeader(src, 'cookie') ? 'include' : 'omit';
  return `fetch(${JSON.stringify(e.url)}, ${JSON.stringify(init, null, 2)});`;
}

export function headersToText(obj) {
  return Object.entries(obj || {}).flatMap(([k, v]) => String(v).split('\n').map((x) => `${k}: ${x}`)).join('\n');
}

export function decodeBodyText(body) {
  if (!body || body.error) return '';
  if (!body.base64Encoded) return body.text;
  try {
    const bin = atob(body.text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (_) { return ''; }
}

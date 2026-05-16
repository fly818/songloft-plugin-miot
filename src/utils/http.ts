// 小米音箱插件 - HTTP工具
// 基于 QuickJS __go_fetch_sync 桥接函数，提供同步 HTTP 请求和重定向跟踪

/// <reference types="@mimusic/plugin-sdk" />

import { CookieJar, parseCookies } from './cookie';

// 声明 QuickJS 运行时注入的同步 HTTP 桥接函数
declare function __go_fetch_sync(url: string, method: string, headersJSON: string, body: string): string;

/** fetch请求选项（扩展） */
export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual';
}

/** 同步响应头包装器（支持 case-insensitive get） */
class SyncHeaders {
  private _raw: Record<string, string>;
  constructor(raw: Record<string, string>) {
    this._raw = raw || {};
  }
  get(name: string): string | null {
    // 先精确匹配
    if (this._raw[name] !== undefined) return this._raw[name];
    // case-insensitive 匹配
    const lower = name.toLowerCase();
    for (const key of Object.keys(this._raw)) {
      if (key.toLowerCase() === lower) return this._raw[key];
    }
    return null;
  }
  getSetCookie(): string[] {
    const raw = this.get('set-cookie');
    return raw ? [raw] : [];
  }
}

/** 同步 Response 对象（模拟 Fetch API，但所有方法同步返回） */
export interface SyncResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: SyncHeaders;
  text(): string;
  json(): any;
}

/** 重定向跟踪结果 */
export interface RedirectResult {
  response: SyncResponse;
  finalUrl: string;
  redirectCount: number;
}

/**
 * 同步 HTTP 请求（直接调用 __go_fetch_sync 桥接）
 * 绕过 fetch polyfill 的 Promise 包装，确保在 QuickJS 同步执行环境中可用
 */
export function fetchSync(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): SyncResponse {
  const method = (options.method || 'GET').toUpperCase();
  const headersJSON = options.headers ? JSON.stringify(options.headers) : '{}';
  const body = options.body || '';

  const resultJSON = __go_fetch_sync(url, method, headersJSON, body);
  const r = JSON.parse(resultJSON);

  if (r.error) {
    throw new Error(r.error);
  }

  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: r.statusText || '',
    headers: new SyncHeaders(r.headers || {}),
    text() { return r.body || ''; },
    json() { return JSON.parse(r.body); },
  };
}

/**
 * 带Cookie跟踪的重定向请求（同步版）
 * 小米登录流程涉及多次3xx重定向，每步需要收集并回传Cookie
 *
 * @param url - 请求URL
 * @param options - 请求选项
 * @param cookieJar - Cookie管理器
 * @param maxRedirects - 最大重定向次数（默认10）
 * @returns 最终响应和URL
 */
export function fetchWithRedirects(
  url: string,
  options: FetchOptions = {},
  cookieJar: CookieJar,
  maxRedirects = 10,
): RedirectResult {
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    // 构建带Cookie的请求头
    const headers: Record<string, string> = { ...(options.headers || {}) };
    const cookieHeader = cookieJar.getCookieHeader(currentUrl);
    if (cookieHeader) {
      // 合并 cookieJar 的 Cookie 与调用者显式设置的 Cookie（而非覆盖）
      if (headers['Cookie']) {
        headers['Cookie'] = headers['Cookie'] + '; ' + cookieHeader;
      } else {
        headers['Cookie'] = cookieHeader;
      }
    }

    // 添加不跟随重定向标记，由 JS 侧手动处理重定向链以收集中间 Cookie
    headers['X-Fetch-No-Redirect'] = '1';

    const method = redirectCount === 0 ? (options.method || 'GET') : 'GET';
    const body = (redirectCount === 0 && options.body) ? options.body : undefined;

    const response = fetchSync(currentUrl, { method, headers, body });

    // 收集Set-Cookie响应头
    collectCookies(response, currentUrl, cookieJar);

    // 检查是否为重定向
    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        // 没有Location头，返回当前响应
        return { response, finalUrl: currentUrl, redirectCount };
      }

      // 处理相对路径的Location
      currentUrl = resolveUrl(currentUrl, location);
      redirectCount++;
      continue;
    }

    // 非重定向响应
    return { response, finalUrl: currentUrl, redirectCount };
  }

  throw new Error(`Too many redirects (max: ${maxRedirects})`);
}

/**
 * 从Response中收集Set-Cookie头并添加到CookieJar
 */
function collectCookies(response: SyncResponse, url: string, cookieJar: CookieJar): void {
  const setCookieHeaders: string[] = [];

  // 尝试 getSetCookie()
  if (typeof response.headers.getSetCookie === 'function') {
    const cookies = response.headers.getSetCookie();
    setCookieHeaders.push(...cookies);
  } else {
    // 降级：尝试 get('set-cookie')
    const raw = response.headers.get('set-cookie');
    if (raw) {
      setCookieHeaders.push(...splitSetCookieHeader(raw));
    }
  }

  if (setCookieHeaders.length > 0) {
    const cookies = parseCookies(setCookieHeaders, url);
    cookieJar.add(cookies);
  }
}

/**
 * 分割合并在一起的Set-Cookie头
 * HTTP/1.1中多个Set-Cookie可能被合并为逗号分隔的单个头
 */
function splitSetCookieHeader(header: string): string[] {
  const result: string[] = [];
  let current = '';
  let i = 0;

  while (i < header.length) {
    // 查找逗号
    const commaIdx = header.indexOf(',', i);
    if (commaIdx === -1) {
      current += header.slice(i);
      break;
    }

    // 检查逗号后面的内容是否像一个新的cookie（name=value 模式）
    const afterComma = header.slice(commaIdx + 1).trimStart();
    // 如果逗号后面像一个新cookie的开始（包含=且在;之前）
    const eqIdx = afterComma.indexOf('=');
    const semiIdx = afterComma.indexOf(';');
    const spaceIdx = afterComma.indexOf(' ');

    if (eqIdx > 0 && (semiIdx === -1 || eqIdx < semiIdx) && (spaceIdx === -1 || eqIdx < spaceIdx || spaceIdx > 0)) {
      // 可能是新cookie的开始，但也可能是 expires 中的日期逗号
      // 检查逗号之前的内容是否像日期（包含日期关键词）
      const beforeComma = header.slice(i, commaIdx);
      if (isDateFragment(beforeComma)) {
        // 是日期中的逗号，不分割
        current += header.slice(i, commaIdx + 1);
        i = commaIdx + 1;
      } else {
        // 是cookie分隔符
        current += header.slice(i, commaIdx);
        result.push(current.trim());
        current = '';
        i = commaIdx + 1;
      }
    } else {
      // 逗号不是分隔符（可能在日期或值中）
      current += header.slice(i, commaIdx + 1);
      i = commaIdx + 1;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/**
 * 检查字符串是否像日期片段（如 "Mon, 01 Jan..."中逗号前的部分）
 */
function isDateFragment(str: string): boolean {
  const trimmed = str.trim();
  // expires= 后面跟的日期格式中，逗号前通常是星期几缩写
  const lastPart = trimmed.split(';').pop()?.trim() || '';
  // 检查是否匹配 "expires=Xxx" 或 以3字母星期结尾
  return /expires\s*=\s*\w{3}$/i.test(lastPart) || /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(lastPart);
}

/**
 * 解析相对URL为绝对URL
 */
function resolveUrl(base: string, relative: string): string {
  // 已经是绝对URL
  if (relative.startsWith('http://') || relative.startsWith('https://')) {
    return relative;
  }

  // 协议相对URL
  if (relative.startsWith('//')) {
    const proto = base.startsWith('https') ? 'https:' : 'http:';
    return proto + relative;
  }

  // 提取base的origin和path
  const protoIdx = base.indexOf('://');
  const protoEnd = protoIdx + 3;
  const pathIdx = base.indexOf('/', protoEnd);
  const origin = pathIdx === -1 ? base : base.slice(0, pathIdx);

  if (relative.startsWith('/')) {
    // 绝对路径
    return origin + relative;
  }

  // 相对路径
  const basePath = pathIdx === -1 ? '/' : base.slice(pathIdx);
  const lastSlash = basePath.lastIndexOf('/');
  const dir = basePath.slice(0, lastSlash + 1);
  return origin + dir + relative;
}

/**
 * 快速JSON请求（不跟踪Cookie）- 同步版
 */
export function fetchJSON<T = unknown>(url: string, options: FetchOptions = {}): T {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = fetchSync(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });

  if (!response.ok) {
    const text = response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const text = response.text();
  return JSON.parse(text) as T;
}

// ===== 宿主API调用 =====

/**
 * 获取宿主API基础URL
 */
export function getHostBaseUrl(): string {
  return _hostBaseUrl;
}

/** 宿主API基础URL，初始化时设置 */
let _hostBaseUrl = '';

/**
 * 设置宿主API基础URL
 * @param url - 例如 "http://127.0.0.1:58091"
 */
export function setHostBaseUrl(url: string): void {
  _hostBaseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * 调用MiMusic宿主API（同步版）
 * @param method - HTTP方法
 * @param path - API路径（如 /api/v1/songs）
 * @param body - 请求体（将被JSON序列化）
 * @returns 解析后的JSON响应
 */
export function callHostAPI<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): T {
  if (!_hostBaseUrl) {
    throw new Error('Host base URL not set. Call setHostBaseUrl() first.');
  }
  const pluginToken = mimusic.plugin.getToken();
  if (!pluginToken) {
    throw new Error('Plugin token not available from mimusic.plugin.getToken()');
  }

  const url = _hostBaseUrl + path;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${pluginToken}`,
    'Accept': 'application/json',
  };

  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }

  const response = fetchSync(url, {
    method,
    headers,
    body: bodyStr,
  });

  const text = response.text();

  if (!response.ok) {
    throw new Error(`Host API error ${response.status} ${method} ${path}: ${text}`);
  }

  return text ? JSON.parse(text) as T : (undefined as unknown as T);
}

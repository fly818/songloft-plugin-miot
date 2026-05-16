// 小米音箱插件 - URL构造器
// 翻译自 Go 源码: plugins/mimusic-plugin-xiaomi/player/url_builder.go

import { getHostBaseUrl } from '../utils/http';

// Base62 字符集
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 将字符串编码为 Base62
 * 算法：将字符串字节序列视为大整数（base 256），转换为 base 62 编码
 */
function encodeBase62(str: string): string {
  if (!str) {
    return BASE62_CHARS[0];
  }

  // 将字符串转为字节数组，然后视为大整数（base 256）
  // 使用 BigInt 实现大数运算
  let num = BigInt(0);
  const base256 = BigInt(256);

  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    // 处理多字节UTF-8字符
    if (charCode < 128) {
      num = num * base256 + BigInt(charCode);
    } else {
      // 将字符转为 UTF-8 字节序列
      const encoded = encodeURIComponent(str[i]);
      // %XX%XX... 格式
      const matches = encoded.match(/%([0-9A-F]{2})/gi);
      if (matches) {
        for (const m of matches) {
          const byte = parseInt(m.slice(1), 16);
          num = num * base256 + BigInt(byte);
        }
      } else {
        // 纯ASCII字符未被编码
        num = num * base256 + BigInt(charCode);
      }
    }
  }

  if (num === BigInt(0)) {
    return BASE62_CHARS[0];
  }

  // 转为 Base62
  let result = '';
  const base62 = BigInt(62);

  while (num > BigInt(0)) {
    const mod = Number(num % base62);
    result = BASE62_CHARS[mod] + result;
    num = num / base62;
  }

  return result;
}

/**
 * 获取文件路径中不含扩展名的部分
 */
function getPathWithoutExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) {
    return filePath;
  }
  // 确保点号不是路径分隔符后的第一个字符（隐藏文件如 .gitignore）
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot <= lastSlash + 1) {
    return filePath;
  }
  return filePath.slice(0, lastDot);
}

/**
 * 获取文件扩展名（含点号）
 */
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) {
    return '';
  }
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot <= lastSlash + 1) {
    return '';
  }
  return filePath.slice(lastDot);
}

/**
 * URL构造器 - 构造歌曲和封面的播放URL
 */
export class URLBuilder {
  /**
   * 构造歌曲播放URL（带access_token认证）
   *
   * - 本地歌曲(type=local)：/music/{base62EncodedPath}{ext}?access_token={token}
   * - 远程歌曲(type=remote)且URL为相对路径：{serverHost}{url}{?|&}access_token={token}
   * - 远程歌曲(type=remote)且URL为绝对路径：直接返回URL
   */
  static buildSongURL(song: {
    id?: number;
    file_path?: string;
    url?: string;
    type?: string;
  }): string {
    const serverHost = getHostBaseUrl();
    const accessToken = mimusic.plugin.getToken();

    if (song.type === 'local' && song.file_path) {
      // 本地歌曲：使用 Base62 编码路径
      const pathWithoutExt = getPathWithoutExtension(song.file_path);
      const ext = getExtension(song.file_path);
      const encodedPath = encodeBase62(pathWithoutExt);
      return serverHost + '/music/' + encodedPath + ext + '?access_token=' + accessToken;
    }

    // 网络歌曲/电台：处理相对路径
    if (song.url && song.url.startsWith('/')) {
      const separator = song.url.includes('?') ? '&' : '?';
      return serverHost + song.url + separator + 'access_token=' + accessToken;
    }

    // 外部 URL：直接使用
    return song.url || '';
  }

  /**
   * 构造封面URL
   * - 封面路径不为空时：{serverHost}/cover/{base62EncodedPath}{ext}?access_token={token}
   */
  static buildCoverURL(coverPath: string): string {
    if (!coverPath) {
      return '';
    }

    const serverHost = getHostBaseUrl();
    const accessToken = mimusic.plugin.getToken();
    const pathWithoutExt = getPathWithoutExtension(coverPath);
    const ext = getExtension(coverPath);
    const encodedPath = encodeBase62(pathWithoutExt);
    return serverHost + '/cover/' + encodedPath + ext + '?access_token=' + accessToken;
  }
}

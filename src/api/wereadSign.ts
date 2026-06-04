/**
 * 微信读书 web 端章节接口（/web/book/chapter/e_0..e_3, t_0..t_1）的请求 payload 签名工具。
 *
 * 本文件实现完全参考社区开源项目 touchFish 中的同名算法：
 *   https://github.com/ylw1997/touchFish/blob/main/src/api/weread/utils/index.ts
 *
 * 算法链路:
 *   1. calcHash(data)  → 对 bookId / chapterUid 做混淆 hash, 得到形如 "ccd329307a..." 的字符串
 *   2. sign(payload)   → 对完整 payload(不含 s 字段) 做 _stringify(按 key 排序+URLEncode) → _sign(异或哈希)
 *   3. 服务端用同样算法校验后返回章节内容
 *
 * 不要修改这些常量或排序方式, 否则签名会失败导致 -2000 / 400 等错误。
 */

import * as crypto from 'crypto';

function md5(raw: string): string {
  return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * 根据 User-Agent 字符串派生 appId, 微信读书会在某些接口校验该字段。
 */
export function getAppId(ua: string): string {
  let rnd1 = '';
  const uaParts = ua.split(' ');
  const uaPartCount = Math.min(uaParts.length, 12);
  for (let i = 0; i < uaPartCount; i++) {
    rnd1 += uaParts[i].length % 10;
  }

  let rnd2 = ((s: string): string => {
    let num = 0;
    for (let i = 0; i < s.length; i++) {
      num = (131 * num + s.charCodeAt(i)) & 0x7fffffff;
    }
    return num.toString();
  })(ua);
  if (rnd2.length > 16) {
    rnd2 = rnd2.slice(0, 16);
  }
  return 'wb' + rnd1 + 'h' + rnd2;
}

/** 当前 Unix 时间(秒) */
export function currentTime(): number {
  return Math.floor(Date.now() / 1000);
}

/** 当前 Unix 时间(毫秒) */
export function timestamp(): number {
  return Date.now();
}

/**
 * 内部签名核心：对拼接好的字符串做异或式哈希, 输出 16 进制串。
 * 与 touchFish 中 `_sign` 完全一致, 不可修改。
 */
function _sign(data: string): string {
  let n1 = 0x15051505;
  let n2 = 0x15051505;
  const strlen = data.length;
  for (let i = strlen - 1; i > 0; i -= 2) {
    n1 = 0x7fffffff & (n1 ^ (data.charCodeAt(i) << (strlen - i) % 30));
    n2 = 0x7fffffff & (n2 ^ (data.charCodeAt(i - 1) << i % 30));
  }
  return (n1 + n2).toString(16).toLowerCase();
}

/**
 * 把 payload 序列化为待签名字符串：按 key 字典序排序, 每个值 encodeURIComponent, 用 & 连接。
 * 注意：调用时 payload 不应包含 s 字段(签名结果将放入 s)。
 */
function _stringify(data: Record<string, unknown>, keys: string[] = []): string {
  let result = '';
  const all = keys.length === 0;
  const objKeys = Object.keys(data).sort();
  for (let i = 0; i < objKeys.length; i++) {
    const key = objKeys[i];
    if (all || keys.indexOf(key) !== -1) {
      const value = data[key];
      result += key + '=' + encodeURIComponent(String(value));
      result += '&';
    }
  }
  if (result.length > 0 && result.charAt(result.length - 1) === '&') {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * 对 payload 求签名(用于章节内容接口 `s` 字段)。
 */
export function sign(payload: Record<string, unknown>): string {
  return _sign(_stringify(payload));
}

/**
 * 对 bookId / chapterUid 等输入做混淆 hash, 输出形如 "ccd329307a19e58fg013ab0xxx" 的字符串。
 * 算法链路:
 *   - 计算 md5(data) 取前 3 位 + 类型位 + 长度位
 *   - 数字会按每 9 位切分转为 16 进制
 *   - 其他字符串直接逐字符 charCode.toString(16)
 *   - 最后追加 md5 校验位
 */
export function calcHash(input: string | number): string {
  let data: string;
  if (typeof input === 'number') {
    data = input.toString();
  } else if (typeof input === 'string') {
    data = input;
  } else {
    // 与 touchFish 行为一致：非字符串/数字直接原样返回
    return input as unknown as string;
  }

  const dataMd5 = md5(data);
  let head = dataMd5.substr(0, 3); // 3 位
  const segmented = ((s: string): [string, string[]] => {
    if (/^\d*$/.test(s)) {
      const len = s.length;
      const chunks: string[] = [];
      for (let i = 0; i < len; i += 9) {
        const sub = s.slice(i, Math.min(i + 9, len));
        chunks.push(parseInt(sub, 10).toString(16));
      }
      return ['3', chunks];
    }
    let hex = '';
    for (let i = 0; i < s.length; i++) {
      hex += s.charCodeAt(i).toString(16);
    }
    return ['4', [hex]];
  })(data);

  head += segmented[0]; // 4 位
  head += 2 + dataMd5.substr(dataMd5.length - 2, 2); // 7 位

  const parts = segmented[1];
  for (let i = 0; i < parts.length; i++) {
    let lenHex = parts[i].length.toString(16);
    if (lenHex.length === 1) {
      lenHex = '0' + lenHex;
    }
    head += lenHex;
    head += parts[i];
    if (i < parts.length - 1) {
      head += 'g';
    }
  }

  if (head.length < 20) {
    head += dataMd5.substr(0, 20 - head.length);
  }

  return head + md5(head).substr(0, 3);
}

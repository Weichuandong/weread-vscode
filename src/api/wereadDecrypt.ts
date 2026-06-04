/**
 * 微信读书章节内容(分片)解密。
 *
 * 参考实现: https://github.com/ylw1997/touchFish/blob/main/src/api/weread/utils/decrypt.ts
 *
 * 接口返回数据格式:
 *   - 前 32 字节: body 的 md5(大写 hex)
 *   - 后续:       加密 body
 *
 * 解密步骤:
 *   1. chk(raw)            → 校验 md5, 不通过返回空串
 *   2. decrypt(body)       → 去首字符 + 位置数组两两交换 + base64 解码
 *   3. epub 路径需要对 e_0/e_1/e_3 拼接后再解密一次, e_2 是 style; txt 路径合并 t_0/t_1。
 */

function base64Decode(input: string): string {
  return Buffer.from(input, 'base64').toString('utf-8');
}

import * as crypto from 'crypto';
function md5(raw: string): string {
  return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * 内部位置打乱算法的核心解密函数。
 * 切勿改动任何整型常量或循环边界, 与服务端协议绑定。
 */
function decryptInternal(data: string): string {
  if (!data || typeof data !== 'string' || data.length <= 1) {
    return '';
  }
  // 去掉首字符(占位)
  let result = data.slice(1);

  // —— 算出 10 个交换位置索引 ——
  const positions: number[] = (() => {
    const out: number[] = [];
    const len = result.length;
    if (len < 4) return out;
    if (len < 11) return [0, 2];

    const take = Math.min(4, Math.ceil(len / 10));
    let bits = '';
    for (let i = len - 1; i > len - 1 - take; i--) {
      const code = result.charCodeAt(i);
      bits += parseInt(code.toString(2), 4);
    }

    const mod = len - take - 2;
    const width = mod.toString().length;
    for (let i = 0; out.length < 10 && i + width < bits.length; i += width) {
      let v = parseInt(bits.slice(i, i + width), 10);
      out.push(v % mod);
      v = parseInt(bits.slice(i + 1, i + 1 + width), 10);
      out.push(v % mod);
    }
    return out;
  })();

  // —— 按位置数组对字符串字符两两交换 ——
  const chars = result.split('');
  for (let i = positions.length - 1; i >= 0; i -= 2) {
    for (let j = 1; j >= 0; j--) {
      const tmp = chars[positions[i] + j];
      chars[positions[i] + j] = chars[positions[i - 1] + j];
      chars[positions[i - 1] + j] = tmp;
    }
  }
  result = chars.join('');

  // —— 最终 base64 解码得到明文(HTML / CSS / TXT) ——
  return base64Decode(result);
}

/**
 * 校验接口响应: 前 32 字符是 body 的 MD5(大写), 校验通过则返回 body, 否则返回空串。
 */
export function chk(data: string): string {
  if (!data || data.length <= 32) {
    return data ?? '';
  }
  const header = data.slice(0, 32);
  const body = data.slice(32);
  return header === md5(body).toUpperCase() ? body : '';
}

/** epub 正文分片解密(e_0 / e_1 / e_3 拼接后调用) */
export function dH(data: string): string {
  return data && data.length !== 0 ? decryptInternal(data) : '';
}

/** epub 样式分片解密(e_2) */
export function dS(data: string): string {
  return data && data.length !== 0 ? decryptInternal(data) : '';
}

/** txt 正文分片解密(t_0 / t_1 拼接后调用) */
export function dT(data: string): string {
  return data && data.length !== 0 ? decryptInternal(data) : '';
}

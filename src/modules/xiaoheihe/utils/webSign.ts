/**
 * 小黑盒 (heybox) **web 端** API 的请求签名工具.
 *
 * ## 算法来源
 *
 * 直接从 https://www.xiaoheihe.cn 当前线上 Nuxt bundle (`c2sykE0H.js`, 2.5.6 版本)
 * 里逆向得到的 `ov` 函数. 入口是 `vv(path)` → `lv["g"](path, ts, nonce)`
 * → `ov(path, ts + 1, nonce)`. 跟原 https://github.com/huandu/heybox-url 完全不同
 * (huandu 实现已被作者归档 "Deprecated, doesn't work with latest Heybox API",
 * 我们 v2.2.4 实测确认 huandu 算法已被服务端废弃).
 *
 * ## 签名公式 (web 端)
 *
 *     const ts        = timestamp + 1                              // 注意 +1, 对齐 lv["g"]
 *     const u         = '/' + path.split('/').filter(Boolean).join('/') + '/'
 *     const tsMapped  = av(String(ts), DICT, -2)                   // 用 DICT[0..-2] 字符集映射
 *     const uMapped   = sv(u, DICT)                                // 用全 DICT 字符集映射
 *     const nMapped   = sv(nonce, DICT)                            // 同上
 *     const interleaved = 把 [tsMapped, uMapped, nMapped] 按字符位置轮流拼接
 *     const seed      = interleaved.slice(0, 20)
 *     const o         = md5(seed).hex.lower                        // 32 hex 字符
 *     const key5      = av(o.slice(0, 5), DICT, -4)                // 用 DICT[0..-4] 映射前 5 hex
 *     const tail6     = o.slice(-6) 的 charCode 数组 (长度 6)
 *     Km(tail6)                                                    // 原地改 tail6[0..3], 保留 tail6[4..5]
 *     const sum2      = (tail6[0]+...+tail6[5]) % 100 padStart 2 '0'
 *     hkey            = key5 + sum2                                // 5 + 2 = 7 位
 *
 * ## 关键参数
 *
 *   - path:      待签名 API 路径. 函数内部会做规范化 ('/foo/bar' / 'foo/bar' / '/foo/bar/'
 *                都规范成 '/foo/bar/'), 跟服务端的规范化对齐.
 *   - timestamp: 秒级 unix 时间戳, 跟请求 query 里的 `_time` 必须一致 (注意 `_time`
 *                用的是原始 timestamp, 不是 +1 后的 ts; 服务端验签时自己会 +1).
 *   - nonce:     32 位大写 hex 字符串 (推荐用 `generateWebNonce()` 函数,
 *                跟浏览器抓包行为一致).
 *
 * ## 跟 APP 端 sign.ts 的 computeHkey 区别
 *
 *   - 输出格式: APP 8 位大写 hex (CRC32) vs. web 7 位 dict+数字 ([A-Z0-9])
 *   - 依赖参数: APP 需要 imei 维度的 debugInfo, web 不需要任何设备维度参数
 *   - 不依赖 cookie / device_id / pkey, 纯函数, 可任意预计算
 *
 * ## 实测向量 (浏览器抓包)
 *
 *     path  = '/bbs/app/feeds'
 *     ts    = 1781158991 (请求 query 里的 _time)
 *     nonce = '101F2D929768C6D3CA3F9AAB70332805'
 *     hkey  = '7IVTZ50'   ← 内部用 ts + 1 = 1781158992 计算
 *
 * ## Km 关键细节 (别踩坑)
 *
 * AES MixColumns 矩阵 Km 把输入数组前 4 字节就地替换成新的 4 字节,
 * **但函数返回的是原数组本身, 长度不变**. 后续 reduce 求和时是对全部 6 个元素累加
 * (前 4 是 MixColumns 输出, 后 2 是 md5 hex 字符的原 charCode), 不是只对前 4 求和.
 * 这是 v2.2.x 调试时发现的"反直觉"细节, 实测必须按此实现才能跟服务端对齐.
 *
 * 不引入任何第三方依赖, 只用 Node 内置 crypto.createHash('md5').
 */
import { createHash, randomBytes } from 'crypto';

/**
 * 生成 web 端 hkey 算法配套的 nonce — **32 位大写 hex 字符串**.
 *
 * 跟 APP 端 `generateNonce` ('6ELSZjqx' 字符集) 区分:
 *   - APP 协议: 服务端只校验长度+是字符串, 任意字符集都行
 *   - web 协议: 浏览器抓包 (https://www.xiaoheihe.cn) 实测 nonce 全是 32 位大写 hex,
 *     服务端除了 hkey 数学验签外还会做 nonce **格式正则校验** —— 用错字符集会被
 *     服务端判 "非法请求". v2.2.4 首发版踩过坑: 错把 sign.ts 的 generateNonce 复用
 *     给 web 分支, hkey 数学完全正确但服务端仍打回, 切换到本函数后恢复正常.
 *
 * @param byteCount 字节数, 默认 16 (输出 32 hex 字符), 跟浏览器抓包一致.
 *                  不要调小, 服务端可能也卡长度.
 * @returns 大写 hex 字符串, 长度 = byteCount * 2.
 */
export function generateWebNonce(byteCount = 16): string {
  return randomBytes(byteCount).toString('hex').toUpperCase();
}

/**
 * 35 字符 DICT. 是 web 端 ov 算法的核心字符集, 输出 hkey 的前 5 位字符全部从这里取.
 * 顺序非常重要 (av/sv 用 charCode % len 索引取字符), 不要改.
 */
const DICT = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';

function md5Hex(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

/**
 * `av(e, t, n)`: 用 DICT **切片** `t.slice(0, n)` 作为字符集, 把 e 的每个字符按
 * `dict[ e.charCodeAt(i) % dict.length ]` 映射成新字符. n 可以是负数 (JS slice 语义,
 * 表示去尾 |n| 个字符). 出现在 ov 里两处:
 *   - `av(String(ts), DICT, -2)`  → DICT 前 33 字符
 *   - `av(md5Hex.slice(0,5), DICT, -4)` → DICT 前 31 字符
 */
function av(e: string, t: string, n: number): string {
  const dict = t.slice(0, n);
  let r = '';
  for (let o = 0; o < e.length; o++) {
    r += dict.charAt(e.charCodeAt(o) % dict.length);
  }
  return r;
}

/**
 * `sv(e, t)`: 同 av 但用全字典 t. 出现在 ov 里两处:
 *   - `sv(path, DICT)`
 *   - `sv(nonce, DICT)`
 */
function sv(e: string, t: string): string {
  let r = '';
  for (let o = 0; o < e.length; o++) {
    r += t.charAt(e.charCodeAt(o) % t.length);
  }
  return r;
}

/**
 * 把 N 个字符串按"轮流取字符"方式交错合并:
 *   interleave(["abcd", "12", "XYZ"]) = "a1Xb2YcZd"
 * 即第 0 轮取每串第 0 字符 (跳过超长的), 第 1 轮取每串第 1 字符, ...
 */
function interleave(parts: string[]): string {
  const maxLen = parts.reduce((m, p) => (p.length > m ? p.length : m), 0);
  let out = '';
  for (let r = 0; r < maxLen; r++) {
    for (const p of parts) {
      if (r < p.length) out += p[r];
    }
  }
  return out;
}

// --- AES MixColumns 风格的 checksum 子算法 ---
// 跟 huandu 老算法里的 c0/c1/c2/c3 同源 (GF(2^8) 乘 ×2 ×3 ×9 ...), 只是这里改成
// 直接复用源码命名: convertByte → Vm, c3 → qm, c2 → $m, c1 → Ym, c0 → Gm.
function convertByte(v: number): number {
  return v & 0x80 ? 0xff & ((v << 1) ^ 0x1b) : v << 1;
}
function qm(v: number): number {
  return convertByte(v) ^ v;
}
function $m(v: number): number {
  return qm(convertByte(v));
}
function Ym(v: number): number {
  return $m(qm(convertByte(v)));
}
function Gm(v: number): number {
  return Ym(v) ^ $m(v) ^ qm(v);
}

/**
 * 标准 AES MixColumns 矩阵作用到 e[0..3] 上, **就地改写 e 的前 4 字节为输出值**.
 * 后续 e[4..] 保持原值. 返回的就是原数组本身. 这个原地改写 + 跨全长 reduce 是
 * 服务端跟客户端约定的关键细节, 别图简单写成"返回 4 元素新数组".
 */
function Km(e: number[]): number[] {
  const t0 = Gm(e[0]) ^ Ym(e[1]) ^ $m(e[2]) ^ qm(e[3]);
  const t1 = qm(e[0]) ^ Gm(e[1]) ^ Ym(e[2]) ^ $m(e[3]);
  const t2 = $m(e[0]) ^ qm(e[1]) ^ Gm(e[2]) ^ Ym(e[3]);
  const t3 = Ym(e[0]) ^ $m(e[1]) ^ qm(e[2]) ^ Gm(e[3]);
  e[0] = t0;
  e[1] = t1;
  e[2] = t2;
  e[3] = t3;
  return e;
}

/**
 * 把 path 规范化成 '/segA/segB/' 形态. 处理掉:
 *   - 前后多余的 '/'
 *   - 任意 query 部分 ('?...' 直接丢)
 *   - 连续 '/'
 *
 * 跟服务端 web 端 hkey 校验对齐. 调用方传 '/bbs/app/feeds' 或 'bbs/app/feeds/' 都行.
 */
function normalizePath(path: string): string {
  const noQuery = path.split('?')[0] || '';
  const segs = noQuery.split('/').filter((t) => t);
  return '/' + segs.join('/') + '/';
}

/**
 * 计算 web 端 hkey.
 *
 * @param path      API 路径 (不含 query), 形如 '/bbs/app/feeds' (前后是否带 '/' 无所谓).
 * @param timestamp 秒级 unix 时间戳, 跟请求 query 里的 `_time` 必须一致. 函数内部会 +1
 *                  跟服务端算法对齐 (调用方不要预先 +1).
 * @param nonce     32 位大写 hex 字符串 (用 `generateWebNonce()` 生成).
 * @returns 7 位字符串 (5 位 DICT 字符 + 2 位十进制 checksum).
 */
export function computeWebHkey(
  path: string,
  timestamp: number,
  nonce: string,
): string {
  // 对齐 lv["g"]: ts = 入参 timestamp + 1.
  //   猜测是早期防"时间戳重放"的小防御 (request._time 是 t, 但签名用 t+1).
  const ts = timestamp + 1;
  const u = normalizePath(path);

  // 三个 part 分别用不同方式映射成 DICT 字符串:
  //   - ts: av 用 DICT 前 33 字符
  //   - path / nonce: sv 用全 DICT (35 字符)
  // 然后交错合并取前 20 字符作为 md5 输入.
  const seed = interleave([
    av(String(ts), DICT, -2),
    sv(u, DICT),
    sv(nonce, DICT),
  ]).slice(0, 20);
  const o = md5Hex(seed); // 32 hex 小写

  // 前 5 位: md5 前 5 字符再过 av (DICT 前 31 字符) 映射成 DICT 字符.
  const key5 = av(o.substring(0, 5), DICT, -4);

  // 后 2 位 checksum: md5 后 6 字符 → charCode → Km 原地改前 4 字节 → reduce 全 6 字节 → % 100.
  const tail6 = o.slice(-6).split('').map((ch) => ch.charCodeAt(0));
  Km(tail6); // 原地改 tail6[0..3], 保留 tail6[4..5]
  const sumMod = (tail6[0] + tail6[1] + tail6[2] + tail6[3] + tail6[4] + tail6[5]) % 100;
  const suffix = sumMod < 10 ? '0' + sumMod : String(sumMod);

  return key5 + suffix; // 7 位
}

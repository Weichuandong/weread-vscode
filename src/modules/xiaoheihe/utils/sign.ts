/**
 * 小黑盒 (heybox/MAX+) APP API 的请求签名工具.
 *
 * 算法来源: 社区逆向 (参考 https://github.com/AShujiao/vscode-maxPlus, 原始算法
 * 出自 xiaoheihe-bot 等开源项目). 自 2026 年初起 /bbs/app/feeds/news 这条 endpoint
 * 强制校验 hkey + nonce, 不带签名直接返回 "请升级版本".
 *
 * 签名公式 (固定模式):
 *
 *      data = `${path}/${timestamp}${imei}-1`
 *      hkey = CRC32( HMAC_SHA512(HMAC_KEY, data) ).toString(16).padStart(8,'0').toUpperCase()
 *
 * 其中:
 *   - path:      待签 API 路径, 必须以 '/' 结尾 (signPath)
 *   - timestamp: 秒级 unix 时间戳 (跟请求里的 _time 必须一致)
 *   - imei:      设备伪 imei, 任意 16 hex 即可 (我们写死跟参考实现一致, 服务端不会做反查)
 *   - HMAC_KEY:  下面 IBM 大写常量, 抓 APK so 拿到, 之前一直没变过
 *
 * 注意:
 *   - 任何一个字段对不上 (path 没结尾 '/'、ts 和 _time 不一致、imei 改了但 debugInfo 没跟着改),
 *     服务端就会返回 error.msg = '签名错误'. 出问题先打印这三个值对照.
 *   - 算法本身不依赖任何外部包, 只用 Node 内置 crypto, 没新增依赖.
 */
import * as crypto from 'crypto';

/** 抓 APK 拿到的 HMAC key, 公开算法的固定常量 */
const HMAC_KEY = Buffer.from('LFEJGJJOKCEHODNMNFIKKONFBKIHJFKB', 'utf-8');

/** nonce 字符集 — 跟参考实现保持一致, 服务端只校验长度+是字符串, 字符集随意 */
const NONCE_CHARS = '6ELSZjqx';

/** 生成 32 位随机 nonce (字符集见 NONCE_CHARS) */
export function generateNonce(length = 32): string {
  let nonce = '';
  for (let i = 0; i < length; i++) {
    nonce += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
  }
  return nonce;
}

/**
 * 标准 CRC32 (多项式 0xEDB88320, 初始 0xFFFFFFFF, 末尾取反).
 *
 * 不用 Node 自带 zlib.crc32 是因为它从 Node 18 才稳, 早期版本走 polyfill,
 * 跟我们 engines.node >= 18 一致, 但手写一份省去版本差异排查; 输入很小 (HMAC
 * 摘要 64 字节), 性能完全够.
 */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = crc ^ buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  // 末尾取反并截到无符号 32 位
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 计算 hkey 签名.
 *
 * @param path      API 路径 (无 query). 函数内部会保证以 '/' 结尾, 调用方传不传无所谓
 * @param timestamp 秒级 unix 时间戳, 必须跟请求 query 里的 _time 一致
 * @param debugInfo 形如 `${imei}-1` 的字符串, imei 与请求 query 里的 imei 字段一致
 * @returns 8 位大写十六进制字符串
 */
export function computeHkey(path: string, timestamp: number, debugInfo: string): string {
  const signPath = path.endsWith('/') ? path : path + '/';
  const data = `${signPath}${timestamp}${debugInfo}`;
  const hmac = crypto.createHmac('sha512', HMAC_KEY);
  hmac.update(data);
  const hashBytes = hmac.digest();
  const crc = crc32(hashBytes);
  const hex = crc.toString(16).toUpperCase();
  return hex.length < 8 ? '0'.repeat(8 - hex.length) + hex : hex;
}

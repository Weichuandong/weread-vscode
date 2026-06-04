import { createHash } from 'crypto';

/**
 * 微信读书 reader URL 计算工具。
 *
 * 微信读书的网页阅读器 URL 形如 `https://weread.qq.com/web/reader/{strId}`，
 * 其中 `strId` 是 bookId 经过特定算法（MD5 + 16 进制变换）计算得到的指纹，
 * 该算法在社区开源项目中已被广泛使用（属于公开已知逻辑）。
 *
 * 仅用于生成跳转链接，方便用户在浏览器中打开对应书籍/章节，不涉及内容解密。
 */

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/** 将 bookId 拆分为 9 位段并转 16 进制；非纯数字则按字符码转 16 进制 */
function transformId(bookId: string): { code: string; parts: string[] } {
  const id = Number(bookId);
  if (Number.isFinite(id) && Number.isInteger(id) && /^\d+$/.test(bookId)) {
    const parts: string[] = [];
    for (let i = 0; i < bookId.length; i += 9) {
      const segment = bookId.slice(i, i + 9);
      parts.push(parseInt(segment, 10).toString(16));
    }
    return { code: '3', parts };
  }
  let hex = '';
  for (let i = 0; i < bookId.length; i++) {
    hex += bookId.charCodeAt(i).toString(16);
  }
  return { code: '4', parts: [hex] };
}

/** 计算 bookId 对应的 reader strId */
export function calcBookStrId(bookId: string): string {
  const digest = md5(bookId);
  let result = digest.substring(0, 3);
  const { code, parts } = transformId(bookId);
  result += code + '2' + digest.substring(digest.length - 2);

  for (let i = 0; i < parts.length; i++) {
    let lenHex = parts[i].length.toString(16);
    if (lenHex.length === 1) {
      lenHex = '0' + lenHex;
    }
    result += lenHex + parts[i];
    if (i < parts.length - 1) {
      result += 'g';
    }
  }
  if (result.length < 20) {
    result += digest.substring(0, 20 - result.length);
  }
  result += md5(result).substring(0, 3);
  return result;
}

/** 拼接书籍在网页端的阅读器 URL */
export function getBookReaderUrl(bookId: string): string {
  return `https://weread.qq.com/web/reader/${calcBookStrId(bookId)}`;
}

/** 拼接指定章节在网页端的 URL（k 段为章节 uid 的 16 进制编码） */
export function getChapterReaderUrl(bookId: string, chapterUid: number | string): string {
  const base = calcBookStrId(bookId);
  // 章节锚点：k{16进制章节uid长度}{16进制章节uid}
  const uidStr = String(chapterUid);
  let lenHex = uidStr.length.toString(16);
  if (lenHex.length === 1) {
    lenHex = '0' + lenHex;
  }
  let uidHex = '';
  for (let i = 0; i < uidStr.length; i++) {
    uidHex += uidStr.charCodeAt(i).toString(16);
  }
  return `https://weread.qq.com/web/reader/${base}k${lenHex}${uidHex}`;
}

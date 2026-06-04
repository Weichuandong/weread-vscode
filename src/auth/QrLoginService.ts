import axios from 'axios';

/**
 * 微信读书扫码登录。
 *
 * 流程沿用微信开放平台 OAuth + 长轮询协议:
 *   1) GET open.weixin.qq.com/connect/qrconnect    → 拿到 uuid
 *   2) GET open.weixin.qq.com/connect/qrcode/{uuid} → 拿到二维码图片(PNG)
 *   3) GET lp.open.weixin.qq.com/connect/l/qrconnect?uuid=... (长轮询, ~25-30s)
 *      返回 JS 字符串如: window.wx_errcode=405;window.wx_code='XXX';
 *      码值含义:
 *        408 等待扫码
 *        404 已扫码, 等待手机确认
 *        405 已确认 → 取 wx_code 即为 OAuth code
 *        402 二维码过期
 *        403 已拒绝/取消
 *   4) GET weread.qq.com/login/weixinCallback?code=...&state=...
 *      自己跟随 301/302, 收集所有 Set-Cookie, 拼接成 Cookie header
 *
 * 关键设计:
 *   - 全程"事件流"对外暴露(start() 后通过 onEvent 监听), UI 层只关心
 *     status + qrImageDataUrl + message, 不关心底层协议细节。
 *   - cancel() 可以中途取消, 立即停止轮询。
 *   - axios 各处都设了 UA + Referer, 模拟浏览器请求, 减少被风控的概率。
 */

const APP_ID = 'wx4f2487acefb2dd2c';
const REDIRECT_URI = 'https://weread.qq.com/login/weixinCallback';
const STATE = 'weread';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type QrStatus =
  | 'init' // 正在拉二维码
  | 'waiting' // 等待手机扫码
  | 'scanned' // 已扫码, 等待手机确认
  | 'confirmed' // 已确认, 正在交换 cookie
  | 'success' // 整个流程完成, cookieHeader 可用
  | 'expired' // 二维码过期
  | 'cancelled' // 用户取消
  | 'failed'; // 失败

export interface QrEvent {
  status: QrStatus;
  /** 仅 status='waiting'/'scanned'/'confirmed' 时携带 */
  qrImageDataUrl?: string;
  message?: string;
  /** 仅 status='success' 时存在 */
  cookieHeader?: string;
}

type Listener = (e: QrEvent) => void;

interface PollResult {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'cancelled';
  code?: string;
}

/**
 * 微信开放平台错误页/部分页面是 GBK 编码, axios 默认按 utf-8 解会乱码,
 * 我们先按 utf-8 试, 看到乱码再用 Node 内置 TextDecoder('gbk') 二次解。
 */
function decodeBody(buf: ArrayBuffer | Buffer): string {
  const u8 = Buffer.isBuffer(buf) ? new Uint8Array(buf) : new Uint8Array(buf);
  // utf-8 是默认大部分场景, 先试
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  if (!/\uFFFD/.test(utf8)) return utf8;
  try {
    return new TextDecoder('gbk' as any).decode(u8);
  } catch {
    return utf8;
  }
}

export class QrLoginSession {
  private cancelled = false;
  private listeners: Listener[] = [];
  private lastQr: string | undefined;

  public onEvent(listener: Listener): { dispose: () => void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }

  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emit({ status: 'cancelled', message: '已取消' });
  }

  private emit(e: QrEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  /** 串起整个 OAuth 流程, 失败会发出 'failed' 事件 */
  public async start(): Promise<void> {
    try {
      this.emit({ status: 'init', message: '正在生成二维码…' });

      const uuid = await this.fetchUuid();
      const qrDataUrl = await this.fetchQrImage(uuid);
      this.lastQr = qrDataUrl;
      if (this.cancelled) return;
      this.emit({ status: 'waiting', qrImageDataUrl: qrDataUrl, message: '请使用微信「扫一扫」' });

      let code: string | undefined;
      while (!this.cancelled) {
        const result = await this.pollOnce(uuid);
        if (this.cancelled) return;
        switch (result.status) {
          case 'waiting':
            break;
          case 'scanned':
            this.emit({
              status: 'scanned',
              qrImageDataUrl: this.lastQr,
              message: '已扫描, 请在手机上点击确认',
            });
            break;
          case 'confirmed':
            code = result.code;
            this.emit({ status: 'confirmed', message: '正在登录…' });
            break;
          case 'expired':
            this.emit({ status: 'expired', message: '二维码已过期, 请重试' });
            return;
          case 'cancelled':
            this.emit({ status: 'cancelled', message: '已在手机上取消' });
            return;
        }
        if (code) break;
      }
      if (!code || this.cancelled) return;

      const cookie = await this.exchangeCodeForCookies(code);
      if (this.cancelled) return;
      if (!cookie) {
        this.emit({ status: 'failed', message: '登录失败: 未能获取 Cookie' });
        return;
      }
      this.emit({ status: 'success', cookieHeader: cookie, message: '登录成功' });
    } catch (e) {
      if (this.cancelled) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.emit({ status: 'failed', message: `登录失败: ${msg}` });
    }
  }

  // ---------------- 内部步骤 ----------------

  private async fetchUuid(): Promise<string> {
    // 主接口: 标准 OAuth qrconnect 页, 返回 HTML, uuid 内嵌
    const mainUrl =
      `https://open.weixin.qq.com/connect/qrconnect?` +
      `appid=${APP_ID}` +
      `&scope=snsapi_login` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${STATE}` +
      `&login_type=jssdk&self_redirect=default`;
    const baseHeaders = {
      'User-Agent': UA,
      Referer: 'https://weread.qq.com/',
      Origin: 'https://weread.qq.com',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      'Sec-Ch-Ua':
        '"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    } as const;

    let html = '';
    let status: number | undefined;
    try {
      const res = await axios.get(mainUrl, {
        headers: baseHeaders,
        timeout: 15000,
        // 微信错误页是 GBK, 我们手动按二进制取再尝试 utf-8/gbk 双解
        responseType: 'arraybuffer',
      });
      status = res.status;
      html = decodeBody(res.data);
    } catch (e) {
      // 主接口异常也不能立刻挂, 还有 jssdk 兜底
      // eslint-disable-next-line no-console
      console.warn('[weread][qrLogin] fetchUuid main url failed:', e);
    }

    // 提早识别 wechat 风控错误页, 抛带 code 的错误供 UI 走 fallback
    if (/出错|抱歉|系统繁忙|页面跑丢|illegal/i.test(html)) {
      const err = new Error(
        '微信开放平台拒绝了请求(返回错误页), 可能是 appid/redirect_uri 未授权或被风控。建议改用「浏览器登录助手」。',
      ) as Error & { code?: string };
      err.code = 'WX_REJECTED';
      throw err;
    }

    // 第一轮: 在主接口 HTML 里找
    const uuid = QrLoginSession.extractUuid(html);
    if (uuid) return uuid;

    // 第二轮: jssdk 的 qrcode/uuid 接口 (返回 JSONP/JSON)
    try {
      const cb = `wxLogin_${Date.now()}`;
      const jssdkUrl =
        `https://open.weixin.qq.com/connect/jssdk/qrcode/uuid?` +
        `appid=${APP_ID}` +
        `&scope=snsapi_login` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&state=${STATE}` +
        `&callback=${cb}`;
      const res2 = await axios.get(jssdkUrl, {
        headers: { ...baseHeaders, Referer: 'https://open.weixin.qq.com/' },
        timeout: 15000,
      });
      const body = String(res2.data ?? '');
      const u2 = QrLoginSession.extractUuid(body);
      if (u2) return u2;
      // 也可能是裸 JSON
      try {
        const json = typeof res2.data === 'object' ? res2.data : JSON.parse(body);
        if (json && typeof json.uuid === 'string') return json.uuid;
      } catch {
        /* not json */
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[weread][qrLogin] fetchUuid jssdk fallback failed:', e);
    }

    // 全军覆没: 把响应快照塞进错误, 方便排查
    const preview = (html || '').replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(
      `未能从微信页面提取 uuid (status=${status ?? 'n/a'}, body[0..240]=${preview || '空'})`,
    );
  }

  /** 从一段文本里尝试用各种 pattern 抠出 uuid */
  private static extractUuid(text: string): string | undefined {
    if (!text) return undefined;
    const patterns = [
      // {"uuid":"xxx"} / uuid: "xxx" / uuid='xxx'
      /['"]?uuid['"]?\s*[:=]\s*['"]([a-zA-Z0-9_-]{6,})['"]/i,
      // data-uuid="xxx"
      /data-uuid\s*=\s*['"]([a-zA-Z0-9_-]{6,})['"]/i,
      // .../connect/qrcode/<uuid> (img.src 或 a.href)
      /\/connect\/qrcode\/([a-zA-Z0-9_-]{6,})/,
      // qrconnect?uuid=xxx 之类查询串
      /[?&]uuid=([a-zA-Z0-9_-]{6,})/,
      // JSONP: wxLogin_123({"uuid":"xxx",...})
      /\{\s*"uuid"\s*:\s*"([a-zA-Z0-9_-]{6,})"/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m?.[1]) return m[1];
    }
    return undefined;
  }

  private async fetchQrImage(uuid: string): Promise<string> {
    const url = `https://open.weixin.qq.com/connect/qrcode/${uuid}`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/' },
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    const base64 = Buffer.from(res.data).toString('base64');
    return `data:image/png;base64,${base64}`;
  }

  private async pollOnce(uuid: string): Promise<PollResult> {
    const ts = Date.now();
    const url = `https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}&_=${ts}`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/' },
      // 微信长轮询默认在 25-30s 内返回, timeout 设大些
      timeout: 45000,
    });
    const body = String(res.data ?? '');
    const errMatch = body.match(/wx_errcode\s*=\s*(\d+)/);
    const codeMatch = body.match(/wx_code\s*=\s*['"]([^'"]*)['"]/);
    const errcode = errMatch ? Number(errMatch[1]) : -1;
    const code = codeMatch ? codeMatch[1] : undefined;
    switch (errcode) {
      case 408:
        return { status: 'waiting' };
      case 404:
        return { status: 'scanned' };
      case 405:
        return { status: 'confirmed', code };
      case 402:
        return { status: 'expired' };
      case 403:
        return { status: 'cancelled' };
      default:
        return { status: 'waiting' };
    }
  }

  /**
   * 拿 OAuth code 去换 weread 的 cookie。
   * weread 的 callback 通常会 302 跳到首页, 我们手动 follow 多次,
   * 把所有 Set-Cookie 收集起来拼成 "k1=v1; k2=v2" 形式。
   */
  private async exchangeCodeForCookies(code: string): Promise<string> {
    let url = `${REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${STATE}`;
    const jar = new Map<string, string>();
    const cookieHeader = () =>
      [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

    for (let hop = 0; hop < 8; hop++) {
      const res = await axios.get(url, {
        headers: {
          'User-Agent': UA,
          Referer: 'https://open.weixin.qq.com/',
          ...(jar.size > 0 ? { Cookie: cookieHeader() } : {}),
        },
        maxRedirects: 0,
        validateStatus: (s) => (s >= 200 && s < 400) || s === 302 || s === 301,
        timeout: 15000,
      });

      const setCookies: string[] = ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) || []);
      for (const sc of setCookies) {
        const first = sc.split(';')[0];
        const idx = first.indexOf('=');
        if (idx > 0) {
          jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
        }
      }

      if (res.status === 301 || res.status === 302) {
        const loc = res.headers.location;
        if (!loc) break;
        url = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        continue;
      }
      break;
    }

    // 必备字段校验: weread cookies 至少应该有 wr_vid 或 wr_skey
    if (!jar.has('wr_vid') && !jar.has('wr_skey')) {
      throw new Error('回调未返回 wr_vid/wr_skey, 登录未生效');
    }
    return cookieHeader();
  }
}

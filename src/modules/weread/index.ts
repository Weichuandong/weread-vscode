import * as vscode from 'vscode';
import type { Module } from '../../core/Module';
import { AuthService } from './auth/AuthService';
import { WereadClient } from './api/WereadClient';
import { MainViewProvider } from './views/MainViewProvider';
import { WereadBook } from './types';
import { getBookReaderUrl } from './api/wereadUrl';
import { checkForUpdates } from './services/UpdateChecker';

/**
 * 微信读书模块。
 *
 * 历史: 这段 activate 主体 v1.0.3 之前直接写在 src/extension.ts 里,
 * 后来把插件改造成 "多模块" 框架, 微信读书降级为众多模块之一,
 * 整段 activate 原样搬到这里。为了保证老用户升级后行为完全一致:
 *
 *   1. 所有 view id / command id 保持原字面量 ('wereadVscode.main' / 'weread.xxx'),
 *      不改成 ctx.registerCommand 自动加前缀的形式。
 *   2. AuthService / MainViewProvider 仍接收原始 ExtensionContext (= ctx.raw),
 *      内部用到的 SecretStorage key ('weread.cookie') 和 globalState key
 *      ('weread.lastRead' / 'weread.tab') 全部保持不变, 老用户登录态 / 阅读
 *      进度缓存不会丢。
 *   3. 模块自己不调用 ctx.registerCommand / ctx.secrets, 因为现有 weread 代码
 *      还没有改造成走 ModuleContext, 强行套一层反而引入额外复杂度。等后续
 *      接入第二个模块、确实需要复用通用能力时再统一抽。
 */
const wereadModule: Module = {
  manifest: {
    id: 'weread',
    displayName: '微信读书',
  },

  async activate(ctx) {
    // 兼容现有 weread 代码: 取出原始 ExtensionContext。
    // 现有 AuthService / MainViewProvider 直接持有它来用 secrets / globalState。
    const context = ctx.raw;

    console.log('[weread-vscode] activate() called, extensionPath=', context.extensionPath);

    const auth = new AuthService(context);
    await auth.initialize();

    const client = new WereadClient(auth);
    const mainView = new MainViewProvider(context, client, auth);

    // ---- 视图注册 ----
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(MainViewProvider.viewType, mainView, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    // ---- 登录态 context key ----
    const syncLoginContext = () =>
      vscode.commands.executeCommand('setContext', 'weread.loggedIn', auth.isLoggedIn());
    syncLoginContext();
    context.subscriptions.push(auth.onDidChangeLoginState(() => syncLoginContext()));

    // ---- 命令注册 ----
    context.subscriptions.push(
      vscode.commands.registerCommand('weread.importCookie', async () => {
        const ok = await auth.importCookie();
        if (ok) {
          // 用户成功导入新 cookie -> 解除"renewal 死锁" (上一份 cookie 触发的锁定
          // 不应该残留到新会话). 必须放在 getCurrentUser 之前, 否则首次 /web/user
          // 触发的 renewal 自检还会被锁卡掉, 弹一遍假告警。
          client.markRenewalAlive();
          try {
            await client.getCurrentUser();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showWarningMessage(`登录态校验失败：${msg}`);
          }
          await mainView.refreshShelf();
        }
      }),

      vscode.commands.registerCommand('weread.logout', async () => {
        const choice = await vscode.window.showWarningMessage(
          '确定要退出微信读书登录吗？',
          { modal: true },
          '退出',
        );
        if (choice === '退出') {
          await auth.logout();
        }
      }),

      vscode.commands.registerCommand('weread.refreshBookshelf', async () => {
        if (!auth.isLoggedIn()) {
          vscode.window.showInformationMessage('请先登录微信读书');
          return;
        }
        await mainView.refreshShelf();
      }),

      // 命令式打开某本书（保留以便其他扩展/快捷键调用）
      vscode.commands.registerCommand('weread.openBook', async (book: WereadBook) => {
        if (!book?.bookId) return;
        await mainView.openBook(book);
      }),

      vscode.commands.registerCommand(
        'weread.openInBrowser',
        async (node: { book?: WereadBook } | WereadBook) => {
          const book =
            (node as { book?: WereadBook })?.book ?? (node as WereadBook | undefined);
          if (!book?.bookId) {
            vscode.window.showWarningMessage('未找到书籍信息');
            return;
          }
          const url = getBookReaderUrl(book.bookId);
          await vscode.env.openExternal(vscode.Uri.parse(url));
        },
      ),

      // 诊断: 把当前章节的 HTML/CSS/format 写到 Output 面板, 用于排查渲染异常
      vscode.commands.registerCommand('weread.diagnoseChapter', () => {
        mainView.diagnoseChapter();
      }),

      // 诊断: cookie 完整性 + renewal 实测, 用户报"几分钟就失效"时第一时间跑这个
      vscode.commands.registerCommand('weread.diagnoseCookie', async () => {
        if (!auth.isLoggedIn()) {
          vscode.window.showInformationMessage('请先导入 Cookie');
          return;
        }
        const jar = auth.getCookieJar();
        // 脱敏: 只看 key 是否存在 + value 长度, 避免日志/通知泄露 token
        const mask = (v: string | undefined) => (v ? `${v.length} 字符` : '(缺失)');
        const lines = [
          `wr_vid:  ${mask(jar['wr_vid'])}   ← 用户 ID, 长期不变`,
          `wr_skey: ${mask(jar['wr_skey'])}  ← 短期票据, server 续`,
          `wr_rt:   ${mask(jar['wr_rt'])}    ← 续命凭证 (HttpOnly), 缺它必失效`,
          `wr_pf:   ${mask(jar['wr_pf'])}`,
          `wr_gid:  ${mask(jar['wr_gid'])}`,
        ];
        const total = Object.keys(jar).length;
        console.log(
          `[weread-vscode] Cookie 健康诊断 — 共 ${total} 字段:\n  ${lines.join('\n  ')}`,
        );

        const hasRt = !!jar['wr_rt'];
        // 现场再发一次 renewal 实测一下 — 比看历史日志更可靠
        console.log('[weread-vscode] 现场执行 /web/login/renewal 看返回...');
        const ok = await client.renewWebLogin();
        console.log(`[weread-vscode] renewal 实测结果: ${ok ? '成功 ✓' : '失败 ✗'}`);

        const msg =
          `Cookie 共 ${total} 字段 | wr_rt ${hasRt ? '✓' : '✗ (缺!)'} | ` +
          `renewal 实测 ${ok ? '✓ 成功' : '✗ 失败'}\n\n` +
          (!hasRt
            ? '问题: 缺 wr_rt, 必失效 — 请重新导入 Cookie (要从 Network 而非 Application 面板复制)'
            : ok
            ? '健康, 续命链路正常'
            : '续命失败 — wr_rt 可能已过期, 请重新登录并导入');

        const action = await vscode.window.showInformationMessage(
          msg,
          { modal: true },
          '查看详细日志',
          '重新导入 Cookie',
        );
        if (action === '重新导入 Cookie') {
          await vscode.commands.executeCommand('weread.importCookie');
        } else if (action === '查看详细日志') {
          // 打开 Developer Tools, 让用户看 console 里的日志
          await vscode.commands.executeCommand('workbench.action.toggleDevTools');
        }
      }),

      // 紧急解锁: 某些 EPUB 章节(尤其是封面/插图章)解密出来的 CSS/HTML 可能
      // 污染整个 webview, 让侧栏卡死、点啥都不动。这个命令独立于 webview 通道,
      // 通过命令面板就能触发, 清掉"在读"快照回到书架。
      vscode.commands.registerCommand('weread.resetReadingState', async () => {
        try {
          await vscode.commands.executeCommand('wereadVscode.main.focus');
        } catch {
          try {
            await vscode.commands.executeCommand('workbench.view.extension.wereadVscode');
          } catch {
            /* ignore */
          }
        }
        await mainView.resetReadingState();
      }),
    );

    context.subscriptions.push({ dispose: () => auth.dispose() });

    // ---- Cookie 保活: 方案 2 (定时续) + 方案 4 (聚焦续) ----
    //
    // 终极方案 (touchFish 项目反编译验证):
    //   微信读书 web 端有 **官方续 token 接口** `POST /web/login/renewal`,
    //   只要 wr_rt (refresh token) 还有效, 这个接口就会通过 Set-Cookie 下发
    //   一个全新的 wr_skey, 比 HEAD / 稳定得多。
    //
    //   client.refreshCookieByHomepage() 已经被改造成:
    //     1) 先打 /web/login/renewal      ← 主路径
    //     2) 失败再 HEAD / 兜底           ← 网络抖动时再赌一次
    //
    // 历史教训 (本次修复前):
    //   只用 HEAD /, server 是否下发 Set-Cookie 不可控, 用户翻几章后 /web/book/info
    //   先死, 报 errCode=-2012, 体感"几分钟就失效"。
    //
    // 双重触发:
    //   - 方案 4 (聚焦): macOS 解锁回 VSCode 必触发 focus 事件 (不受 App Nap 节流),
    //     立刻续一次, 把锁屏期间到期的风险窗口压到最低。
    //   - 方案 2 (定时): 5min 一次 setInterval, 覆盖"用户长时间不离焦也不切窗"的场景。
    //     App Nap 锁屏期间会被严重节流, 但锁屏场景已由方案 4 兜底。
    //
    // 节流: 用 client.lastHomepageRefreshAt (上次"真正续到 wr_skey"的时间), 而 **不能**
    //   用 lastResponseAt — 业务响应虽然会刷新 lastResponseAt, 但根本不下发 Set-Cookie,
    //   用它做节流会导致用户翻几章就把定时永久卡死, 见 lastHomepageRefreshAt 字段注释。
    //
    // 间隔: renewal 接口是显式续命入口, 调用代价低, 短间隔多打更安全。
    //   定时 5 min + 节流 2 min, 配合聚焦事件应该够把 wr_skey 永远续在线上。
    const HEARTBEAT_MIN_INTERVAL_MS = 2 * 60 * 1000;
    const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

    const tryRefreshCookie = async (trigger: 'focus' | 'timer') => {
      if (!auth.isLoggedIn()) {
        return;
      }
      // renewal 已被 server 判定彻底失效 — 心跳再发只是徒劳骚扰 server,
      // 也会拖慢启动 (每次都要等 timeout)。直接跳过, 让 notifyRenewalDead
      // 的提示链路去引导用户重新登录浏览器。
      if (client.isRenewalDead()) {
        console.log(
          `[weread-vscode] ${trigger} 续命跳过 (renewalDead) — 等待用户重新登录浏览器并导入新 cookie`,
        );
        return;
      }
      // 首次启动 lastHomepageRefreshAt=0, 距离 1970-01-01 远大于阈值, 必然触发首发续命
      const sinceLastMs = Date.now() - client.lastHomepageRefreshAt;
      if (sinceLastMs < HEARTBEAT_MIN_INTERVAL_MS) {
        console.log(
          `[weread-vscode] ${trigger} 续命跳过 (节流) — 距上次续命成功仅 ${Math.round(sinceLastMs / 1000)}s`,
        );
        return;
      }
      console.log(
        `[weread-vscode] ${trigger} 续命触发 — 距上次续命成功 ${
          client.lastHomepageRefreshAt === 0
            ? '(从未续过)'
            : Math.round(sinceLastMs / 1000) + 's'
        }, 发起 /web/login/renewal`,
      );
      // refreshCookieByHomepage 内部不抛错, 也已经打了完成/异常日志,
      // 成功 (拿到 Set-Cookie) 时会自动更新 client.lastHomepageRefreshAt
      await client.refreshCookieByHomepage();
    };

    // 方案 4: 窗口聚焦时续 (解锁回 VSCode 的关键时机)
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState(async (state) => {
        if (!state.focused) {
          return;
        }
        await tryRefreshCookie('focus');
      }),
    );

    // 方案 2: 10min 定时续 (工作期间的主力)
    // App Nap 锁屏期间会被严重节流, 但锁屏场景已由方案 4 兜底, 这里只管前台工作期。
    const refreshTimer = setInterval(() => {
      void tryRefreshCookie('timer');
    }, REFRESH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

    // 启动后异步触发一次首发续命, 让"刚导入 cookie + 立刻翻第二章"的场景也有底
    void tryRefreshCookie('timer');

    // 启动后异步检查 Open VSX 上是否有新版本 (本插件没发到微软 Marketplace,
    // 原版 VSCode 无法自动升级, 用主动检查补这块体验)。
    // 不 await, 失败/超时静默, 不阻塞 activate。
    void checkForUpdates(context);
  },
};

export default wereadModule;

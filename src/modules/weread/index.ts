import * as vscode from 'vscode';
import type { Module } from '../../core/Module';
import { AuthService } from './auth/AuthService';
import { WereadClient } from './api/WereadClient';
import { MainViewProvider } from './views/MainViewProvider';
import { WereadBook } from './types';
import { getBookReaderUrl } from './api/wereadUrl';
import { checkForUpdates } from './services/UpdateChecker';
import { ChapterCache } from './services/ChapterCache';

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

    // 章节内容缓存 — 跨重启 + 抗 cookie 过期, 详见 ChapterCache 头注释
    const chapterCache = new ChapterCache(context);

    const mainView = new MainViewProvider(context, client, auth, chapterCache);

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

      // 书城: 打开"书城"页 (榜单/分类浏览). 不校验登录 —
      // /web/search/global 与榜单 SSR 页面都不需要 cookie, 未登录也能逛。
      vscode.commands.registerCommand('weread.openStore', async () => {
        await mainView.openStore();
      }),

      // 书城: 命令面板直接搜书, 省掉"先开侧栏再点搜索框"两步
      vscode.commands.registerCommand('weread.searchBooks', async () => {
        const keyword = await vscode.window.showInputBox({
          title: '书城搜索',
          prompt: '输入书名 / 作者，回车搜索（搜索无需登录，阅读才需要）',
          placeHolder: '例如：三体 / 刘慈欣',
          ignoreFocusOut: true,
        });
        if (keyword === undefined) return; // ESC 取消
        await mainView.openStore(keyword);
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

      // 章节缓存可视化 — 命令面板两级 QuickPick 下钻:
      //   Level 1: 列出每本已缓存书 (书名/作者/章数/大小, 按占用倒序) + 顶部"清空全部"
      //   Level 2: 选某本书后列章节 (标题/大小/更新时间, 按"书中目录顺序"升序) + 顶部"清空本书"
      // 比一条干巴巴的 showInformationMessage 直观得多, 也顺便给用户提供就地清理入口.
      vscode.commands.registerCommand('weread.chapterCacheStats', async () => {
        const books = await chapterCache.listAll();
        if (books.length === 0) {
          vscode.window.showInformationMessage(
            '章节缓存为空 — 翻几章后再来看吧.',
          );
          return;
        }
        const memEntries = (await chapterCache.stats()).memEntries;
        // 按本书占用倒序 — 大头排前面方便用户决定是否清理
        books.sort((a, b) => b.totalSizeKB - a.totalSizeKB);
        const totalChapters = books.reduce(
          (a, b) => a + b.chapters.length,
          0,
        );
        const totalKB = books.reduce((a, b) => a + b.totalSizeKB, 0);

        const fmtSize = (kb: number) =>
          kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
        const fmtTime = (ms: number) => {
          const dt = Date.now() - ms;
          if (dt < 60_000) return '刚刚';
          if (dt < 3_600_000) return `${Math.floor(dt / 60_000)} 分钟前`;
          if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)} 小时前`;
          return `${Math.floor(dt / 86_400_000)} 天前`;
        };

        // ===== Level 1: 选书 =====
        // 顶部内联两个常用操作 (清空 / 配置预缓存), 让 "看缓存 → 立刻动手调" 形成短闭环;
        // 用户不必再去命令面板搜或 settings.json 改。
        type BookItem = vscode.QuickPickItem & {
          __bookIdx?: number;
          __action?: 'clearAll' | 'configurePrefetch';
        };
        // 当前预缓存档位摘要 — 列在 "调整预缓存" 项的 description 里, 一眼看现状
        const prefetchCfg = vscode.workspace.getConfiguration('weread.chapterPrefetch');
        const pfEnabled = prefetchCfg.get<boolean>('enabled', true);
        const pfAhead = prefetchCfg.get<number>('ahead', 10);
        const pfBehind = prefetchCfg.get<number>('behind', 1);
        const pfSummary = pfEnabled
          ? `当前: 后 ${pfAhead} / 前 ${pfBehind} 章`
          : '当前: 已关闭';

        const items: BookItem[] = [
          {
            label: '$(gear) 调整预缓存设置...',
            description: pfSummary,
            detail: '直接填章数: 后 (0–50) · 前 (0–10), 两端都填 0 即关闭',
            __action: 'configurePrefetch',
          },
          {
            label: '$(trash) 清空全部缓存',
            description: `${books.length} 本 · ${totalChapters} 章 · ${fmtSize(totalKB)}`,
            __action: 'clearAll',
          },
          {
            kind: vscode.QuickPickItemKind.Separator,
            label: `已缓存书籍 (${books.length})`,
          } as BookItem,
          ...books.map<BookItem>((b, idx) => ({
            label: b.bookTitle
              ? `$(book) ${b.bookTitle}`
              : `$(book) (未命名 · id ${b.bookId.slice(0, 10)})`,
            description: b.author ?? '',
            detail: `${b.chapters.length} 章 · ${fmtSize(b.totalSizeKB)} · id ${b.bookId}`,
            __bookIdx: idx,
          })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
          title: `章节缓存 — ${books.length} 本书 · ${totalChapters} 章 · ${fmtSize(totalKB)} · 内存层 ${memEntries} 条`,
          placeHolder: '选择一本书查看已缓存章节, 或选择上方操作',
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (!picked) return;

        if (picked.__action === 'configurePrefetch') {
          // 转发到 configurePrefetch 命令 — 单一实现, 避免逻辑分叉
          await vscode.commands.executeCommand('weread.configurePrefetch');
          return;
        }

        if (picked.__action === 'clearAll') {
          const choice = await vscode.window.showWarningMessage(
            `确定清空全部 ${books.length} 本书 / ${totalChapters} 章 (${fmtSize(totalKB)}) 缓存吗? 下次翻章节会重新走网络.`,
            { modal: true },
            '清空',
          );
          if (choice === '清空') {
            const cleared = await chapterCache.clearAll();
            vscode.window.showInformationMessage(
              `章节缓存已清空 (${cleared.chapters} 章 / ${fmtSize(cleared.sizeKB)})`,
            );
          }
          return;
        }

        // ===== Level 2: 选章节 =====
        const book = books[picked.__bookIdx!];
        // 章节排序 — 三层 fallback, 按"书中真实目录顺序"升序排列:
        //   1) idx 优先 (来自 _meta.json.chapterOrder 快照, 最稳)
        //   2) 都无 idx 时退到 chapterUid 数字升序 (一般 EPUB 大致按目录递增, 但可能有间隙)
        //   3) 仍打平时按字典序 — 至少保证稳定排序, 不会忽前忽后
        // mtime 不再参与排序, 但保留在 description 里供"我最近读了哪章"参考.
        const sortedChapters = [...book.chapters].sort((a, b) => {
          if (a.idx !== undefined && b.idx !== undefined) return a.idx - b.idx;
          if (a.idx !== undefined) return -1;
          if (b.idx !== undefined) return 1;
          const na = Number(a.chapterUid);
          const nb = Number(b.chapterUid);
          if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
          return a.chapterUid.localeCompare(b.chapterUid);
        });
        // 用于判断"是否还有老缓存没带 chapterOrder" — 全无 idx 时给个温和提示, 解释为什么可能不准
        const hasOrderInfo = sortedChapters.some((ch) => ch.idx !== undefined);
        type ChItem = vscode.QuickPickItem & { __action?: 'clearBook' };
        const chItems: ChItem[] = [
          {
            label: '$(trash) 清空本书的所有缓存',
            description: `${sortedChapters.length} 章 · ${fmtSize(book.totalSizeKB)}`,
            __action: 'clearBook',
          },
          {
            kind: vscode.QuickPickItemKind.Separator,
            label: hasOrderInfo
              ? `已缓存章节 (按书中目录顺序, 共 ${sortedChapters.length} 章)`
              : `已缓存章节 (按 uid 数字升序 — 翻一章后会自动按真实目录顺序排, 共 ${sortedChapters.length} 章)`,
          } as ChItem,
          ...sortedChapters.map<ChItem>((ch) => ({
            // idx 存在时在标题前打一个"第 N 章 (1-based)"前缀, 让目录顺序更直观
            label:
              (ch.idx !== undefined ? `${ch.idx + 1}. ` : '') +
              (ch.chapterTitle
                ? `$(file) ${ch.chapterTitle}`
                : `$(file) chapter ${ch.chapterUid}`),
            description: `${fmtSize(ch.sizeKB)} · ${fmtTime(ch.mtimeMs)}`,
            detail: `uid ${ch.chapterUid}`,
          })),
        ];

        const pickedCh = await vscode.window.showQuickPick(chItems, {
          title: `${book.bookTitle ?? `id ${book.bookId}`} — 已缓存 ${sortedChapters.length} 章 · ${fmtSize(book.totalSizeKB)}`,
          placeHolder: '查看章节或就地清理本书',
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (!pickedCh) return;

        if (pickedCh.__action === 'clearBook') {
          const choice = await vscode.window.showWarningMessage(
            `确定清空《${book.bookTitle ?? book.bookId}》的 ${sortedChapters.length} 章缓存吗?`,
            { modal: true },
            '清空',
          );
          if (choice === '清空') {
            const cleared = await chapterCache.clearBook(book.bookId);
            vscode.window.showInformationMessage(
              `已清空《${book.bookTitle ?? book.bookId}》${cleared.chapters} 章 / ${fmtSize(cleared.sizeKB)}`,
            );
          }
          return;
        }

        // 用户点击了一个具体章节 → 尝试打开这本书并跳到该章 (离线模式兜底),
        // cookie 有效时会走完整的在线路径, cookie 失效时走离线模式读缓存.
        // 书信息来自 _meta.json 的章节快照, 没有完整的 WereadBook 那些字段,
        // 但 `openBook` 只依赖 bookId + title, 其余填充空值即可.
        if (pickedCh) {
          const chapterItem = sortedChapters.find((ch) => {
            const label = (ch.idx !== undefined ? `${ch.idx + 1}. ` : '') +
              (ch.chapterTitle ? `$(file) ${ch.chapterTitle}` : `$(file) chapter ${ch.chapterUid}`);
            return label === pickedCh.label;
          });
          if (chapterItem) {
            const chUid = Number(chapterItem.chapterUid);
            const bookSnap: WereadBook = {
              bookId: book.bookId,
              title: book.bookTitle ?? book.bookId,
              author: book.author,
            };
            // 把章节 uid 预先塞进 pendingRestoreChapterUid, loadBookInternal 会用来定位
            mainView.setPendingChapterUid(Number.isFinite(chUid) ? chUid : undefined);
            await mainView.openBook(bookSnap);
          }
        }
      }),

      // 章节预缓存设置 UI — 替代直接编辑 settings.json:
      //   连续两个 InputBox 分别问 ahead / behind, 范围说明 + 占用估算写在 prompt 里;
      //   两端都填 0 自动判定为"关闭", 不再额外暴露 enabled toggle (语义等价更简洁).
      // 入口: ① 命令面板  ② 侧栏标题栏 ⋯ 菜单  ③ "查看已缓存章节"下钻面板顶部内联项
      vscode.commands.registerCommand('weread.configurePrefetch', async () => {
        const cfg = vscode.workspace.getConfiguration('weread.chapterPrefetch');
        const curEnabled = cfg.get<boolean>('enabled', true);
        const curAhead = cfg.get<number>('ahead', 10);
        const curBehind = cfg.get<number>('behind', 1);
        // 关闭状态时输入框默认填 0, 让"关闭→重新开启"的路径更顺;
        // 否则保留用户上次的设定值
        const initAhead = curEnabled ? curAhead : 0;
        const initBehind = curEnabled ? curBehind : 0;

        const aheadStr = await vscode.window.showInputBox({
          title: '章节预缓存 — 1/2 · 向后预缓存章数',
          value: String(initAhead),
          prompt:
            '阅读时后台静默预拉接下来的 N 章, 翻"下一章"直接命中本地缓存 + 抗 cookie 突然过期. ' +
            '0 表示关闭. 范围 0–50, 每章约 50–300KB. 推荐 10.',
          placeHolder: '0 ~ 50 的整数',
          validateInput: (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n > 50) {
              return '请输入 0 ~ 50 之间的整数';
            }
            return null;
          },
        });
        if (aheadStr === undefined) return; // ESC 取消

        const behindStr = await vscode.window.showInputBox({
          title: '章节预缓存 — 2/2 · 向前预缓存章数',
          value: String(initBehind),
          prompt: '前面 M 章, 方便回看上一章. 范围 0–10. 推荐 1.',
          placeHolder: '0 ~ 10 的整数',
          validateInput: (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n > 10) {
              return '请输入 0 ~ 10 之间的整数';
            }
            return null;
          },
        });
        if (behindStr === undefined) return;

        const ahead = Number(aheadStr);
        const behind = Number(behindStr);
        // 两端都 0 → 自动判定为"关闭", 避免"开着但啥也不拉"的诡异中间态
        const enabled = ahead > 0 || behind > 0;

        // 写入 Global 而非 Workspace — 阅读偏好天然是用户级, 不该跟着工作区走.
        // 三个字段分别 update; vscode 内部会合并触发 onDidChangeConfiguration.
        try {
          await cfg.update('enabled', enabled, vscode.ConfigurationTarget.Global);
          await cfg.update('ahead', ahead, vscode.ConfigurationTarget.Global);
          await cfg.update('behind', behind, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(
            enabled
              ? `预缓存已设为: 后 ${ahead} 章 / 前 ${behind} 章 (下次切章立即生效)`
              : '预缓存已关闭 (仅缓存当前在读章节)',
          );
        } catch (e) {
          vscode.window.showErrorMessage(
            `预缓存设置写入失败: ${(e as Error)?.message ?? 'unknown'}`,
          );
        }
      }),

      // 一键清空所有章节缓存 — 跟 chapterCacheStats 的"清空全部"等价, 留个独立入口
      // 方便快捷键/命令直接调用 (不必先打开下钻).
      vscode.commands.registerCommand('weread.clearChapterCache', async () => {
        const choice = await vscode.window.showWarningMessage(
          '确定清空所有已缓存的章节内容吗? 下次翻章节会重新走网络.',
          { modal: true },
          '清空',
        );
        if (choice !== '清空') return;
        const cleared = await chapterCache.clearAll();
        vscode.window.showInformationMessage(
          `章节缓存已清空 (${cleared.chapters} 章 / ${cleared.sizeKB} KB)`,
        );
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

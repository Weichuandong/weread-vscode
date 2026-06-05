import * as vscode from 'vscode';
import { AuthService } from './auth/AuthService';
import { WereadClient } from './api/WereadClient';
import { MainViewProvider } from './views/MainViewProvider';
import { WereadBook } from './types';
import { getBookReaderUrl } from './api/wereadUrl';
import { checkForUpdates } from './services/UpdateChecker';

/**
 * 扩展入口。
 *
 * v0.0.2 起视图组合简化为：
 *  - Activity Bar 容器 "wereadVscode" (id 加 vscode 后缀避开社区里其他微信读书插件)
 *    └── 微信读书 (单一 Webview View, wereadVscode.main)
 *         顶部 tab 切换: 📚 书架 / 📖 在读
 *
 * 设计动机：原先的 TreeView + 阅读 WebviewView 双视图占据较多纵向 header,
 * 合并为单 webview 后阅读区域可获得 ~90% 纵向空间, 也方便统一排版与交互。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

  // 启动后异步检查 Open VSX 上是否有新版本 (本插件没发到微软 Marketplace,
  // 原版 VSCode 无法自动升级, 用主动检查补这块体验)。
  // 不 await, 失败/超时静默, 不阻塞 activate。
  void checkForUpdates(context);
}

export function deactivate(): void {
  // 资源会通过 context.subscriptions 自动释放
}

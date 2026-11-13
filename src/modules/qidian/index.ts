import * as vscode from 'vscode';
import type { Module } from '../../core/Module';
import { QidianAuthService } from './auth/AuthService';
import { QidianClient } from './api/QidianClient';
import { QidianMainViewProvider } from './views/MainViewProvider';
import { getBookUrl } from './api/qidianParse';
import { QidianBook } from './types';

/**
 * 起点中文网模块 (侧栏代号 Saga)。
 *
 * 能力与 Folio (微信读书) 对齐: 书架 / 书城 (搜索 + 榜单 + 加书架) / 在读 (目录、排版、
 * 键盘翻页、云端进度互通)。命令名均为 package.json 里的完整字面量 `qidian.xxx`,
 * 风格与 weread / zhihu 模块一致。
 *
 * 与 Folio 的差异 (平台限制):
 *   - 起点登录票据 ywkey 有效期较长, 也没有公开的续命接口, 所以不做心跳续命;
 *     只合并服务端下发的 Set-Cookie, 失效时挂被动横幅
 *   - VIP 章节 web 端加密下发, 不破解, 引导到浏览器 / 起点 APP 阅读
 */
const qidianModule: Module = {
  manifest: {
    id: 'qidian',
    displayName: '起点中文网',
  },

  async activate(ctx) {
    const context = ctx.raw;
    const auth = new QidianAuthService(context);
    await auth.initialize();
    const client = new QidianClient(auth);
    const view = new QidianMainViewProvider(context, client, auth);

    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(QidianMainViewProvider.viewType, view, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    const syncLoginContext = () =>
      vscode.commands.executeCommand('setContext', 'qidian.loggedIn', auth.isLoggedIn());
    void syncLoginContext();
    ctx.subscriptions.push(auth.onDidChangeLoginState(() => void syncLoginContext()));

    ctx.subscriptions.push(
      vscode.commands.registerCommand('qidian.importCookie', async () => {
        const ok = await auth.importCookie();
        if (!ok) return;
        try {
          const me = await client.getCurrentUser();
          vscode.window.showInformationMessage(`起点：当前登录账号 ${me.nickName ?? me.guid ?? '未知用户'}`);
        } catch (e) {
          vscode.window.showWarningMessage(`起点：登录态校验失败 — ${e instanceof Error ? e.message : String(e)}`);
        }
        await view.refreshShelf();
      }),

      vscode.commands.registerCommand('qidian.logout', async () => {
        const choice = await vscode.window.showWarningMessage('确定要退出起点登录吗？', { modal: true }, '退出');
        if (choice === '退出') await auth.logout();
      }),

      vscode.commands.registerCommand('qidian.checkLogin', async () => {
        if (!auth.isLoggedIn()) {
          const pick = await vscode.window.showInformationMessage('还没有导入起点 Cookie', '导入 Cookie');
          if (pick) await vscode.commands.executeCommand('qidian.importCookie');
          return;
        }
        const jar = auth.getCookieJar();
        const mask = (v: string | undefined) => (v ? `${v.length} 字符` : '(缺失)');
        try {
          const me = await client.getCurrentUser();
          vscode.window.showInformationMessage(
            `起点登录正常：${me.nickName ?? me.guid ?? '未知用户'}（ywkey ${mask(jar['ywkey'])} · ywguid ${mask(jar['ywguid'])}）`,
          );
        } catch (e) {
          const pick = await vscode.window.showWarningMessage(
            `起点登录异常：${e instanceof Error ? e.message : String(e)}（ywkey ${mask(jar['ywkey'])} · ywguid ${mask(jar['ywguid'])}）`,
            '重新导入 Cookie',
          );
          if (pick) await vscode.commands.executeCommand('qidian.importCookie');
        }
      }),

      vscode.commands.registerCommand('qidian.refreshBookshelf', async () => {
        if (!auth.isLoggedIn()) {
          vscode.window.showInformationMessage('请先登录起点（Saga: 导入 Cookie 登录）');
          return;
        }
        await view.refreshShelf();
      }),

      // 书城 / 搜索不需要登录
      vscode.commands.registerCommand('qidian.openStore', async () => {
        await view.openStore();
      }),

      vscode.commands.registerCommand('qidian.searchBooks', async () => {
        const keyword = await vscode.window.showInputBox({
          title: '起点书城搜索',
          prompt: '输入书名 / 作者，回车搜索（搜索与免费章节阅读无需登录）',
          placeHolder: '例如：诡秘之主 / 爱潜水的乌贼',
          ignoreFocusOut: true,
        });
        if (keyword === undefined) return;
        await view.openStore(keyword);
      }),

      // 供其它扩展 / 快捷键调用: 传入 { bookId, title } 直接打开
      vscode.commands.registerCommand('qidian.openBook', async (book?: QidianBook) => {
        if (!book?.bookId) return;
        await view.openBook({ ...book, title: book.title ?? '' });
      }),

      vscode.commands.registerCommand('qidian.openInBrowser', async (book?: { bookId?: string }) => {
        const url = book?.bookId ? getBookUrl(book.bookId) : view.currentUrl() ?? 'https://m.qidian.com/';
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }),

      vscode.commands.registerCommand('qidian.resetReadingState', async () => {
        try {
          await vscode.commands.executeCommand(`${QidianMainViewProvider.viewType}.focus`);
        } catch {
          /* ignore */
        }
        await view.resetReadingState();
      }),
    );

    ctx.subscriptions.push({ dispose: () => auth.dispose() });
  },
};

export default qidianModule;

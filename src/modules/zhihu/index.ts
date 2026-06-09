import * as vscode from 'vscode';
import type { Module } from '../../core/Module';
import { ZhihuAuthService } from './auth/AuthService';
import { ZhihuClient } from './api/ZhihuClient';
import { MainViewProvider } from './views/MainViewProvider';

/**
 * 知乎模块。
 *
 * 与 weread 模块的对比 (设计上有意保持的差异):
 *
 *   | 维度           | weread (已有)                       | zhihu (本模块)                    |
 *   | ---            | ---                                 | ---                              |
 *   | Cookie 续命    | 拦截 Set-Cookie + 定时心跳 + 聚焦续  | 不做 — z_c0 是长期 cookie 不会过期 |
 *   | 内嵌阅读       | 完整 EPUB 章节渲染 (3000+ 行)       | 卡片就地展开纯文本 + 分段加载, 视频跳浏览器 |
 *   | 列表去重       | n/a (书架天然唯一)                  | 三层去重 (session_token / read 上报 / 前端 Set) |
 *   | 视图           | 单 webview, tab 切书架/在读          | 单 webview, 只有推荐列表          |
 *
 * 这里没用 ctx.registerCommand 而是直接 vscode.commands.registerCommand —
 * 跟 weread 模块对齐的风格, 命令名在 package.json 里都是完整字面量
 * ('zhihu.importCookie' 等), 框架自动加前缀那一套留给未来"模块完全跑通 ctx 模型"时再统一切。
 */
const zhihuModule: Module = {
  manifest: {
    id: 'zhihu',
    displayName: '知乎摸鱼',
  },

  async activate(ctx) {
    console.log('[zhihu] activate');

    const auth = new ZhihuAuthService(ctx);
    await auth.initialize();

    const client = new ZhihuClient(auth);
    const view = new MainViewProvider(ctx.raw, client, auth);

    // ---- 视图注册 ----
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(MainViewProvider.viewType, view, {
        // 切走再切回不重新拉一遍, 避免反复"加载中"
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    // ---- 登录态 context key (供 package.json 里 when 子句使用) ----
    const syncLoginContext = () =>
      vscode.commands.executeCommand('setContext', 'zhihu.loggedIn', auth.isLoggedIn());
    syncLoginContext();
    ctx.subscriptions.push(auth.onDidChangeLoginState(() => syncLoginContext()));

    // ---- 命令注册 ----
    ctx.subscriptions.push(
      vscode.commands.registerCommand('zhihu.importCookie', async () => {
        const ok = await auth.importCookie();
        if (ok) {
          try {
            const me = await client.getCurrentUser();
            const name = me.name ?? '未知用户';
            vscode.window.showInformationMessage(`知乎: 当前登录账号 ${name}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showWarningMessage(`知乎: 登录态校验失败 — ${msg}`);
          }
          await view.refresh();
        }
      }),

      vscode.commands.registerCommand('zhihu.logout', async () => {
        const choice = await vscode.window.showWarningMessage(
          '确定要退出知乎登录吗?',
          { modal: true },
          '退出',
        );
        if (choice === '退出') {
          await auth.logout();
        }
      }),

      vscode.commands.registerCommand('zhihu.refreshRecommend', async () => {
        if (!auth.isLoggedIn()) {
          vscode.window.showInformationMessage('请先登录知乎');
          return;
        }
        await view.refresh();
      }),

      // 给其他扩展 / 快捷键调用: 传入 url 直接外部打开
      vscode.commands.registerCommand('zhihu.openInBrowser', async (url?: string) => {
        if (typeof url === 'string' && url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          await vscode.env.openExternal(vscode.Uri.parse('https://www.zhihu.com/'));
        }
      }),
    );

    ctx.subscriptions.push({ dispose: () => auth.dispose() });
  },
};

export default zhihuModule;

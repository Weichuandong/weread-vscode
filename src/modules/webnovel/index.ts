import * as vscode from 'vscode';
import * as path from 'path';
import type { Module } from '../../core/Module';
import { WebNovelClient } from './api/WebNovelClient';
import { ChapterStore } from './services/ChapterStore';
import { CacheDownloader } from './services/CacheDownloader';
import { WebNovelMainViewProvider, normalizeInputUrl } from './views/MainViewProvider';

/**
 * 网页小说阅读器模块 (侧栏代号 Codex)。
 *
 * 粘贴任意小说站的章节页 / 目录页链接即可阅读:
 *   - 章节页: 自动识别正文、把 xxx.html / xxx_2.html … 多页合并成一整章、过滤站点水印
 *   - 目录页: 自动识别章节列表并合并目录分页; 阅读时可抽屉看目录, 也可切到整页目录
 *   - 阅读体验 (排版 / 目录抽屉 / 键盘翻页) 与 Saga (起点) 共用同一套实现
 *   - 离线缓存: 后续 N 章 / 全书落盘到 globalStorage, 断网也能读
 *
 * 不需要登录, 只读取公开网页。解析是通用启发式, 不针对任何单一站点写死规则。
 */
const webnovelModule: Module = {
  manifest: {
    id: 'webnovel',
    displayName: '网页小说阅读器',
  },

  async activate(ctx) {
    const context = ctx.raw;
    const client = new WebNovelClient();
    const store = new ChapterStore(path.join(context.globalStorageUri.fsPath, 'webnovel-cache'));
    try {
      await store.init();
    } catch (e) {
      console.error('[touchPlus] webnovel cache init failed', e);
    }
    const downloader = new CacheDownloader(client, store);
    const view = new WebNovelMainViewProvider(context, client, store, downloader);

    ctx.subscriptions.push(
      client,
      downloader,
      { dispose: () => void store.flush() },
      vscode.window.registerWebviewViewProvider(WebNovelMainViewProvider.viewType, view, {
        webviewOptions: { retainContextWhenHidden: true },
      }),

      vscode.commands.registerCommand('webnovel.openUrl', async (arg?: string) => {
        let url = typeof arg === 'string' ? arg : undefined;
        if (!url) {
          // 剪贴板里正好是个链接就直接预填
          let clip = '';
          try {
            clip = (await vscode.env.clipboard.readText()).trim();
          } catch {
            /* ignore */
          }
          url = await vscode.window.showInputBox({
            title: 'Codex：打开网页小说',
            prompt: '粘贴章节页（直接开读）或目录页（先看章节列表）链接',
            placeHolder: '例如：https://m.example.com/chapter/123/456.html',
            value: /^https?:\/\//i.test(clip) && !/\s/.test(clip) ? clip : '',
            ignoreFocusOut: true,
            validateInput: (v) => (!v.trim() || normalizeInputUrl(v) ? undefined : '不是有效的网址'),
          });
        }
        if (!url?.trim()) return;
        await view.openUrl(url);
      }),

      vscode.commands.registerCommand('webnovel.cacheChapters', async () => {
        await view.openCacheMenu();
      }),

      vscode.commands.registerCommand('webnovel.clearCache', async () => {
        await view.clearAllCache();
      }),

      vscode.commands.registerCommand('webnovel.openInBrowser', async () => {
        const url = view.currentUrl();
        if (!url) {
          vscode.window.showInformationMessage('Codex：当前没有打开的页面');
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }),

      vscode.commands.registerCommand('webnovel.clearHistory', async () => {
        const choice = await vscode.window.showWarningMessage('确定清空 Codex 的最近阅读记录吗？', { modal: true }, '清空');
        if (choice === '清空') await view.clearHistory();
      }),

      vscode.commands.registerCommand('webnovel.resetReadingState', async () => {
        try {
          await vscode.commands.executeCommand(`${WebNovelMainViewProvider.viewType}.focus`);
        } catch {
          /* ignore */
        }
        await view.resetReadingState();
      }),
    );
  },
};

export default webnovelModule;

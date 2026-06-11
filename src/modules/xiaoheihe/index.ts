import * as vscode from 'vscode';
import type { Module } from '../../core/Module';
import { XiaoheiheClient } from './api/XiaoheiheClient';
import { XiaoheiheAuthService } from './auth/AuthService';
import { MainViewProvider } from './views/MainViewProvider';
import { BUILTIN_SECTIONS, HOME_SECTION_META } from './types';

/**
 * 小黑盒资讯模块.
 *
 * 跟其它两个模块的核心差异 (v2.2 后):
 *
 *   | 维度        | weread / zhihu              | xiaoheihe (本模块)            |
 *   | ---         | ---                         | ---                          |
 *   | 登录        | 需要导 cookie               | 可选 — 未登录走伪 imei + 公开 API;
 *   |             |                             | 登录后注入 pkey 走个性化推荐    |
 *   | 个性化推荐  | 强 (会话 token / 已读上报)  | 登录后启用 (/bbs/app/feeds/maintab),
 *   |             |                             | 未登录回落本地多板块混排        |
 *   | 内嵌阅读    | 卡片就地展开 (zhihu) / EPUB 渲染 (weread) | v1 基础版: 点击外部浏览器打开 |
 *
 * 命令:
 *   - xiaoheihe.switchGame     选择板块 (走 QuickPick — 含主页 + 所有内置板块)
 *   - xiaoheihe.refresh        刷新当前板块
 *   - xiaoheihe.openInBrowser  在浏览器打开指定 url (供 webview 调用)
 *   - xiaoheihe.resetImei      重置设备 IMEI (被风控 show_captcha 后的逃生口)
 *   - xiaoheihe.importCookie   导入 cookie 登录 (启用个性化推荐流)
 *   - xiaoheihe.logout         退出登录 (主页回落本地混排)
 *
 * v2.2 起板块自选 / 自定义 / 主页混排走 webview ⚙ 按钮, 不再走命令面板.
 *
 * 风格遵循 zhihu 模块: 直接 vscode.commands.registerCommand 全字面量, 命令名跟
 * package.json contributes 字面对齐, 不走 ctx.registerCommand 的自动前缀 — 已经
 * 是项目里第三个模块了, 保持风格统一比上 ctx 模式更重要.
 *
 * Client 跟 Auth 的关系:
 *   - client 持有 `getCookieJar` 回调而不是 auth 实例 (回调式依赖注入)
 *   - 登录态变化时 auth.getJar() 直接返回新值, 不需要重建 client
 *   - resetImei 是少数需要重建 client 的场景 (因为 imei 是 client 构造参数)
 */
const xiaoheiheModule: Module = {
  manifest: {
    id: 'xiaoheihe',
    displayName: '小黑盒游戏资讯',
  },

  async activate(ctx) {
    console.log('[xiaoheihe] activate');

    const requestTimeoutMs = ctx.getConfig<number>('requestTimeout', 15000);

    // ---- 登录态服务 (cookie 持久化 + 内存缓存) ----
    // 必须在 new XiaoheiheClient 之前 initialize, 否则 client 第一次发请求时
    // auth.getJar() 还没读到 SecretStorage, 等于按未登录态发出去 (虽然不会出错,
    // 但首次加载就少了个性化推荐, 体验差一拍).
    const auth = new XiaoheiheAuthService(ctx);
    await auth.initialize();

    // 首次启动随机生成并持久化到 globalState, 后续启动复用 — 同台机器固定 IMEI,
    // 不同机器分散 (避免全网用户共用一个 IMEI 被服务端打成机器人). 详见
    // XiaoheiheClient.getOrCreateImei 注释.
    const imei = await XiaoheiheClient.getOrCreateImei(ctx.raw);
    // settings 注入模式获取器: 跟 getCookieJar 一样回调式注入到 client.
    //   读 vscode.workspace 在每次请求时同步执行, 用户改了 settings 不用重启.
    //   合法值固定 3 种, 防御性收窄非法输入回到 'header' (避免用户瞎填把请求挂了).
    const getCookieInjectMode = (): 'header' | 'query' | 'off' => {
      const v = vscode.workspace
        .getConfiguration('xiaoheihe.api')
        .get<string>('cookieInjectMode');
      if (v === 'query' || v === 'off' || v === 'header') return v;
      return 'header';
    };

    // v2.2.4 起 web hkey 用本地算法 (utils/webSign.ts), 不再需要"已登录但未注入
    // web 签名"的 toast 引导 — cookie 导入一步到位, 主页推荐流自动跑起来.
    // 历史代码: v2.2.3 在这里有个 notifyWebSigMissing / webSigToastShown 一次性
    // 提示, 配合 client.onWebSigMissing 钩子使用, 已随算法落地一并删除.

    const client = new XiaoheiheClient({
      imei,
      // 回调式注入: 不传 auth 实例, 避免 client 反向依赖 auth 模块 (跨层耦合).
      //   每次 signedGet 都现取, 等同于"实时跟随" auth 的最新登录态, 登录/登出
      //   不需要重建 client.
      getCookieJar: () => auth.getJar(),
      getCookieInjectMode,
      requestTimeoutMs,
    });
    const view = new MainViewProvider(ctx.raw, client, auth);

    // ---- 视图注册 ----
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(MainViewProvider.viewType, view, {
        // 切走再切回不重拉 — 跟其它模块对齐, 保持"摸鱼时切走切回不显眼"的体验
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    // ---- 命令注册 ----
    ctx.subscriptions.push(
      // 通用刷新
      vscode.commands.registerCommand('xiaoheihe.refresh', async () => {
        await view.refresh();
      }),

      // 用 QuickPick 选板块 — 命令面板里列所有内置板块 + 主页 (custom 不在这里列,
      // 想切自定义板块直接点 webview tab 即可, 命令面板放高频项).
      vscode.commands.registerCommand('xiaoheihe.switchGame', async () => {
        const items = [
          { label: HOME_SECTION_META.label, description: HOME_SECTION_META.id, sectionId: HOME_SECTION_META.id },
          ...BUILTIN_SECTIONS.map((s) => ({
            label: s.label + (s.verified ? '' : ' (未验证)'),
            description: s.id,
            sectionId: s.id,
          })),
        ];
        const picked = await vscode.window.showQuickPick(items, {
          title: '切换板块',
          placeHolder: '小黑盒 — 切换板块 (含主页推荐)',
        });
        if (picked) {
          await view.switchSection(picked.sectionId);
        }
      }),

      // 给 webview / 其它扩展用: 传 url 直接外部打开
      vscode.commands.registerCommand('xiaoheihe.openInBrowser', async (url?: string) => {
        if (typeof url === 'string' && url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          await vscode.env.openExternal(vscode.Uri.parse('https://www.xiaoheihe.cn/'));
        }
      }),

      // 重置设备 IMEI — 风控 (show_captcha) 后的逃生口.
      // 流程: 生成新 IMEI 持久化 -> new XiaoheiheClient -> view 热替换 -> 刷新.
      // 用户体感: 一次命令解决 "被验证码挡住" 的问题, 不用重启 VSCode.
      vscode.commands.registerCommand('xiaoheihe.resetImei', async () => {
        const confirm = await vscode.window.showWarningMessage(
          '将重置小黑盒设备 ID (用于解除服务端风控). 重置后会立即刷新当前板块. 是否继续?',
          { modal: true },
          '确定重置',
        );
        if (confirm !== '确定重置') return;
        const newImei = await XiaoheiheClient.resetImei(ctx.raw);
        // 重建 client 时也要把 getCookieJar 接回去, 否则新 client 永远是未登录态.
        const newClient = new XiaoheiheClient({
          imei: newImei,
          getCookieJar: () => auth.getJar(),
          getCookieInjectMode,
          requestTimeoutMs,
        });
        view.replaceClient(newClient);
        vscode.window.showInformationMessage(
          `小黑盒设备 ID 已重置 (${newImei.slice(0, 4)}...${newImei.slice(-4)}), 即将刷新列表.`,
        );
        try {
          await view.refresh();
        } catch {
          // refresh 失败不影响 IMEI 已重置的事实, 用户下次手动点也能用
        }
      }),

      // 导入 cookie 登录 — 启用个性化推荐流.
      // AuthService.importCookie 内部已弹 InputBox + 校验 + 持久化 + fire 登录态事件,
      // 这里只负责接命令名, 业务逻辑全在 service 里.
      vscode.commands.registerCommand('xiaoheihe.importCookie', async () => {
        await auth.importCookie();
      }),

      // 退出登录 — 清 cookie + 触发登录态事件, 视图监听器会自动刷新.
      vscode.commands.registerCommand('xiaoheihe.logout', async () => {
        if (!auth.isLoggedIn()) {
          vscode.window.showInformationMessage('小黑盒: 当前未登录, 无需退出.');
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          '确定要退出小黑盒登录吗? 主页将回到本地混排模式 (内容相对固定).',
          { modal: true },
          '确定退出',
        );
        if (confirm !== '确定退出') return;
        await auth.logout();
      }),
    );

    // ---- 登录态变化 -> 视图自动刷新 ----
    // 用户 importCookie / logout 后, 当前打开的主页要从未登录态切到登录态 (或反过来),
    // 不刷新的话用户得手动点刷新按钮才能看到推荐流, 体验割裂.
    //   - pushLoginState: 通知 webview 更新 👤 按钮状态 (已登录/未登录 UI 差异)
    //   - refresh: 重新拉一页 — 登录态下走推荐接口, 未登录走本地混排
    ctx.subscriptions.push(
      auth.onDidChangeLoginState(async () => {
        view.pushLoginState();
        try {
          await view.refresh();
        } catch (e) {
          // 刷新失败不向上抛 — 用户至少 cookie 已经存了, 下次手动刷新还能恢复
          console.warn('[xiaoheihe] 登录态变化后刷新失败:', e);
        }
      }),
    );

    // 首次推送一次登录态, 让 webview 在初次渲染后就拿到正确的按钮状态
    // (webview 还没 ready 的时候 post 也没事, MainViewProvider 会在 ready 时再补推).
    view.pushLoginState();
  },
};

export default xiaoheiheModule;

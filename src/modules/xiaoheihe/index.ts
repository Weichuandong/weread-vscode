import * as vscode from 'vscode';
import type { Module } from '../../core/Module';
import { XiaoheiheClient } from './api/XiaoheiheClient';
import { XiaoheiheAuthService } from './auth/AuthService';
import { MainViewProvider } from './views/MainViewProvider';
import {
  BUILTIN_SECTIONS,
  HOME_SECTION_META,
  TOPIC_MAP_STORAGE_KEY,
  type XiaoheiheTopicMeta,
} from './types';

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

    // ---- 板块 topicId 自动发现 (v2.2.6) ----
    // 旁路累积 globalState 字典 'xiaoheihe.topicMap' (key 'xiaoheihe.topicMap').
    //   onTopicsDiscovered: 每次 feed 响应里抽出的 topics 合并到字典 (后入覆盖前入)
    //   lookupDiscoveredTopicId: fetchFeed 反查 fallback (硬编码缺失时启用)
    // 设计要点:
    //   - update 用 Promise 但不 await — 不阻塞 feed 主流程; 失败也不抛, 顶多下次
    //     再累积, 不影响业务
    //   - 字典只增不减, 用 spread merge — 同名板块后入字段覆盖前入 (服务端字段更新
    //     立刻生效, 比如换了封面图)
    const readTopicMap = (): Record<string, XiaoheiheTopicMeta> => {
      const m = ctx.raw.globalState.get<Record<string, XiaoheiheTopicMeta>>(
        TOPIC_MAP_STORAGE_KEY,
      );
      // 防御性: globalState 类型不可信 (旧版本脏数据 / 用户瞎改), 校验下结构
      if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
      return m;
    };
    // ---- "全新板块" 一次性提示 (节流) ----
    // 目标: 用户在浏览过程中, 服务端 link.topics 里出现了 BUILTIN_SECTIONS 没列也不在
    // 字典里的全新板块时, 弹一个轻提示告诉用户"发现了一个新游戏圈, 要切过去看看吗?"
    //
    // 节流原则 (避免打扰):
    //   - 一次 feed 响应可能批量发现 N 个新板块 → 攒到一起, 用 debounce 延后 3s 再弹
    //     (3s 内累积的新板块合并到一条通知)
    //   - 通知冷却 30 分钟: 一次提示后 30 分钟内即使再发现新板块也不再弹
    //     (用户可能就是不想要这种打扰)
    //   - 全新板块的判定标准: 同时不在 BUILTIN_SECTIONS (按 topicId) 也不在字典 (按 name)
    //     — 任一命中说明已知, 不算新
    //
    // 用户操作:
    //   - "切换查看": QuickPick 选具体哪个 → 自动启用 + 切板块
    //   - "忽略": 关闭本次通知, 仍正常累积字典, 下次冷却结束后再提示
    let lastNotifyAt = 0;
    const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
    let pendingNewTopics: XiaoheiheTopicMeta[] = [];
    let notifyTimer: NodeJS.Timeout | undefined;

    const builtinTopicIds = new Set<string>(
      BUILTIN_SECTIONS.map((s) => s.topicId).filter((x): x is string => !!x),
    );

    const tryNotifyNewTopics = (): void => {
      if (pendingNewTopics.length === 0) return;
      const now = Date.now();
      if (now - lastNotifyAt < NOTIFY_COOLDOWN_MS) {
        // 冷却中, 丢弃本次 (字典已经累积过了, 不会丢数据)
        pendingNewTopics = [];
        return;
      }
      lastNotifyAt = now;
      const fresh = pendingNewTopics.slice();
      pendingNewTopics = [];

      // 取前 5 个名字摘要展示, 多了说"... 等 N 个"
      const sampleNames = fresh.slice(0, 5).map((t) => t.name).join('、');
      const suffix = fresh.length > 5 ? ` ... 等 ${fresh.length} 个` : '';
      const msg = `小黑盒: 发现新板块 ${sampleNames}${suffix}, 是否切换查看?`;

      // fire-and-forget — 用户没操作也无所谓
      void vscode.window.showInformationMessage(msg, '切换查看', '忽略').then((pick) => {
        if (pick !== '切换查看') return;
        // 复用 switchToTopic 命令的 QuickPick 流程, 但只列本次新发现的
        void vscode.commands.executeCommand('xiaoheihe.switchToTopic', {
          presetTopics: fresh,
        });
      });
    };

    const onTopicsDiscovered = (topics: XiaoheiheTopicMeta[]): void => {
      if (!topics || topics.length === 0) return;
      const existing = readTopicMap();
      const next: Record<string, XiaoheiheTopicMeta> = { ...existing };
      let changed = 0;
      const newlyDiscovered: XiaoheiheTopicMeta[] = [];
      for (const t of topics) {
        if (!t || !t.name || !t.topicId) continue;
        const prev = next[t.name];
        // "全新" 双重过滤: BUILTIN_SECTIONS 没收录 (按 topicId) 且字典之前也没有 (按 name)
        // — 任一命中说明已知, 不算新发现
        if (!prev && !builtinTopicIds.has(t.topicId)) {
          newlyDiscovered.push(t);
        }
        // 完全相同跳过 (省一次 globalState 写); 任意字段不一致就覆盖
        if (
          prev &&
          prev.topicId === t.topicId &&
          prev.picUrl === t.picUrl &&
          prev.appId === t.appId &&
          prev.gameType === t.gameType
        ) {
          continue;
        }
        next[t.name] = t;
        changed++;
      }
      if (changed > 0) {
        // fire-and-forget — Promise 失败也不抛 (旁路逻辑, 不打扰主流程)
        void ctx.raw.globalState.update(TOPIC_MAP_STORAGE_KEY, next).then(
          undefined,
          (e) => {
            console.warn('[xiaoheihe] topicMap globalState 持久化失败:', e);
          },
        );
      }
      // 新板块累积 + debounce 3s 后统一提示 (合并多次累积的发现)
      if (newlyDiscovered.length > 0) {
        // 去重: pendingNewTopics 里可能已经累积过同名板块 (多次 feed 响应都返回同一个)
        const pendingNames = new Set(pendingNewTopics.map((t) => t.name));
        for (const t of newlyDiscovered) {
          if (!pendingNames.has(t.name)) {
            pendingNewTopics.push(t);
            pendingNames.add(t.name);
          }
        }
        if (notifyTimer) clearTimeout(notifyTimer);
        notifyTimer = setTimeout(tryNotifyNewTopics, 3000);
      }
    };
    const lookupDiscoveredTopicId = (key: string): string | undefined => {
      if (!key) return undefined;
      const m = readTopicMap();
      return m[key]?.topicId;
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
      onTopicsDiscovered,
      lookupDiscoveredTopicId,
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

      // 用 QuickPick 选板块 — 命令面板里列所有内置板块 + 主页. 想看更全 (含字典里运行时
      // 发现但 BUILTIN 还没收录的) 板块, 走 xiaoheihe.switchToTopic.
      vscode.commands.registerCommand('xiaoheihe.switchGame', async () => {
        const items = [
          { label: HOME_SECTION_META.label, description: HOME_SECTION_META.id, sectionId: HOME_SECTION_META.id },
          ...BUILTIN_SECTIONS.map((s) => ({
            label: s.label,
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
          onTopicsDiscovered,
          lookupDiscoveredTopicId,
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

      // 切换到任意板块 (含字典里自动发现的 + BUILTIN_SECTIONS 全集 + home).
      //
      // 跟 xiaoheihe.switchGame 的差异:
      //   - switchGame: 只列 BUILTIN_SECTIONS + home, 走老风格命令面板入口
      //   - switchToTopic: 还合并字典里"BUILTIN_SECTIONS 没收录" 的板块, 切过去时
      //     自动启用该板块 (写入 'xiaoheihe.enabledSections'), 配合"被动发现新板块"
      //     场景一气呵成: 用户在通知里点"切换查看" → 直接进入新板块, 不必先去 ⚙ 勾
      //
      // 参数 (可选):
      //   - presetTopics: 限定 QuickPick 候选范围 (来自"新发现通知"调用的场景);
      //     不传则展示字典 + BUILTIN_SECTIONS 全集 (按 label 排序, 字典优先).
      //
      // 命令面板与"新发现通知"共用同一份实现.
      vscode.commands.registerCommand(
        'xiaoheihe.switchToTopic',
        async (opts?: { presetTopics?: XiaoheiheTopicMeta[] }) => {
          // 候选构造:
          //   - 优先: presetTopics (新发现通知场景, 通常 1-5 个)
          //   - 否则: 字典里所有板块 (按 label) + BUILTIN_SECTIONS 全集 (排重)
          //   - 主页 (home) 也加进去 — 命令面板入口用户可能想从这里回主页
          interface PickItem extends vscode.QuickPickItem {
            sectionId?: string;
            topicMeta?: XiaoheiheTopicMeta;
          }

          const items: PickItem[] = [];
          const seenIds = new Set<string>();
          const seenTopicIds = new Set<string>();

          // 内部小工具: 根据 topicMeta 找到/构造对应 sectionId
          //   - 字典里的 topic.topicId 命中 BUILTIN_SECTIONS 时 → 复用内置 id (e.g. 'ow')
          //   - 否则 → 用 't<topicId>' (跟 BUILTIN_SECTIONS 里"话题派生" 命名一致)
          //     这种情况大概率说明 BUILTIN_SECTIONS 没收录, 但字典里有
          //     (新发现 / 用户刚浏览到的小众板块)
          const topicMetaToSectionId = (t: XiaoheiheTopicMeta): string => {
            const builtin = BUILTIN_SECTIONS.find((s) => s.topicId === t.topicId);
            return builtin ? builtin.id : `t${t.topicId}`;
          };

          if (opts && Array.isArray(opts.presetTopics) && opts.presetTopics.length > 0) {
            for (const t of opts.presetTopics) {
              if (!t || !t.name || !t.topicId) continue;
              if (seenTopicIds.has(t.topicId)) continue;
              seenTopicIds.add(t.topicId);
              const sectionId = topicMetaToSectionId(t);
              seenIds.add(sectionId);
              items.push({
                label: t.name,
                description: `topicId=${t.topicId}`,
                detail: '新发现板块',
                sectionId,
                topicMeta: t,
              });
            }
          } else {
            // 全集模式: home + BUILTIN_SECTIONS + 字典剩余
            items.push({
              label: HOME_SECTION_META.label,
              description: HOME_SECTION_META.id,
              detail: '主页推荐 (本地混排)',
              sectionId: HOME_SECTION_META.id,
            });
            seenIds.add(HOME_SECTION_META.id);

            for (const s of BUILTIN_SECTIONS) {
              if (seenIds.has(s.id)) continue;
              seenIds.add(s.id);
              if (s.topicId) seenTopicIds.add(s.topicId);
              items.push({
                label: s.label,
                description: s.id,
                detail: s.topicId ? `topicId=${s.topicId}` : 'APP tag 路径',
                sectionId: s.id,
              });
            }

            // 字典里"BUILTIN_SECTIONS 没收录" 的剩余 — 都是运行时累积出来的小众板块
            const map = readTopicMap();
            for (const t of Object.values(map)) {
              if (!t.topicId || seenTopicIds.has(t.topicId)) continue;
              seenTopicIds.add(t.topicId);
              const sectionId = topicMetaToSectionId(t);
              if (seenIds.has(sectionId)) continue;
              seenIds.add(sectionId);
              items.push({
                label: t.name,
                description: `topicId=${t.topicId}`,
                detail: '运行时发现 (未收录到内置列表)',
                sectionId,
                topicMeta: t,
              });
            }
          }

          if (items.length === 0) {
            vscode.window.showInformationMessage('小黑盒: 无可切换的板块');
            return;
          }

          const picked = await vscode.window.showQuickPick(items, {
            title: '小黑盒 — 切换板块',
            placeHolder: '输入关键词搜索板块名 (中文/英文), 选中后自动启用并切换',
            matchOnDescription: true,
            matchOnDetail: true,
          });
          if (!picked || !picked.sectionId) return;

          // 切换前如果板块还没在 enabled 列表 → 自动加进去 (切板块意图明确)
          //
          // 当前实现: BUILTIN_SECTIONS 已硬编码 133 项 (含字典补全), sectionId 就是
          // 't<id>', findSection 走 BUILTIN_SECTIONS 基本都能命中. 极端情况下字典里
          // 出现 BUILTIN 没收录的全新板块 → view.switchToTopicEnsureEnabled 会弹通知
          // 拒绝切换, 提示用户用 dumpTopicMap 命令导出反馈给维护者补硬编码.
          await view.switchToTopicEnsureEnabled(picked.sectionId, picked.topicMeta);
        },
      ),

      // 导出板块 topicMap 字典 — 把 globalState 里累积的板块全量列表导出.
      //
      // 用途:
      //   - 跟 codewiz / 项目维护者沟通: 复制 JSON 反馈, 帮助把高频板块硬编码进
      //     BUILTIN_SECTIONS (虽然 v2.2.6 已经把 133 个字典内容硬编码了, 但小黑盒
      //     上线新板块时这个能力还有用)
      //   - 调试: 看自动累积的字典里到底有哪些板块, 各板块的 topicId / appId
      //
      // 实现策略 (三合一):
      //   1. 写入剪贴板  → 用户直接 Cmd+V 粘贴到聊天
      //   2. 弹 untitled 文档 (jsonc 语法高亮) → 用户能看 + 二次编辑 + 全选复制
      //   3. showInformationMessage → 弹消息告诉用户两件事都做完了, 写了几条
      //
      // 字典为空时不弹文档 (避免无意义打开空 buffer); v2.2.6 起字典是被动累积的,
      // 用户浏览板块时自动填充, 不需要再手动跑发现命令.
      vscode.commands.registerCommand('xiaoheihe.dumpTopicMap', async () => {
        const map = readTopicMap();
        const count = Object.keys(map).length;
        if (count === 0) {
          vscode.window.showInformationMessage(
            '小黑盒: topicMap 字典为空. 字典通过用户浏览板块时被动累积, 切几个板块刷下列表即可填充.',
          );
          return;
        }

        // 按 topicId 数字升序排序展示 — 跟 BUILTIN_SECTIONS 风格对齐, 看起来更整齐.
        // 也能直观看出小黑盒服务端 topicId 的分布密度 (热门老板块号小, 后期增的号大).
        const sorted = Object.values(map).sort(
          (a, b) => Number(a.topicId) - Number(b.topicId),
        );

        // jsonc 输出 — 注释 + JSON, VSCode 直接给注释高亮. 头部带"统计/时间/key"
        // 三行元信息, 用户截图发出来一眼看全.
        const header = [
          `// 小黑盒板块 topicMap 字典`,
          `// 共 ${count} 个板块, 按 topicId 升序排列`,
          `// 导出时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
          `// 数据源: VSCode globalState key '${TOPIC_MAP_STORAGE_KEY}'`,
          `//`,
          `// v2.2.6 字典通过用户浏览板块时被动累积 (link.topics[] 旁路写入);`,
          `// 如发现 BUILTIN_SECTIONS 没收录的高质量板块, 可复制 JSON 反馈给维护者补硬编码.`,
          ``,
        ].join('\n');
        const content = header + JSON.stringify(sorted, null, 2) + '\n';

        // 1. 同步写剪贴板 (失败不影响后续打开文档)
        let clipboardOk = false;
        try {
          await vscode.env.clipboard.writeText(content);
          clipboardOk = true;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[xiaoheihe] dumpTopicMap 复制剪贴板失败:', e);
        }

        // 2. 弹 untitled 文档 (jsonc 高亮, 不强制保存, 用户关掉就丢)
        try {
          const doc = await vscode.workspace.openTextDocument({
            content,
            language: 'jsonc',
          });
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[xiaoheihe] dumpTopicMap 打开文档失败:', e);
        }

        // 3. 状态消息
        vscode.window.showInformationMessage(
          clipboardOk
            ? `小黑盒: 已导出 ${count} 个板块 (已复制到剪贴板, 同时开了一份 jsonc 预览)`
            : `小黑盒: 已导出 ${count} 个板块 (剪贴板写入失败, 请从打开的文档复制)`,
        );
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

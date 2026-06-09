import * as vscode from 'vscode';

/**
 * 注入给每个模块的运行时上下文。
 *
 * 设计目标:
 *   - 模块只通过这个对象访问框架能力, 屏蔽 vscode.ExtensionContext 的大表面积
 *   - 自动按模块 id 加前缀, 防止多个模块之间的 key / 命令名冲突
 *   - subscriptions 收口, 简化资源管理
 *
 * 命名约定 (假设模块 id = "weread"):
 *   - ctx.getConfig('requestTimeout', 15000)
 *       → vscode.workspace.getConfiguration('weread').get('requestTimeout', 15000)
 *   - ctx.secrets.get('cookie')
 *       → vscode SecretStorage key = 'weread.cookie'
 *   - ctx.state.get('lastRead', null)
 *       → globalState key = 'weread.lastRead'
 *   - ctx.registerCommand('importCookie', fn)
 *       → 实际注册的命令名 = 'weread.importCookie'
 *
 * 重要: 出于兼容性考虑, secret / state 的 key **直接使用** `${id}.${key}`,
 * 这刚好和现在硬编码的 'weread.cookie' / 'weread.lastRead' 兼容,
 * 老用户升级到新架构后登录态和缓存都不会丢。
 */
export interface ModuleContext {
  /** 模块 id, 等于 manifest.id */
  readonly id: string;
  /** 模块作用域的展示名, 用于日志前缀 */
  readonly displayName: string;
  /** 原始 ExtensionContext, 某些底层 API (storageUri 等) 需要时透出 */
  readonly raw: vscode.ExtensionContext;
  /**
   * 模块注册的 Disposable 全部收口在这里。
   * 主框架在插件 deactivate 时统一释放 (实际上 vscode 也会自动释放, 这里只是显式管理)。
   */
  readonly subscriptions: vscode.Disposable[];

  /**
   * 模块作用域的 vscode 配置访问。
   * 自动从 `${id}.${key}` 这个配置项读取。
   */
  getConfig<T>(key: string, defaultValue: T): T;

  /**
   * 模块作用域的 SecretStorage 包装。
   * 返回类型沿用 vscode 原生的 Thenable 而不是 Promise — vscode API 全线用 Thenable,
   * 强转 Promise 没有实际收益, 还会导致类型不兼容。
   */
  readonly secrets: {
    get(key: string): Thenable<string | undefined>;
    set(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
  };

  /** 模块作用域的 globalState 包装 */
  readonly state: {
    get<T>(key: string, defaultValue: T): T;
    set(key: string, value: unknown): Thenable<void>;
  };

  /**
   * 注册一个命令。
   * @param name 命令短名, 框架自动补 `${id}.` 前缀
   *
   * 注意: package.json 里贡献的命令名必须和这里加完前缀后的完整名一致,
   * 否则命令面板里点击会找不到 handler。
   */
  registerCommand(name: string, handler: (...args: any[]) => unknown): void;
}

/**
 * 工厂: 给定 ExtensionContext 和模块清单, 产出一个绑定该模块的 ModuleContext。
 */
export function createModuleContext(
  raw: vscode.ExtensionContext,
  manifest: { id: string; displayName: string },
): ModuleContext {
  const { id, displayName } = manifest;
  const prefix = `${id}.`;
  const subs: vscode.Disposable[] = [];

  const ctx: ModuleContext = {
    id,
    displayName,
    raw,
    subscriptions: subs,

    getConfig<T>(key: string, defaultValue: T): T {
      // vscode 的 getConfiguration(section) 已经天然支持按 namespace 取,
      // 这里再加一层是为了让模块代码完全感知不到自己叫什么 id。
      return vscode.workspace.getConfiguration(id).get<T>(key, defaultValue);
    },

    secrets: {
      get: (key) => raw.secrets.get(prefix + key),
      set: (key, value) => raw.secrets.store(prefix + key, value),
      delete: (key) => raw.secrets.delete(prefix + key),
    },

    state: {
      get<T>(key: string, defaultValue: T): T {
        return raw.globalState.get<T>(prefix + key, defaultValue);
      },
      set(key, value) {
        return raw.globalState.update(prefix + key, value);
      },
    },

    registerCommand(name, handler) {
      const full = prefix + name;
      const disposable = vscode.commands.registerCommand(full, handler);
      subs.push(disposable);
      // 同步加入 ExtensionContext 的 subscriptions, 双重保险
      raw.subscriptions.push(disposable);
    },
  };

  return ctx;
}

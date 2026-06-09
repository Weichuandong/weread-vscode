import type { ModuleContext } from './ModuleContext';

/**
 * 模块清单。
 *
 * 每个 "产品" (微信读书 / 知乎 / 小黑盒 ...) 都是一个 Module,
 * id 是它在整个插件里的命名空间, 决定:
 *   - SecretStorage key 前缀 (用于 cookie / token 持久化)
 *   - globalState key 前缀
 *   - 模块作用域的 vscode 配置 namespace
 *   - 命令名前缀 (通过 ctx.registerCommand 自动补)
 *
 * 注意: id 一旦上线就不要改, 否则老用户的登录态 / 配置全丢。
 */
export interface ModuleManifest {
  /** 唯一 id, 例如 'weread' / 'zhihu' / 'xiaoheihe' */
  readonly id: string;
  /** 给人看的名字, 仅出现在日志 / 错误提示里 */
  readonly displayName: string;
}

/**
 * 模块接口。
 *
 * 设计原则:
 *   - activate 拿到的是 ModuleContext (而不是裸的 vscode.ExtensionContext),
 *     模块只能通过框架暴露的能力做事, 拿不到全局副作用通道。
 *   - 所有注册的 Disposable 都丢进 ctx.subscriptions, 主框架负责统一释放,
 *     模块自己不需要写 deactivate (除非有定时器 / 长连接等需要主动 close 的资源)。
 */
export interface Module {
  readonly manifest: ModuleManifest;
  activate(ctx: ModuleContext): Promise<void> | void;
  /** 可选: 用于关闭长连接 / 定时器之类不能靠 Disposable 自动释放的资源 */
  deactivate?(): Promise<void> | void;
}

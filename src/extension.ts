import * as vscode from 'vscode';
import { activateAll, deactivateAll } from './core/ModuleRegistry';

/**
 * 插件总入口。
 *
 * v1.0.x 起改造成多模块框架: 真正的业务逻辑(微信读书 / 后续的知乎、小黑盒等)
 * 各自挂在 src/modules/<id>/ 下, 由 ModuleRegistry 统一拉起。
 * 这里只剩"启动器"一个职责, 不放任何业务代码。
 *
 * 注意: VSCode 的 contributes (views/commands/configuration) 仍然必须静态声明
 * 在根 package.json 中, 所以模块新增/删除时除了改 ALL_MODULES, 还要同步改
 * package.json — 这是 VSCode 本身的限制, 暂无优雅解法。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await activateAll(context);
}

export async function deactivate(): Promise<void> {
  await deactivateAll();
}

import * as vscode from 'vscode';
import type { Module } from './Module';
import { createModuleContext } from './ModuleContext';

import wereadModule from '../modules/weread';
import zhihuModule from '../modules/zhihu';
import xiaoheiheModule from '../modules/xiaoheihe';

/**
 * 所有内置模块的清单。
 *
 * 新增模块时只需要:
 *   1. 在 src/modules/<id>/ 下实现 Module 接口并默认导出
 *   2. 在这里 import 并加入 ALL_MODULES 数组
 *   3. 在根 package.json 的 contributes 里贡献对应的 view / command / configuration
 *
 * 顺序即激活顺序, 单个模块失败不影响其他模块 (见 activateAll)。
 */
const ALL_MODULES: Module[] = [
  wereadModule,
  zhihuModule,
  xiaoheiheModule,
];

/** 已激活的模块, 用于插件 deactivate 时反向清理 */
const activated: Module[] = [];

/**
 * 激活所有模块。
 *
 * 单个模块 activate 失败不影响其他模块, 但会在日志里记录,
 * 这样某个三方接口挂掉时插件不会整体崩溃。
 */
export async function activateAll(extCtx: vscode.ExtensionContext): Promise<void> {
  for (const m of ALL_MODULES) {
    try {
      const modCtx = createModuleContext(extCtx, m.manifest);
      await m.activate(modCtx);
      activated.push(m);
      console.log(`[touchPlus] module activated: ${m.manifest.id}`);
    } catch (e) {
      console.error(`[touchPlus] module activate failed: ${m.manifest.id}`, e);
      vscode.window.showErrorMessage(
        `模块 "${m.manifest.displayName}" 启动失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * 反向卸载所有模块, 只对实现了 deactivate 的模块有效。
 * 普通 Disposable 由 vscode 自动释放, 不需要在这里再清。
 */
export async function deactivateAll(): Promise<void> {
  while (activated.length > 0) {
    const m = activated.pop()!;
    try {
      await m.deactivate?.();
    } catch (e) {
      console.error(`[touchPlus] module deactivate failed: ${m.manifest.id}`, e);
    }
  }
}

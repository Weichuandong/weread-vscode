import * as vscode from 'vscode';
import axios from 'axios';

/**
 * 插件升级检查器。
 *
 * 由于本插件没发到微软 VS Code Marketplace (只发了 Open VSX),
 * 原版 VSCode 用户用 vsix 离线安装后, VSCode 自身永远不会推送升级提示。
 *
 * 这个模块通过启动时主动调一次 Open VSX API 拿最新版本,
 * 跟当前 package.json version 做 semver 对比, 有新版就弹个通知,
 * 让用户点击直接跳到 GitHub Release 页下 vsix。
 *
 * 设计点:
 *  - 网络失败 / 接口异常一律静默 (绝不打扰用户)
 *  - 用 globalState 记 "已跳过的版本号", 用户选了 "不再提醒此版本" 同一版本不再弹
 *  - 用户在 settings 关掉 weread.checkForUpdates 直接 return
 *  - 调用方 (extension.ts) 不需要 await, 失败也不影响 activate
 */

const OPEN_VSX_LATEST_API =
  'https://open-vsx.org/api/weichuandong/weread-vscode/latest';
const RELEASE_URL_LATEST =
  'https://github.com/Weichuandong/weread-vscode/releases/latest';
const SKIPPED_VERSION_KEY = 'weread.updateChecker.skippedVersion';

interface OpenVsxLatestResponse {
  version?: string;
}

/**
 * 把 semver 字符串解析为 [major, minor, patch] 三元组。
 * 兼容: "1.0.2" / "v1.0.2" / "1.0.2-beta.1" (preRelease 后缀被忽略)
 * 解析失败返回 null。
 */
function parseSemver(s: string | undefined | null): [number, number, number] | null {
  if (!s) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * a > b ? 1 : a === b ? 0 : -1
 */
function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/**
 * 启动入口。调用方不 await, 让它在后台跑。
 */
export async function checkForUpdates(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration('weread');
    if (!cfg.get<boolean>('checkForUpdates', true)) {
      return;
    }

    const currentVersion = (context.extension.packageJSON?.version as string) ?? '0.0.0';
    const currentTriple = parseSemver(currentVersion);
    if (!currentTriple) return;

    const res = await axios.get<OpenVsxLatestResponse>(OPEN_VSX_LATEST_API, {
      timeout: 5000,
      headers: { Accept: 'application/json' },
    });
    const latestVersion = res.data?.version;
    const latestTriple = parseSemver(latestVersion);
    if (!latestTriple || !latestVersion) return;

    // 没新版 → 静默
    if (compareSemver(latestTriple, currentTriple) <= 0) return;

    // 用户已选 "不再提醒此版本" → 静默
    const skipped = context.globalState.get<string>(SKIPPED_VERSION_KEY);
    if (skipped === latestVersion) return;

    const VIEW = '查看新版';
    const SKIP = '不再提醒此版本';
    const LATER = '稍后再说';

    const pick = await vscode.window.showInformationMessage(
      `微信读书插件有新版本可用：${currentVersion} → ${latestVersion}（点击查看下载）`,
      VIEW,
      SKIP,
      LATER,
    );

    if (pick === VIEW) {
      await vscode.env.openExternal(vscode.Uri.parse(RELEASE_URL_LATEST));
    } else if (pick === SKIP) {
      await context.globalState.update(SKIPPED_VERSION_KEY, latestVersion);
    }
    // LATER / 关掉通知: 什么都不做, 下次启动还会弹
  } catch (err) {
    // 任何异常都吞掉 (网络/超时/接口结构变了/etc), 不打扰用户
    console.log('[weread-vscode] checkForUpdates skipped:', err);
  }
}

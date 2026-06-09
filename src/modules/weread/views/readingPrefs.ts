import * as vscode from 'vscode';

/**
 * 阅读视图的"字体/排版"用户偏好。
 *
 * 设计要点:
 *   - 全部用**离散档位**而非无极滑块, 跟微信读书 App 一致 — 离散值都是
 *     "精挑细选的好看值", 用户怎么调都不会调出难看的排版。
 *   - 用 CSS 变量 (--rd-*) 驱动 .reading 样式, popover 改值时前端直接
 *     `documentElement.style.setProperty` 实时生效, 零闪烁、不 reload webview。
 *   - 存到 globalState (不是 WorkspaceConfiguration), 因为阅读偏好是
 *     "用户口味", 不该跟项目走, 也无需加密。
 *
 * 5 个能力(对齐微信读书 App 设置面板核心):
 *   1) fontSize          字号 (px, 7 档)
 *   2) lineHeight        行距 (倍率, 3 档)
 *   3) paragraphSpacing  段距 (em, 3 档)
 *   4) pageWidth         页边宽度 (px 或 'full' 跟随窗口, 4 档)
 *   5) fontFamily        字体族 (4 选项, key 而非完整 stack, 在前端映射)
 */

export type FontFamilyKey = 'sans' | 'serif' | 'mono' | 'editor';

/** pageWidth: 数字 = 阅读卡片最大宽度(px); 'full' = 占满 reader-body */
export type PageWidth = number | 'full';

export interface ReadingPrefs {
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  pageWidth: PageWidth;
  fontFamily: FontFamilyKey;
}

export const DEFAULT_READING_PREFS: ReadingPrefs = {
  fontSize: 15,
  lineHeight: 1.85,
  paragraphSpacing: 0.95,
  pageWidth: 720,
  fontFamily: 'serif',
};

/** 字号可选档(px), 跨度 12→22 共 7 档, 覆盖窄/宽侧栏典型阅读需求 */
export const FONT_SIZE_STEPS: number[] = [12, 13, 14, 15, 16, 18, 20, 22];

export const LINE_HEIGHT_STEPS: { label: string; value: number }[] = [
  { label: '紧凑', value: 1.5 },
  { label: '标准', value: 1.85 },
  { label: '宽松', value: 2.2 },
];

export const PARAGRAPH_SPACING_STEPS: { label: string; value: number }[] = [
  { label: '紧凑', value: 0.5 },
  { label: '标准', value: 0.95 },
  { label: '宽松', value: 1.6 },
];

export const PAGE_WIDTH_STEPS: { label: string; value: PageWidth }[] = [
  { label: '窄', value: 560 },
  { label: '标准', value: 720 },
  { label: '宽', value: 900 },
  { label: '跟随', value: 'full' },
];

/**
 * 字体族选项。`stack` 是完整 CSS font-family 串, 给前端 setProperty 用。
 *
 * 选型说明:
 *   - sans   黑体系: PingFang/微软雅黑/系统默认, 现代屏阅读最清晰, 短文本好用
 *   - serif  宋体系: 长篇小说"读书味"最浓的选择(默认), 对应微信读书"宋体"
 *   - mono   等宽:   程序员场景偶尔用, 排版规整, 但中文等宽显示一般
 *   - editor 跟随 VSCode 编辑器字体, 让阅读跟编码"无缝", 一些极客用户喜欢
 */
export const FONT_FAMILY_STEPS: {
  key: FontFamilyKey;
  label: string;
  stack: string;
}[] = [
  {
    key: 'sans',
    label: '黑体',
    stack:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif',
  },
  {
    key: 'serif',
    label: '宋体',
    stack:
      '-apple-system, "Songti SC", "STSong", "Source Han Serif SC", "Noto Serif SC", "PingFang SC", Georgia, serif',
  },
  {
    key: 'mono',
    label: '等宽',
    stack: '"SF Mono", Menlo, Consolas, "Source Code Pro", "PingFang SC", monospace',
  },
  {
    key: 'editor',
    label: '编辑器',
    stack: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
  },
];

const GLOBAL_STATE_KEY = 'weread.readingPrefs.v1';

/**
 * 从 globalState 读取偏好, 缺字段用 DEFAULT 兜底。
 *
 * 为什么手动按字段 merge 而不是 `{ ...DEFAULT, ...saved }`?
 *   存储里可能因为旧版本残留 / 用户手动改 settings 出现 null / 非法类型 / NaN,
 *   一旦扩散到 CSS 变量会导致整页正文消失, 比 reset 体验更糟。
 *   这里按字段做"白名单 + 范围校验", 任何不合法值直接回落到默认。
 */
export function loadReadingPrefs(context: vscode.ExtensionContext): ReadingPrefs {
  const raw =
    context.globalState.get<Partial<ReadingPrefs>>(GLOBAL_STATE_KEY) ?? {};
  return {
    fontSize: FONT_SIZE_STEPS.includes(raw.fontSize as number)
      ? (raw.fontSize as number)
      : DEFAULT_READING_PREFS.fontSize,
    lineHeight: LINE_HEIGHT_STEPS.some((s) => s.value === raw.lineHeight)
      ? (raw.lineHeight as number)
      : DEFAULT_READING_PREFS.lineHeight,
    paragraphSpacing: PARAGRAPH_SPACING_STEPS.some(
      (s) => s.value === raw.paragraphSpacing,
    )
      ? (raw.paragraphSpacing as number)
      : DEFAULT_READING_PREFS.paragraphSpacing,
    pageWidth: PAGE_WIDTH_STEPS.some((s) => s.value === raw.pageWidth)
      ? (raw.pageWidth as PageWidth)
      : DEFAULT_READING_PREFS.pageWidth,
    fontFamily: FONT_FAMILY_STEPS.some((s) => s.key === raw.fontFamily)
      ? (raw.fontFamily as FontFamilyKey)
      : DEFAULT_READING_PREFS.fontFamily,
  };
}

export async function saveReadingPrefs(
  context: vscode.ExtensionContext,
  prefs: ReadingPrefs,
): Promise<void> {
  await context.globalState.update(GLOBAL_STATE_KEY, prefs);
}

/**
 * 把 prefs 转成 CSS 变量值对, 用于:
 *   1) buildHtml 注入 <style id="rd-vars">:root { ... }</style> 给首屏
 *   2) 前端 popover 调档时 setProperty 实时更新
 *
 * 注意 pageWidth='full' 没有"上限宽度"概念, 用 100% (实际由 reader-body padding 决定可视宽);
 * 数字情况下转 px 即可。
 */
export function prefsToCssVars(prefs: ReadingPrefs): Record<string, string> {
  const family =
    FONT_FAMILY_STEPS.find((s) => s.key === prefs.fontFamily)?.stack ??
    FONT_FAMILY_STEPS[1].stack;
  const pageWidthCss =
    prefs.pageWidth === 'full' ? '100%' : `${prefs.pageWidth}px`;
  return {
    '--rd-font-size': `${prefs.fontSize}px`,
    '--rd-line-height': String(prefs.lineHeight),
    '--rd-paragraph-spacing': `${prefs.paragraphSpacing}em`,
    '--rd-page-width': pageWidthCss,
    '--rd-font-family': family,
  };
}

/** 渲染成 <style>:root { ... }</style> 片段(供 buildHtml 拼接) */
export function renderReadingPrefsCssBlock(prefs: ReadingPrefs): string {
  const lines = Object.entries(prefsToCssVars(prefs))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `<style id="rd-vars">:root {\n${lines}\n}</style>`;
}

/**
 * 合并 patch (来自前端 popover 单字段更新) 并校验。
 *
 * 任何不在档位表里的值都被忽略, 保持原值不变 — 这是前端 popover 出 bug
 * 误传非法值时的最后一道防线。
 */
export function mergeReadingPrefs(
  prev: ReadingPrefs,
  patch: Partial<ReadingPrefs>,
): ReadingPrefs {
  const next: ReadingPrefs = { ...prev };
  if (
    typeof patch.fontSize === 'number' &&
    FONT_SIZE_STEPS.includes(patch.fontSize)
  ) {
    next.fontSize = patch.fontSize;
  }
  if (
    typeof patch.lineHeight === 'number' &&
    LINE_HEIGHT_STEPS.some((s) => s.value === patch.lineHeight)
  ) {
    next.lineHeight = patch.lineHeight;
  }
  if (
    typeof patch.paragraphSpacing === 'number' &&
    PARAGRAPH_SPACING_STEPS.some((s) => s.value === patch.paragraphSpacing)
  ) {
    next.paragraphSpacing = patch.paragraphSpacing;
  }
  if (
    (typeof patch.pageWidth === 'number' || patch.pageWidth === 'full') &&
    PAGE_WIDTH_STEPS.some((s) => s.value === patch.pageWidth)
  ) {
    next.pageWidth = patch.pageWidth;
  }
  if (
    typeof patch.fontFamily === 'string' &&
    FONT_FAMILY_STEPS.some((s) => s.key === patch.fontFamily)
  ) {
    next.fontFamily = patch.fontFamily;
  }
  return next;
}

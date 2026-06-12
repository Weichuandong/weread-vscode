/**
 * 公共 webview 滚动快捷键 (keyboard scroll).
 *
 * 提供一个字符串生成函数 getKeyboardScrollScript(), 由各模块 (weread / xiaoheihe / zhihu)
 * 的 webview 内联拼装. 自带 IIFE 包裹, 直接放进 <script> 即可, 兼容 nonce / unsafe-inline
 * 两种 CSP 策略, 不污染全局.
 *
 * 行为约定 (跟用户 v0.0.x 反馈对齐):
 *   - ArrowUp / ArrowDown — 平滑滚动一段固定距离 (~100px, 跟 webview 原生方向键滚动手感
 *     接近, 但走 smooth 平滑过渡比原生 jump 更顺眼). 历史上试过 35% 视高方案, 用户反馈
 *     "全屏在动" / "一下翻飞一大段" — 太多. 100px 约 4-5 行正文, "小步走" 体感.
 *   - Space               — 平滑滚到 *最底部* (跟 web 端"按 End 翻底"等价, 配合楼中楼场景
 *     长帖快速跳到评论尾巴, 或刷长贴时快速跳过中段)
 *   - Shift + Space       — 平滑滚到 *最顶部* (跟 Space 配对的反向能力, 免得只能下不能上;
 *     用户既然把 Space 作为"翻底"的肌肉记忆, 加 Shift 反向也符合 Web 通行 PageDown/PageUp 一对
 *     的直觉)
 *
 * 不接管的场景 (避免劫持用户其它意图):
 *   1) 焦点在 input / textarea / select / contenteditable — 不能截走文本输入相关按键
 *   2) 带 Ctrl / Meta / Alt 修饰键 — 留给系统快捷键 (例如 Cmd+↑ 跳行首, Alt+→ 浏览器前进)
 *   3) lightbox 模态打开中 — getImageLightboxScript 已经在 modal 内自处理键盘 (Esc/+/-/0/←/→),
 *      通用脚本应让位, 否则放大图时按 Space 会同时触发"看图模态滚不动" + "底层正文翻到底" 双效
 *   4) weread 阅读 tab (`.reader-body` 存在) — 现有 setupReaderShortcuts 有更精细的章节切换 +
 *      翻页 60px 余量逻辑, 通用脚本不要覆盖. 其它 weread tab (书架/笔记) 仍可用通用脚本.
 *
 * 焦点说明:
 *   webview 的 keydown 只有在 "webview 整体获得焦点" 后才会触发 (用户点击侧栏任意位置即可,
 *   不必专门点正文). 这是 VSCode webview 的标准行为, 不强制 focus 是为了不抢用户编辑器/终端
 *   焦点.
 */
export function getKeyboardScrollScript(): string {
  return /* js */ `
(function bootKeyboardScroll() {
  // ----- 工具函数 -----

  /**
   * 是否当前焦点在文本输入控件 — 避免截走 input/textarea 的方向键 / 空格.
   * contentEditable 也归入这一类 (例如 toc 搜索框 / 富文本编辑器).
   */
  function isTypingTarget(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable) return true;
    return false;
  }

  /** lightbox 模态当前是否打开 — 打开中让 imageLightbox 自处理 ←/→/Esc/+/-/0, 通用脚本不抢. */
  function isLightboxOpen() {
    var ov = document.getElementById('wd-lightbox');
    return !!(ov && ov.classList.contains('wd-lightbox-open'));
  }

  /**
   * weread 阅读 tab 是否在前 — 用 .reader-body 作为标志位 (只有阅读 tab 的章节正文容器
   * 会渲染这个 class). 存在则让 setupReaderShortcuts 自处理 ↑↓/Space/←→/Home/End,
   * 通用脚本完全 return.
   */
  function isWereadReaderActive() {
    return !!document.querySelector('.reader-body');
  }

  /**
   * 单步固定距离 — 100px (~4-5 行正文), "小步走" 体感.
   * 故意不按视高百分比算: 视高大的屏幕 35% 已经 300+px, 一按方向键像翻飞一大段,
   * 跟"小步走"的预期相悖 (用户反馈). 固定 100px 在 600~2000px 视高下手感一致.
   */
  function computeStep() {
    return 100;
  }

  /**
   * 平滑滚动一段距离 (正数往下, 负数往上).
   * 兜底: 老环境不支持 ScrollOptions 时回退到 window.scrollBy(x, y).
   */
  function scrollByPx(dy) {
    try {
      window.scrollBy({ top: dy, left: 0, behavior: 'smooth' });
    } catch (e) {
      window.scrollBy(0, dy);
    }
  }

  /** 平滑滚到页面顶/底. 用 document.documentElement.scrollHeight 拿当前文档总高. */
  function scrollToEdge(direction) {
    var top = direction > 0
      ? (document.documentElement.scrollHeight || document.body.scrollHeight || 0)
      : 0;
    try {
      window.scrollTo({ top: top, left: 0, behavior: 'smooth' });
    } catch (e) {
      window.scrollTo(0, top);
    }
  }

  // ----- 监听 -----

  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (isLightboxOpen()) return;
    if (isWereadReaderActive()) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        scrollByPx(computeStep());
        break;
      case 'ArrowUp':
        e.preventDefault();
        scrollByPx(-computeStep());
        break;
      case ' ': // Space — 一键翻到最底; Shift+Space 翻到最顶
      case 'Spacebar': // 老 Edge / IE 的 e.key 值兜底
        e.preventDefault();
        scrollToEdge(e.shiftKey ? -1 : 1);
        break;
    }
  });
})();
`;
}

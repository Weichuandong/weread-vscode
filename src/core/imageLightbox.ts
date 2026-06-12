/**
 * 公共图片放大查看器 (image lightbox).
 *
 * 提供三个字符串生成函数, 供各模块 (weread / xiaoheihe / zhihu) 的 webview 内联拼装:
 *   - getImageLightboxCss():    返回 CSS 片段 (不含 <style> 包裹).
 *   - getImageLightboxHtml():   返回 modal DOM 字符串, 应追加到 <body> 末尾.
 *   - getImageLightboxScript(): 返回 JS 片段 (自带 IIFE 包裹), 直接放进现有 <script> 即可,
 *                               兼容 nonce / unsafe-inline 两种 CSP 策略.
 *
 * 设计要点:
 *
 * 1. 极小侵入 — 各模块只需在原有 webview 字符串末尾 append CSS / HTML / Script 三段,
 *    不改动现有 DOM / 渲染逻辑. 触发方式靠全局事件委托, 任何 <img> 都默认可放大,
 *    不需要给图片加 class.
 *
 * 2. 黑名单机制 — 头像 / 小封面 / 工具栏图标这类点击后弹大图毫无意义的小图必须排除:
 *      - 类名命中: .comment-avatar / .wp-avatar / .rv-avatar / .icon-btn img / .cover / .weread-footnote-icon
 *      - 自然尺寸 < 60px (头像 fallback / 表情 / inline 小图)
 *      - 显式标 data-no-lightbox 属性的 (业务方关闭)
 *
 * 3. CSP 兼容 — 不使用任何 inline 事件 (on*) 与外链资源, 全部走 addEventListener,
 *    在 zhihu / xiaoheihe 的 `script-src 'nonce-xxx'` 严格策略下也能跑.
 *
 * 4. 交互细节 (跟 weread / 知乎 H5 看图体验对齐):
 *      - 点 <img> / 占位 → 打开 modal, 显示原图;
 *      - 滚轮缩放, 以鼠标位置为缩放原点 (放大 PDF 阅读器同款体验);
 *      - 拖拽平移 (放大态下 cursor: grab);
 *      - 双击切换 1x ↔ 2x;
 *      - 工具栏: 关闭 × / 缩小 − / 还原 ⤢ / 放大 + ;
 *      - 键盘: Esc 关 / + / - 缩放 / 0 还原;
 *      - 任意点击遮罩空白处关闭.
 *
 * 5. 不依赖具体模块状态, 也不调用 vscode.postMessage — 纯前端体验, 装上即用.
 */

/**
 * 在多模块共用的 lightbox class 名上加 wd- 前缀 (weread / xhh / zhihu 的 d, 寓意"放大窗")
 * 避免跟各模块业务 CSS class 冲突.
 */
const CLASS_OVERLAY = 'wd-lightbox-overlay';
const CLASS_STAGE = 'wd-lightbox-stage';
const CLASS_IMG = 'wd-lightbox-img';
const CLASS_TOOLBAR = 'wd-lightbox-toolbar';
const CLASS_BTN = 'wd-lightbox-btn';
const CLASS_OPEN = 'wd-lightbox-open';
const CLASS_DRAGGING = 'wd-lightbox-dragging';

/**
 * lightbox 模态层的 CSS.
 *
 * 注意 z-index 取 9999 — 各模块本身的抽屉 / banner 一般不超过 200,
 * 这里给一个明显大的值保证 lightbox 始终在最上 (微信读书的 toc 抽屉是 100, 知乎设置 modal 50).
 *
 * `body.wd-lightbox-open` 用来 (1) 锁滚动 (2) 区分图片可放大的鼠标样式.
 * cursor: zoom-in 加在所有 <img> 上, 视觉上提示"可放大", 黑名单 class 显式还原.
 */
export function getImageLightboxCss(): string {
  return /* css */ `
/* ============ 图片放大查看器 (公共) ============ */
img { cursor: zoom-in; }
/* 黑名单: 头像 / 小封面 / 工具按钮图标 / 脚注小图标 — 这些点了弹大图没意义, 还原默认指针 */
img.comment-avatar,
img.wp-avatar,
img.rv-avatar,
img.cover,
img.weread-footnote-icon,
.icon-btn img,
img[data-no-lightbox] {
  cursor: default;
}

body.${CLASS_OPEN} {
  overflow: hidden;
}

.${CLASS_OVERLAY} {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.92);
  display: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* 用户可以选取/拖拽 — 我们要的是"看图", 不要让浏览器自带的图像拖拽行为干扰平移 */
  -webkit-user-select: none;
  user-select: none;
  /* 进场动画 (opacity 即可, 缩放感受由内部 img transform 控制) */
  opacity: 0;
  transition: opacity 0.18s ease-out;
}
.${CLASS_OVERLAY}.${CLASS_OPEN} {
  display: flex;
  opacity: 1;
}

.${CLASS_STAGE} {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: zoom-out;
}
.${CLASS_STAGE}.${CLASS_DRAGGING} {
  cursor: grabbing;
}

.${CLASS_IMG} {
  /* transform 已经做了缩放/平移, 这里把固有尺寸约束在视口内, 不让原图把模态撑爆 */
  max-width: 92vw;
  max-height: 88vh;
  width: auto;
  height: auto;
  object-fit: contain;
  /* 这里用 transform 而不是 top/left, 利用 GPU 合成层, 缩放/平移更顺滑 */
  transform-origin: 0 0;
  will-change: transform;
  /* 防止图片自身被浏览器原生拖出 (拖出时会变成幽灵图, 干扰平移) */
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: auto;
  /* 加载占位时的微弱框, 避免大图加载期间一片黑 */
  background: rgba(255, 255, 255, 0.04);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
  border-radius: 2px;
}
/* 放大后允许拖拽平移 — 鼠标样式提示可抓 */
.${CLASS_STAGE}[data-zoomed="1"] .${CLASS_IMG} {
  cursor: grab;
}
.${CLASS_STAGE}[data-zoomed="1"].${CLASS_DRAGGING} .${CLASS_IMG} {
  cursor: grabbing;
}

.${CLASS_TOOLBAR} {
  position: absolute;
  top: 14px;
  right: 14px;
  display: flex;
  gap: 6px;
  padding: 4px;
  background: rgba(32, 32, 32, 0.72);
  border-radius: 8px;
  z-index: 2;
}
.${CLASS_BTN} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.88);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  font-family: inherit;
  transition: background 0.12s ease;
}
.${CLASS_BTN}:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.${CLASS_BTN}:active {
  background: rgba(255, 255, 255, 0.18);
}

/* 左下角的"缩放百分比"提示, 给用户一个直观的反馈 */
.wd-lightbox-scale-tip {
  position: absolute;
  left: 16px;
  bottom: 16px;
  padding: 3px 9px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.78);
  background: rgba(32, 32, 32, 0.6);
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  letter-spacing: 0.03em;
}

/* 左右两侧的"上一张/下一张"导航按钮 — 仅当同帖子内 >1 张图时显示 (JS 控制 hidden) */
.wd-lightbox-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 64px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: rgba(32, 32, 32, 0.62);
  color: rgba(255, 255, 255, 0.86);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 28px;
  line-height: 1;
  font-family: inherit;
  z-index: 2;
  transition: background 0.12s ease, color 0.12s ease, opacity 0.12s ease;
}
.wd-lightbox-nav:hover {
  background: rgba(48, 48, 48, 0.88);
  color: #fff;
}
.wd-lightbox-nav:active {
  background: rgba(64, 64, 64, 0.95);
}
.wd-lightbox-nav[disabled],
.wd-lightbox-nav.wd-lightbox-nav-hidden {
  opacity: 0;
  pointer-events: none;
}
.wd-lightbox-nav-prev { left: 14px; }
.wd-lightbox-nav-next { right: 14px; }

/* 顶部居中的"X / N"计数, 同帖多图时给用户一个"我在第几张"的明确反馈.
   位置故意避开右上工具栏 (top:14 right:14), 居中既显眼又不抢工具栏空间. */
.wd-lightbox-counter {
  position: absolute;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 10px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.86);
  background: rgba(32, 32, 32, 0.62);
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
  pointer-events: none;
  z-index: 2;
}
`;
}

/**
 * lightbox 的 modal DOM 结构. 默认 display:none, JS 控制 .wd-lightbox-open 切换显隐.
 *
 * 工具栏按钮的图标用纯字符 (Unicode 数学符号), 不依赖任何字体图标库:
 *   −   U+2212 减号 (比 ASCII 的 - 更粗更协调)
 *   +   ASCII 加号
 *   ⤢   U+2922 双向箭头 (1:1 还原)
 *   ×   U+00D7 乘号 (关闭)
 */
export function getImageLightboxHtml(): string {
  return /* html */ `
<div class="${CLASS_OVERLAY}" id="wd-lightbox" role="dialog" aria-modal="true" aria-hidden="true">
  <div class="${CLASS_STAGE}" data-zoomed="0">
    <img class="${CLASS_IMG}" alt="" referrerpolicy="no-referrer" draggable="false" />
    <button type="button" class="wd-lightbox-nav wd-lightbox-nav-prev wd-lightbox-nav-hidden" data-act="prev" title="上一张 (←)" aria-label="上一张">‹</button>
    <button type="button" class="wd-lightbox-nav wd-lightbox-nav-next wd-lightbox-nav-hidden" data-act="next" title="下一张 (→)" aria-label="下一张">›</button>
    <div class="wd-lightbox-counter" hidden></div>
    <div class="${CLASS_TOOLBAR}">
      <button type="button" class="${CLASS_BTN}" data-act="zoom-out" title="缩小 (-)">−</button>
      <button type="button" class="${CLASS_BTN}" data-act="reset" title="还原 (0)">⤢</button>
      <button type="button" class="${CLASS_BTN}" data-act="zoom-in" title="放大 (+)">+</button>
      <button type="button" class="${CLASS_BTN}" data-act="close" title="关闭 (Esc)">×</button>
    </div>
    <div class="wd-lightbox-scale-tip" hidden></div>
  </div>
</div>
`;
}
   
/**
 * lightbox 行为脚本. 完全自包含 IIFE, 不污染全局.
 *
 * 失败兜底: 任何 querySelector 拿不到节点 → 整段直接 return, 不抛错 (老 webview html
 * 里没注入 modal HTML 时也不会让外部业务 JS 跟着崩).
 *
 * 滚轮缩放原点 ── 关键算法:
 *   想要"放大时鼠标指着的那个像素位置在屏幕上保持不动",
 *   推导: 设当前 scale=s, translate=(tx,ty), 鼠标视口坐标=(mx,my),
 *   则鼠标对应到图片本地坐标 = ((mx - origin.x - tx) / s, ...).
 *   缩放到新 scale s' 后要保持鼠标位置不动, 新 translate:
 *     tx' = mx - origin.x - (mx - origin.x - tx) * s' / s
 *   把 transform-origin 设成 0 0 (而不是默认 center), 数学最简洁.
 *   stage 用 flex center 把 img 居中, 然后我们把"未缩放图片左上角的视口坐标" 作 origin 测算.
 */
export function getImageLightboxScript(): string {
  return /* js */ `
(function bootImageLightbox() {
  // 关键: 各模块的 <script> 标签可能出现在 #wd-lightbox modal HTML 的*前面*
  // (例如 zhihu / xiaoheihe 都是 <script> 在 <body> 末尾, 我们的 modal HTML 紧跟其后).
  // body 内联脚本是同步执行的, 此时下面的兄弟节点还没被 parser 解析进 DOM,
  // 直接 getElementById('wd-lightbox') 会拿到 null → setup 静默 return → 整个 lightbox 失效.
  // 用 DOMContentLoaded 兜底, 调用方就不用关心注入顺序了.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupImageLightbox, { once: true });
  } else {
    setupImageLightbox();
  }

function setupImageLightbox() {
  var overlay = document.getElementById('wd-lightbox');
  if (!overlay) return;
  var stage = overlay.querySelector('.${CLASS_STAGE}');
  var img = overlay.querySelector('.${CLASS_IMG}');
  var toolbar = overlay.querySelector('.${CLASS_TOOLBAR}');
  var tip = overlay.querySelector('.wd-lightbox-scale-tip');
  var prevBtn = overlay.querySelector('.wd-lightbox-nav-prev');
  var nextBtn = overlay.querySelector('.wd-lightbox-nav-next');
  var counter = overlay.querySelector('.wd-lightbox-counter');
  if (!stage || !img || !toolbar || !tip || !prevBtn || !nextBtn || !counter) return;

  // ----- 黑名单 selector: 这些 <img> 不触发 lightbox -----
  // (跟 CSS 里 cursor: default 的列表保持一致)
  var EXCLUDE_SELECTOR = [
    'img.comment-avatar',
    'img.wp-avatar',
    'img.rv-avatar',
    'img.cover',
    'img.weread-footnote-icon',
    '.icon-btn img',
    'img[data-no-lightbox]'
  ].join(',');

  // 同帖图片"分组"的容器选择器, 从最贴近用户感知的"一个帖子"逐级降级到最宽泛的兜底.
  // 命中优先级: 显式 data-image-group > 各模块的卡片/正文容器 > 通用 article/main > body.
  //   - data-image-group: 业务侧可以挂这个属性显式声明"这个范围是一组"
  //   - .card-wrap:       zhihu / xiaoheihe 单个帖子的最外层 (单卡内多张图)
  //   - .reading / .rich-body: weread 章节正文整章作为一组
  //   - article / .detail / .detail-text: 通用文章/正文容器
  //   - body: 兜底, 视为整页一组
  // 选择 closest 而不是 contains, 保证用户在 A 卡里点图, 不会跳到 B 卡的图.
  var GROUP_SELECTOR = [
    '[data-image-group]',
    '.card-wrap',
    '.reading',
    '.rich-body',
    'article',
    '.detail',
    '.detail-text',
    'main',
    'body'
  ].join(',');

  // 小尺寸阈值: 宽或高 < 60px (按渲染尺寸, 拿不到则按 naturalWidth) 视为图标/头像不放大.
  var MIN_TRIGGER_SIZE = 60;

  // ----- 状态 -----
  var scale = 1;            // 当前缩放
  var translateX = 0;       // 当前 translate (img 相对 origin 的位移)
  var translateY = 0;
  var dragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var dragOrigTX = 0;
  var dragOrigTY = 0;
  // 缩放档位 — 跟 PDF 阅读器手感对齐, 0.25 步进, 上限 8x 看清细节, 下限 0.5x 看全景
  var MIN_SCALE = 0.5;
  var MAX_SCALE = 8;

  // ----- 分组导航状态 -----
  // images: 当前帖子内所有可放大的 <img> 元素的 src 列表 (按 DOM 出现顺序)
  // currentIndex: 当前展示的是第几张; close 时清空, open 时重新采集 (保证 DOM 改变后下次 open 重新读取).
  // 故意只缓存 src 字符串而不缓存 element 引用 — 如果用户切换 tab / 重新加载, 老的 element 可能被替换.
  var images = [];
  var currentIndex = -1;

  /** 计算 transform-origin (= 未缩放图片左上角相对 stage 的视口坐标).
      不直接用 img.getBoundingClientRect() — 那已经被 transform 影响了; 要拿"基线位置".
      取巧: 临时把 transform 清空, 测 rect, 再恢复. 这一帧用户感知不到 (同步).
   */
  function getOriginRect() {
    var prev = img.style.transform;
    img.style.transform = '';
    var stageRect = stage.getBoundingClientRect();
    var imgRect = img.getBoundingClientRect();
    img.style.transform = prev;
    return {
      offsetX: imgRect.left - stageRect.left,
      offsetY: imgRect.top - stageRect.top
    };
  }

  function applyTransform() {
    img.style.transform = 'translate(' + translateX + 'px,' + translateY + 'px) scale(' + scale + ')';
    stage.setAttribute('data-zoomed', scale > 1.001 ? '1' : '0');
    tip.hidden = scale < 1.05 && scale > 0.95;
    tip.textContent = Math.round(scale * 100) + '%';
  }

  function reset() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    applyTransform();
  }

  /**
   * 围绕 stage 内某个视口坐标 (px, py) 缩放到 nextScale.
   * 保证 (px,py) 对应的图片像素位置缩放前后在屏幕上保持不动.
   */
  function zoomAt(nextScale, px, py) {
    nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    if (Math.abs(nextScale - scale) < 1e-4) return;
    var stageRect = stage.getBoundingClientRect();
    // 转换到 stage 局部坐标
    var lx = px - stageRect.left;
    var ly = py - stageRect.top;
    var o = getOriginRect();
    // 鼠标位置相对未缩放图左上角的像素偏移 (图片本地坐标)
    var imgLocalX = (lx - o.offsetX - translateX) / scale;
    var imgLocalY = (ly - o.offsetY - translateY) / scale;
    // 缩放后想让该 (imgLocalX, imgLocalY) 仍落在 (lx, ly):
    // newTx = lx - o.offsetX - imgLocalX * nextScale
    translateX = lx - o.offsetX - imgLocalX * nextScale;
    translateY = ly - o.offsetY - imgLocalY * nextScale;
    scale = nextScale;
    applyTransform();
  }

  /** 围绕 stage 中心缩放 — 给键盘 +/- 与工具栏按钮用 */
  function zoomCenter(nextScale) {
    var r = stage.getBoundingClientRect();
    zoomAt(nextScale, r.left + r.width / 2, r.top + r.height / 2);
  }

  /**
   * 判断一个 <img> 节点是否"可放大", 用于点击触发判定 + 分组采集判定 (两处共用同一套过滤逻辑).
   */
  function isLightboxableImg(el) {
    if (!el || el.tagName !== 'IMG') return false;
    if (el.closest && el.closest(EXCLUDE_SELECTOR)) return false;
    if (el.matches && el.matches(EXCLUDE_SELECTOR)) return false;
    var w = el.naturalWidth || el.width || el.clientWidth || 0;
    var h = el.naturalHeight || el.height || el.clientHeight || 0;
    if (w > 0 && h > 0 && w < MIN_TRIGGER_SIZE && h < MIN_TRIGGER_SIZE) return false;
    var s = el.currentSrc || el.src;
    if (!s) return false;
    if (s === '' || s === window.location.href) return false;
    return true;
  }

  /**
   * 围绕 clickedImg 找最近的"帖子容器", 收集容器内所有可放大的图片 src.
   * 同 src 去重 (常见情况: 后端给的占位符与真实 img 是同一张, 或同一帖子里多次出现同图).
   * 返回 { srcs, index }, index 是 clickedImg 在结果数组里的位置 (找不到则 -1).
   */
  function collectGroup(clickedImg) {
    var root = (clickedImg.closest && clickedImg.closest(GROUP_SELECTOR)) || document.body;
    var nodes = root.querySelectorAll('img');
    var seen = Object.create(null);
    var srcs = [];
    var index = -1;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isLightboxableImg(el)) continue;
      var s = el.currentSrc || el.src;
      if (seen[s]) {
        // 同 src 跳过, 但如果命中点击元素仍要把 index 指过去
        if (el === clickedImg) {
          for (var j = 0; j < srcs.length; j++) {
            if (srcs[j] === s) { index = j; break; }
          }
        }
        continue;
      }
      seen[s] = 1;
      if (el === clickedImg) index = srcs.length;
      srcs.push(s);
    }
    return { srcs: srcs, index: index };
  }

  /** 把 #wd-lightbox 内的大图切换到 images[currentIndex], 并刷新导航 UI / 复位 transform. */
  function showCurrent() {
    var src = images[currentIndex];
    if (!src) return;
    if (img.getAttribute('src') !== src) {
      img.setAttribute('src', src);
    }
    reset();
    updateNav();
  }

  /** 翻页. 默认循环 (最后一张右键回到第一张) — 比"到头按钮 disable"更符合相册手感. */
  function navigate(delta) {
    if (!images.length) return;
    if (images.length === 1) return;
    var n = images.length;
    currentIndex = ((currentIndex + delta) % n + n) % n;
    showCurrent();
  }

  /** 同步导航箭头 / 计数 的可见性与文案. 只有一张图时把两侧箭头都隐藏 (.wd-lightbox-nav-hidden). */
  function updateNav() {
    var multi = images.length > 1;
    if (multi) {
      prevBtn.classList.remove('wd-lightbox-nav-hidden');
      nextBtn.classList.remove('wd-lightbox-nav-hidden');
      counter.hidden = false;
      counter.textContent = (currentIndex + 1) + ' / ' + images.length;
    } else {
      prevBtn.classList.add('wd-lightbox-nav-hidden');
      nextBtn.classList.add('wd-lightbox-nav-hidden');
      counter.hidden = true;
      counter.textContent = '';
    }
  }

  /** 入口: 由全局点击委托调用, 传入被点击的 <img> 元素. 内部完成"采集分组 → 定位当前 → 显示模态". */
  function open(clickedImg) {
    if (!clickedImg) return;
    var group = collectGroup(clickedImg);
    if (!group.srcs.length) {
      // 极少出现: clickedImg 自己被 isLightboxableImg 过滤掉 (理论上调用方已检验, 兜底退化为单张)
      var fallback = clickedImg.currentSrc || clickedImg.src;
      if (!fallback) return;
      images = [fallback];
      currentIndex = 0;
    } else {
      images = group.srcs;
      currentIndex = group.index >= 0 ? group.index : 0;
    }
    showCurrent();
    overlay.classList.add('${CLASS_OPEN}');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('${CLASS_OPEN}');
  }

  function close() {
    overlay.classList.remove('${CLASS_OPEN}');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('${CLASS_OPEN}');
    // 清掉分组缓存 — 下次 open 重新按当前 DOM 采集 (用户可能切了帖子)
    images = [];
    currentIndex = -1;
    // 不立即清 src — 关闭瞬间还有 0.18s opacity 动画, 留着 src 让淡出有内容
    // 等下次打开覆盖即可.
  }

  // ----- 全局点击委托: <img> 点击触发 open -----
  // 用 capture 阶段, 比业务 click 处理早执行, 避免被 stopPropagation 拦截.
  // 注意: 必须传"被点击的 <img> element"给 open() — 不能只传 src 字符串,
  // 否则 collectGroup 没法用 closest() 找到帖子容器, 分组就退化成"整页一组".
  document.addEventListener('click', function(ev) {
    if (overlay.classList.contains('${CLASS_OPEN}')) return; // modal 内的点击单独处理
    var t = ev.target;
    if (!isLightboxableImg(t)) return;
    ev.preventDefault();
    ev.stopPropagation();
    open(t);
  }, true);

  // ----- 模态内交互 -----

  // 工具栏 / 关闭
  toolbar.addEventListener('click', function(ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest('button[data-act]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    switch (btn.getAttribute('data-act')) {
      case 'zoom-in':  zoomCenter(scale * 1.25); break;
      case 'zoom-out': zoomCenter(scale / 1.25); break;
      case 'reset':    reset(); break;
      case 'close':    close(); break;
    }
  });

  // 左右切换按钮 — 单独绑定 (按钮在 stage 直接下, 不在 toolbar 里, 故分开)
  prevBtn.addEventListener('click', function(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    navigate(-1);
  });
  nextBtn.addEventListener('click', function(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    navigate(1);
  });

  // 点 stage 的空白 (img 之外) 也算关闭 — modal 通行 UX
  stage.addEventListener('mousedown', function(ev) {
    if (ev.target === stage) {
      // 仅记录, 在 mouseup 时再判定是否关闭 (避免用户拖拽时误关)
      stage.__pendingClose = true;
    } else {
      stage.__pendingClose = false;
    }
  });
  stage.addEventListener('mouseup', function(ev) {
    if (stage.__pendingClose && ev.target === stage && !dragging) {
      close();
    }
    stage.__pendingClose = false;
  });

  // 双击 img 切换 1x ↔ 2x (放大态下双击恢复 1x)
  img.addEventListener('dblclick', function(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (scale > 1.05) {
      reset();
    } else {
      zoomAt(2, ev.clientX, ev.clientY);
    }
  });

  // 滚轮缩放 — 以鼠标当前位置为缩放原点
  overlay.addEventListener('wheel', function(ev) {
    if (!overlay.classList.contains('${CLASS_OPEN}')) return;
    ev.preventDefault();
    var factor = ev.deltaY < 0 ? 1.1 : (1 / 1.1);
    zoomAt(scale * factor, ev.clientX, ev.clientY);
  }, { passive: false });

  // 拖拽平移 (任何缩放级别都允许拖, 不强制只放大态才能拖 — 有时候用户缩到刚好可见也想挪一下)
  img.addEventListener('mousedown', function(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    dragStartX = ev.clientX;
    dragStartY = ev.clientY;
    dragOrigTX = translateX;
    dragOrigTY = translateY;
    stage.classList.add('${CLASS_DRAGGING}');
  });
  document.addEventListener('mousemove', function(ev) {
    if (!dragging) return;
    translateX = dragOrigTX + (ev.clientX - dragStartX);
    translateY = dragOrigTY + (ev.clientY - dragStartY);
    applyTransform();
  });
  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('${CLASS_DRAGGING}');
  });

  // 键盘快捷键 — 仅在 modal 打开时响应, 不抢正文/抽屉的按键
  document.addEventListener('keydown', function(ev) {
    if (!overlay.classList.contains('${CLASS_OPEN}')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    switch (ev.key) {
      case 'Escape':
        ev.preventDefault();
        close();
        break;
      case '+':
      case '=':
        ev.preventDefault();
        zoomCenter(scale * 1.25);
        break;
      case '-':
      case '_':
        ev.preventDefault();
        zoomCenter(scale / 1.25);
        break;
      case '0':
        ev.preventDefault();
        reset();
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        navigate(-1);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        navigate(1);
        break;
    }
  });

  // 窗口尺寸变化时, 重置位置避免 origin 算偏 (图片仍以视口居中重新摆放)
  window.addEventListener('resize', function() {
    if (overlay.classList.contains('${CLASS_OPEN}')) {
      reset();
    }
  });
}
})();
`;
}

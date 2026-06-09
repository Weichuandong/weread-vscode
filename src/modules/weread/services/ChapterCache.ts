import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { ChapterFetchResult, WereadClient } from '../api/WereadClient';
import type { WereadChapter } from '../types';

/**
 * 单本书的 meta 信息 — 与章节内容并存于同一目录的 _meta.json.
 *
 * 存在意义: 缓存目录里只有 bookId / chapterUid (数字串), 没有标题信息;
 * 没有 meta 的话, "可视化已缓存内容" 的命令面板只能显示一串数字, 用户没法识别.
 * 每次 put 章节时顺手 patch 一下 meta, 单文件单本书, 写入成本极低.
 */
interface BookMeta {
  bookId: string;
  bookTitle?: string;
  author?: string;
  /** chapterUid (string) -> 章节标题. 增量累加, 永远不删 (即便章节缓存被 trim 也保留标题映射, 反正占不了多少字节) */
  chapters: Record<string, string>;
  /**
   * 全书章节 uid 顺序快照 — 用于命令面板按"书中真实章节顺序"排序展示.
   * 整体替换式更新 (不增量), 因为章节列表语义是"全书目录在 put 时刻的全量快照".
   * 仅靠 chapterUid 数字升序排不够稳: 不少 EPUB 用非数字 uid / 数字带间隙 / 前言后记乱号.
   */
  chapterOrder?: string[];
  /** 最近一次 patch 时间, 用于 UI 排序参考 */
  lastUpdatedAt: number;
}

/** put 调用方可选传入的 meta — 拿不到就拿不到, 命中时 fallback 到 bookId 字面量 */
export interface ChapterPutMeta {
  bookTitle?: string;
  author?: string;
  chapterTitle?: string;
  /**
   * 全书章节 uid 顺序 (按目录从前到后). 调用方拿得到就传, 让 meta 顺手更新 chapterOrder,
   * 命令面板下钻就能按真实章节顺序展示而非乱序的 uid 数字 / mtime.
   */
  chapterOrder?: string[];
}

/** listAll() 返回的单本书概览, 供命令面板下钻展示 */
export interface CachedBookInfo {
  bookId: string;
  bookTitle?: string;
  author?: string;
  totalSizeKB: number;
  chapters: Array<{
    chapterUid: string;
    chapterTitle?: string;
    sizeKB: number;
    mtimeMs: number;
    /**
     * 章节在书中的目录位置 (0-based). 仅当本书 _meta.json 里有 chapterOrder 时才有值,
     * 否则 undefined — 命令面板会按 (idx → 数字 uid → 字典序) 三层 fallback 排序.
     */
    idx?: number;
  }>;
}

/**
 * 章节内容缓存 — "趁 cookie 还活着, 把后面几章先抓回家"。
 *
 * 设计动机:
 *   weread 的 wr_skey 平均寿命 1~2 小时(详见 WereadClient 顶部注释), 即使我们做了
 *   /web/login/renewal 心跳, 也只是把"会话死亡"概率降到比较低 — 总有用户碰上
 *   "夜里看书突然 -2012, 然后死活续不回来" 的情况。这时如果"接下来 N 章" 已经预先
 *   抓到本地, 即使 cookie 完全失效, 用户仍能继续看下去, 不会被一脚踢回登录页。
 *
 * 缓存粒度: 章节级 (单本书的一章 = 一个 JSON 文件).
 *   存的是 fetchChapterContent 返回的原始 ChapterFetchResult — 不存"prepareChapterHtml
 *   后的成品", 因为成品里嵌了 best bookmarks / underlines, 这些是动态数据, 缓存就过期了.
 *   原始 html/content 是稳定的, 命中缓存后照常走一遍 view 层的 inject/sanitize 即可.
 *
 * 缓存位置: context.globalStorageUri/wereadChapters/{bookId}/{chapterUid}.json
 *   不用 workspaceStorage 因为同一本书在所有工作区共用一份缓存更合理(不绑项目).
 *
 * 容量保护:
 *   - 单本上限 MAX_PER_BOOK 章, 超过按 mtime 删最早访问的
 *   - 全局 (跨书) 没有总量上限 — 实际场景一个章节文件 50~300KB,
 *     即使缓存 50 本书 * 100 章 = 5000 个文件, 总占用也才 ~1GB, 还在用户可接受范围.
 *     若以后真有用户反馈"占太多", 加个 weread.chapterCache.totalMaxMB 配置即可.
 *   - 内存层 MAX_MEM_ENTRIES 控制单次会话热缓存 (避免反复磁盘 IO)
 *
 * 并发与节流:
 *   - prefetchAround 串行抓 (一章接一章), 不并发 — 一是不想给 weread 服务端打喷嚏,
 *     二是 cookie 续命接口被并发请求挤崩反而更早过期 (touchFish 项目踩过同款坑)
 *   - 每章之间留 PREFETCH_GAP_MS 间隙, 给主流程让出"用户手动翻章节" 抢占窗口
 *   - cancelAll() 切书时调用, 通过 token 自检让后续 await 结果被丢弃
 *
 * 不缓存的情况:
 *   - fetchChapterContent 返回空内容 (html=null 且 content=null)
 *     —— cookie 死了 / 章节需要付费 / 接口出错, 都不该写入缓存把脏数据传染下次启动
 *   - 写盘失败 silent, 内存层至少还能用
 */
export class ChapterCache {
  /** 磁盘根目录, 启动时拼一次, 之后所有路径基于它 */
  private readonly rootDir: string;

  /** 内存热缓存 (Map 保持插入顺序, 用作朴素 LRU) */
  private readonly memCache = new Map<string, ChapterFetchResult>();
  private static readonly MAX_MEM_ENTRIES = 200;

  /** 单本书最多缓存几章 (超过删最旧) */
  private static readonly MAX_PER_BOOK = 100;

  /** prefetch 章节之间的最小间隔 (ms), 避免压垮 weread 接口 */
  private static readonly PREFETCH_GAP_MS = 250;

  /**
   * prefetch token — 切书 / 主动取消时自增.
   * in-flight 的 prefetch 在每次 await 之后比对自己持有的 myToken 和当前 token,
   * 不一致就直接 return, 让回包静默丢弃.
   */
  private prefetchToken = 0;

  /**
   * 正在被某次 prefetch 拉取的 chapter key, 用于"同一章不要被多个 prefetch 重复发请求".
   * 用户手动切章触发的 fetchChapterContent 不进这个 set —— 主流程不应被 prefetch 阻塞.
   */
  private readonly inFlight = new Set<string>();

  /**
   * per-book meta 写入串行化队列 — 主流程 put 和 prefetch put 可能并发写同一本的 _meta.json,
   * read-modify-write 不加锁会丢更新. 用 Promise chain 强制按提交顺序串行.
   * 任务完成后从 Map 移除避免无限增长.
   */
  private readonly metaQueue = new Map<string, Promise<void>>();

  /** _meta.json 在每本书目录下, 不算章节文件 */
  private static readonly META_FILENAME = '_meta.json';

  constructor(private readonly context: vscode.ExtensionContext) {
    // globalStorageUri 是 vscode 保证存在的目录, 但首次启动可能还没被 mkdir,
    // 我们写文件时再按需创建, 不在构造里同步 mkdir.
    this.rootDir = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      'wereadChapters',
    ).fsPath;
  }

  // ---------- 公共 API ----------

  /**
   * 读缓存. 命中返回结果, 未命中返回 null.
   *
   * 优先级: 内存 LRU > 磁盘 JSON.
   * 命中后会把磁盘命中项 promote 回内存层, 节省下次 IO.
   */
  public async get(
    bookId: string,
    chapterUid: number | string,
  ): Promise<ChapterFetchResult | null> {
    const k = this.memKey(bookId, chapterUid);

    const mem = this.memCache.get(k);
    if (mem) {
      // LRU touch: 重新 set 让它移到 Map 末尾
      this.memCache.delete(k);
      this.memCache.set(k, mem);
      return mem;
    }

    try {
      const filePath = this.chapterFile(bookId, chapterUid);
      const buf = await fs.readFile(filePath, 'utf-8');
      const obj = JSON.parse(buf) as Partial<ChapterFetchResult> | null;
      if (!this.isValidStoredShape(obj)) {
        return null;
      }
      const restored: ChapterFetchResult = {
        html: obj.html ?? null,
        style: obj.style ?? null,
        content: obj.content ?? null,
        format: obj.format ?? null,
        diagnostics: obj.diagnostics ?? '',
        fallbackUrl: obj.fallbackUrl ?? '',
      };
      if (!this.isUsable(restored)) {
        // 历史脏数据 (空内容), 不让它继续污染下次, 顺手删了
        void fs.unlink(filePath).catch(() => undefined);
        return null;
      }
      this.putInMemory(k, restored);
      // touch mtime, 让 LRU 删除时知道这条最近被用过 (避免被先删)
      const now = new Date();
      void fs.utimes(filePath, now, now).catch(() => undefined);
      return restored;
    } catch {
      // ENOENT / parse error 都 fall-through 到未命中
      return null;
    }
  }

  /**
   * 写缓存 (内存 + 磁盘). 空内容 / 失败结果会被 silently 拒绝.
   *
   * @param meta 可选 — 拿得到书名/章节标题时一并传入, 用于 _meta.json (供命令面板下钻可视化时显示)
   */
  public async put(
    bookId: string,
    chapterUid: number | string,
    result: ChapterFetchResult,
    meta?: ChapterPutMeta,
  ): Promise<void> {
    if (!this.isUsable(result)) {
      return;
    }
    const k = this.memKey(bookId, chapterUid);
    this.putInMemory(k, result);

    try {
      const filePath = this.chapterFile(bookId, chapterUid);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // fallbackUrl 是 view 层临时拼的, 不存 (重建很便宜); 其余原样存
      const toStore = {
        html: result.html,
        style: result.style,
        content: result.content,
        format: result.format,
        // diagnostics 留点儿(裁剪过长, 调试时知道是缓存还是直拉就行)
        diagnostics: (result.diagnostics ?? '').slice(0, 500),
      };
      await fs.writeFile(filePath, JSON.stringify(toStore), 'utf-8');
      // meta 写入是 fire-and-forget — 失败不影响主缓存功能, 仅命令面板少标题
      if (meta) {
        void this.updateMeta(bookId, {
          bookTitle: meta.bookTitle,
          author: meta.author,
          chapterUid: String(chapterUid),
          chapterTitle: meta.chapterTitle,
          chapterOrder: meta.chapterOrder,
        });
      }
      // 写完异步裁剪一下本书, 不阻塞调用方
      void this.trimBook(bookId);
    } catch (e) {
      console.warn('[weread-vscode] 章节缓存落盘失败', e);
    }
  }

  /**
   * 后台预拉某书"当前章节附近"的几章.
   *
   * 调用约定: fire-and-forget. 在 view 主章节加载完成后立刻发起,
   * 让用户翻页几乎"零延迟"且抗 cookie 过期.
   *
   * @param ahead 向后预拉数量 (>=0). 推荐 10, 上限 50 (再大没意义且占空间)
   * @param behind 向前预拉数量 (>=0). 推荐 1 (返章回看), 上限 10
   */
  public async prefetchAround(
    client: WereadClient,
    bookId: string,
    chapters: WereadChapter[],
    currentIdx: number,
    ahead: number,
    behind: number,
    bookMeta?: { bookTitle?: string; author?: string; chapterOrder?: string[] },
  ): Promise<void> {
    if (currentIdx < 0 || currentIdx >= chapters.length) return;
    if (ahead <= 0 && behind <= 0) return;

    const myToken = ++this.prefetchToken;

    // 优先级: 先后续 (用户最可能往后翻), 再向前 (返章场景)
    // 交错少, 保持简单 — 这样即便用户突然切书, 已抓到的也都是"最可能立即用到的"
    const targets: WereadChapter[] = [];
    for (let i = 1; i <= ahead; i++) {
      const idx = currentIdx + i;
      if (idx < chapters.length) targets.push(chapters[idx]);
    }
    for (let i = 1; i <= behind; i++) {
      const idx = currentIdx - i;
      if (idx >= 0) targets.push(chapters[idx]);
    }

    if (targets.length === 0) return;
    console.log(
      `[weread-vscode] prefetch 启动: book=${bookId} 当前 idx=${currentIdx} 目标=${targets.length} (ahead=${ahead}, behind=${behind})`,
    );

    for (const ch of targets) {
      if (myToken !== this.prefetchToken) {
        console.log('[weread-vscode] prefetch 被取消 (切书/手动 cancel)');
        return;
      }
      const k = this.memKey(bookId, ch.chapterUid);
      // 已在内存 / 已在 in-flight: 跳过
      if (this.memCache.has(k) || this.inFlight.has(k)) {
        continue;
      }
      // 磁盘命中: 不重新拉, 但 promote 到内存层
      const onDisk = await this.get(bookId, ch.chapterUid);
      if (onDisk) {
        continue;
      }

      this.inFlight.add(k);
      try {
        const res = await client.fetchChapterContent(bookId, ch.chapterUid);
        if (myToken !== this.prefetchToken) {
          // 切书后才回包, 直接丢
          return;
        }
        if (this.isUsable(res)) {
          await this.put(bookId, ch.chapterUid, res, {
            bookTitle: bookMeta?.bookTitle,
            author: bookMeta?.author,
            chapterTitle: ch.title,
            chapterOrder: bookMeta?.chapterOrder,
          });
          console.log(
            `[weread-vscode] prefetch ✓ book=${bookId} ch=${ch.chapterUid} (${(ch.title ?? '').slice(0, 24)})`,
          );
        } else {
          // 失败结果 — cookie 死 / 付费章 / 接口异常, 都不缓存
          console.log(
            `[weread-vscode] prefetch ✗ 空内容 book=${bookId} ch=${ch.chapterUid}`,
          );
          // cookie 失败时再继续 prefetch 也是徒劳 (fetchChapterContent 内部已经
          // 重试过一次, 还失败说明 wr_skey 真的不行了). 直接终止本批 prefetch.
          if (
            !res.html &&
            !res.content &&
            /登录|失效|-2012|-2013/.test(res.diagnostics ?? '')
          ) {
            console.log('[weread-vscode] prefetch 检测到登录失效迹象, 终止本批');
            return;
          }
        }
      } catch (e) {
        // 网络抖动 / unexpected — 不影响主流程, 继续下一章
        console.log(
          `[weread-vscode] prefetch ✗ book=${bookId} ch=${ch.chapterUid}: ${
            (e as Error)?.message ?? 'err'
          }`,
        );
      } finally {
        this.inFlight.delete(k);
      }

      // 给主流程让窗口: 用户突然手动切章 / cookie 续命接口才能抢到 channel
      await this.sleep(ChapterCache.PREFETCH_GAP_MS);
    }
    console.log(`[weread-vscode] prefetch 完成: book=${bookId}`);
  }

  /**
   * 取消所有 in-flight prefetch (回包会被 token 校验丢弃).
   * 用户切书 / 手动停止时调用.
   * 注: 已发出的 axios 请求不会被打断 (axios 没 abort), 只是结果不会被缓存.
   */
  public cancelAll(): void {
    if (this.inFlight.size > 0) {
      console.log(
        `[weread-vscode] cancel prefetch (in-flight ${this.inFlight.size} 个回包将被丢弃)`,
      );
    }
    this.prefetchToken++;
  }

  /** 清空整个缓存目录 + 内存层. 命令 weread.clearChapterCache 调用. */
  public async clearAll(): Promise<{ chapters: number; sizeKB: number }> {
    const stats = await this.stats();
    this.memCache.clear();
    this.prefetchToken++;
    this.metaQueue.clear();
    try {
      await fs.rm(this.rootDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[weread-vscode] 章节缓存清空失败', e);
    }
    return { chapters: stats.chapters, sizeKB: stats.sizeKB };
  }

  /**
   * 清空单本书的章节缓存 (章节文件 + _meta.json + 内存层中相关 key + in-flight 中相关 key).
   * 命令面板下钻"清空本书的所有缓存"调用.
   */
  /**
   * 离线模式: 仅基于 _meta.json 重建该书的章节列表 (不走网络).
   *
   * 适用场景: cookie 失效 / 弱网时, /web/book/chapterInfos 拿不到目录,
   * 用这个让 reader 仍能展示章节抽屉、用户翻已缓存过的章节. 没缓存的章节
   * 翻过去会回退到 fetch 报错的常规分支 (上层 loadCurrentChapter 处理).
   *
   * 依赖 BookMeta.chapterOrder + chapters (title 映射), 都是 put() 时同步写入的.
   *
   * @returns null 表示无法离线 — 这本书要么从未读过, 要么是老缓存还没有
   *   chapterOrder 字段, 让上层把错误抛回原路径.
   */
  public async loadOfflineChapters(
    bookId: string,
  ): Promise<WereadChapter[] | null> {
    const filePath = this.metaFile(bookId);
    try {
      const buf = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(buf);
      if (!parsed || typeof parsed !== 'object') return null;
      const p = parsed as Partial<BookMeta>;
      const order = Array.isArray(p.chapterOrder)
        ? p.chapterOrder.filter((x): x is string => typeof x === 'string')
        : [];
      if (order.length === 0) return null;
      const titles =
        p.chapters && typeof p.chapters === 'object'
          ? (p.chapters as Record<string, string>)
          : {};
      return order.map((uid, i) => {
        const n = Number(uid);
        return {
          // WereadChapter.chapterUid 类型是 number, 但 chapterFile / memKey 内部
          // 都把它 sanitize 成 string 当 key, 即便是罕见的非数字 uid 也能命中缓存.
          chapterUid: Number.isFinite(n) ? n : (uid as unknown as number),
          title: titles[uid] ?? `第 ${i + 1} 章`,
          level: 1,
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * 列出某本书已缓存到磁盘的所有 chapterUid (字符串集合, 与 chapterFile 文件名一致).
   * 用于 view 层渲染章节抽屉时给已缓存项打 ✓ 标记, 让用户在离线模式下一眼看出
   * 哪些章节能翻、哪些会失败.
   */
  public async listCachedChapterUids(bookId: string): Promise<Set<string>> {
    const out = new Set<string>();
    const dir = path.join(this.rootDir, this.sanitize(bookId));
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (this.isChapterFile(f)) {
          out.add(f.replace(/\.json$/, ''));
        }
      }
    } catch {
      /* 目录不存在: 返回空集合 */
    }
    return out;
  }

  public async clearBook(bookId: string): Promise<{ chapters: number; sizeKB: number }> {
    const dir = path.join(this.rootDir, this.sanitize(bookId));
    let chapters = 0;
    let size = 0;
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (!this.isChapterFile(f)) continue;
        try {
          const s = await fs.stat(path.join(dir, f));
          size += s.size;
          chapters++;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 目录不存在: 当作 0/0 */
    }
    // 同步清内存层 (key 形如 bookId:chapterUid)
    const prefix = bookId + ':';
    for (const k of [...this.memCache.keys()]) {
      if (k.startsWith(prefix)) {
        this.memCache.delete(k);
      }
    }
    // 取消本书的 meta 写入队列, 否则刚清完又被 in-flight 任务写回去
    this.metaQueue.delete(bookId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[weread-vscode] 清空单本失败', e);
    }
    return { chapters, sizeKB: Math.round(size / 1024) };
  }

  /**
   * 列出当前所有已缓存书籍 + 每本的章节列表, 供命令面板"可视化缓存内容"下钻使用.
   *
   * - 缺 _meta.json 的老缓存项也会被列出, bookTitle / chapterTitle 为 undefined,
   *   UI 层 fallback 到 id 字符串展示, 不影响功能.
   * - 按"本书章节总占用倒序"排序留给调用方, 这里只负责返回数据.
   */
  public async listAll(): Promise<CachedBookInfo[]> {
    const out: CachedBookInfo[] = [];
    let bookDirs: string[] = [];
    try {
      bookDirs = await fs.readdir(this.rootDir);
    } catch {
      return out; // 目录都没建过
    }
    for (const b of bookDirs) {
      const dirPath = path.join(this.rootDir, b);
      let stat;
      try {
        stat = await fs.stat(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      // meta (可选)
      const meta = await this.readMeta(dirPath).catch(() => null);

      // 章节文件
      let files: string[] = [];
      try {
        files = await fs.readdir(dirPath);
      } catch {
        continue;
      }
      const chapters: CachedBookInfo['chapters'] = [];
      let totalSize = 0;
      // 章节在书中的目录位置 — 仅当 meta 有 chapterOrder 快照时可解析, 否则全部为 undefined.
      // 命令面板下钻会拿这个 idx 排序, fallback 到 (数字 uid → 字典序).
      const order = meta?.chapterOrder;
      for (const f of files) {
        if (!this.isChapterFile(f)) continue;
        try {
          const s = await fs.stat(path.join(dirPath, f));
          const chapterUid = f.replace(/\.json$/, '');
          const idx = order ? order.indexOf(chapterUid) : -1;
          chapters.push({
            chapterUid,
            chapterTitle: meta?.chapters?.[chapterUid],
            sizeKB: Math.round(s.size / 1024),
            mtimeMs: s.mtimeMs,
            idx: idx >= 0 ? idx : undefined,
          });
          totalSize += s.size;
        } catch {
          /* ignore */
        }
      }
      // 空目录 (meta 没有, 章节也没有) 跳过, 不污染 UI 列表
      if (chapters.length === 0 && !meta) continue;
      out.push({
        bookId: meta?.bookId ?? b,
        bookTitle: meta?.bookTitle,
        author: meta?.author,
        totalSizeKB: Math.round(totalSize / 1024),
        chapters,
      });
    }
    return out;
  }

  /** 用于命令 weread.chapterCacheStats 展示当前占用 */
  public async stats(): Promise<{
    books: number;
    chapters: number;
    sizeKB: number;
    memEntries: number;
  }> {
    let books = 0;
    let chapters = 0;
    let size = 0;
    try {
      const bookDirs = await fs.readdir(this.rootDir);
      for (const b of bookDirs) {
        try {
          const dirPath = path.join(this.rootDir, b);
          const files = await fs.readdir(dirPath);
          let hasChapter = false;
          for (const f of files) {
            if (!this.isChapterFile(f)) {
              // _meta.json 也算到本书总占用里, 但不算章节计数
              try {
                const s = await fs.stat(path.join(dirPath, f));
                size += s.size;
              } catch {
                /* ignore */
              }
              continue;
            }
            try {
              const s = await fs.stat(path.join(dirPath, f));
              size += s.size;
              chapters++;
              hasChapter = true;
            } catch {
              /* ignore */
            }
          }
          if (hasChapter) books++;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 目录不存在: 0/0/0 */
    }
    return {
      books,
      chapters,
      sizeKB: Math.round(size / 1024),
      memEntries: this.memCache.size,
    };
  }

  // ---------- 内部 ----------

  /** 章节是否"内容可用" — 跟 WereadClient.chapterFetchSucceeded 同语义 */
  private isUsable(r: ChapterFetchResult): boolean {
    return (
      (typeof r.html === 'string' && r.html.length > 0) ||
      (typeof r.content === 'string' && r.content.length > 0)
    );
  }

  /** 内存层写入 + 容量裁剪 */
  private putInMemory(k: string, v: ChapterFetchResult): void {
    if (this.memCache.has(k)) {
      this.memCache.delete(k);
    }
    this.memCache.set(k, v);
    if (this.memCache.size > ChapterCache.MAX_MEM_ENTRIES) {
      // Map.keys() 返回插入顺序 — 删最早
      const oldest = this.memCache.keys().next().value;
      if (oldest !== undefined) {
        this.memCache.delete(oldest);
      }
    }
  }

  /** 单本书章节文件数超阈值时按 mtime 删最旧 (跳过 _meta.json — 标题信息要保留) */
  private async trimBook(bookId: string): Promise<void> {
    const safeBook = this.sanitize(bookId);
    const dir = path.join(this.rootDir, safeBook);
    try {
      const all = await fs.readdir(dir);
      const files = all.filter((f) => this.isChapterFile(f));
      if (files.length <= ChapterCache.MAX_PER_BOOK) return;

      const stats = await Promise.all(
        files.map(async (f) => {
          try {
            const s = await fs.stat(path.join(dir, f));
            return { f, mtime: s.mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      const valid = stats.filter(
        (s): s is { f: string; mtime: number } => s !== null,
      );
      valid.sort((a, b) => a.mtime - b.mtime);
      const toDelete = valid.slice(
        0,
        valid.length - ChapterCache.MAX_PER_BOOK,
      );
      await Promise.all(
        toDelete.map((s) =>
          fs.unlink(path.join(dir, s.f)).catch(() => undefined),
        ),
      );
      console.log(
        `[weread-vscode] 章节缓存裁剪 book=${bookId}: 删除 ${toDelete.length} 个最旧文件`,
      );
    } catch {
      /* 目录不存在 / 权限错: 安全跳过 */
    }
  }

  /**
   * meta 写入 — 走 per-book Promise chain 串行化, 防止主流程 put + prefetch put 并发
   * read-modify-write 丢更新.
   */
  private updateMeta(
    bookId: string,
    patch: {
      bookTitle?: string;
      author?: string;
      chapterUid?: string;
      chapterTitle?: string;
      /** 全书章节 uid 顺序快照 — 整体替换式写入, 传 undefined 不覆盖已有值 */
      chapterOrder?: string[];
    },
  ): Promise<void> {
    const prev = this.metaQueue.get(bookId) ?? Promise.resolve();
    // catch 把上一个失败咽掉, 不阻塞后续任务 (各任务相互独立)
    const next = prev
      .catch(() => undefined)
      .then(() => this.doUpdateMeta(bookId, patch));
    this.metaQueue.set(bookId, next);
    // 完成后清队列, 避免无限增长. 比较一下当前队尾还是不是自己 — 如果中间又有任务排进来, 别误删别人的.
    void next.finally(() => {
      if (this.metaQueue.get(bookId) === next) {
        this.metaQueue.delete(bookId);
      }
    });
    return next;
  }

  private async doUpdateMeta(
    bookId: string,
    patch: {
      bookTitle?: string;
      author?: string;
      chapterUid?: string;
      chapterTitle?: string;
      chapterOrder?: string[];
    },
  ): Promise<void> {
    const filePath = this.metaFile(bookId);
    // 读现有 (不存在则起一个空骨架)
    let cur: BookMeta = { bookId, chapters: {}, lastUpdatedAt: 0 };
    try {
      const buf = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(buf);
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Partial<BookMeta>;
        cur = {
          bookId: typeof p.bookId === 'string' ? p.bookId : bookId,
          bookTitle: typeof p.bookTitle === 'string' ? p.bookTitle : undefined,
          author: typeof p.author === 'string' ? p.author : undefined,
          chapters:
            p.chapters && typeof p.chapters === 'object'
              ? (p.chapters as Record<string, string>)
              : {},
          chapterOrder:
            Array.isArray(p.chapterOrder) &&
            p.chapterOrder.every((x) => typeof x === 'string')
              ? (p.chapterOrder as string[])
              : undefined,
          lastUpdatedAt:
            typeof p.lastUpdatedAt === 'number' ? p.lastUpdatedAt : 0,
        };
      }
    } catch {
      /* 不存在 / 损坏: 都用默认骨架 */
    }
    // patch 字段: 只覆盖非空值, 不要拿 undefined 把已有信息抹掉
    if (patch.bookTitle) cur.bookTitle = patch.bookTitle;
    if (patch.author) cur.author = patch.author;
    if (patch.chapterUid !== undefined && patch.chapterTitle) {
      cur.chapters[patch.chapterUid] = patch.chapterTitle;
    }
    // chapterOrder 是"全书目录快照", 整体替换式更新; 传 undefined / 空数组都不动已有值
    if (Array.isArray(patch.chapterOrder) && patch.chapterOrder.length > 0) {
      cur.chapterOrder = patch.chapterOrder.slice();
    }
    cur.lastUpdatedAt = Date.now();
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(cur), 'utf-8');
    } catch (e) {
      console.warn('[weread-vscode] meta 写入失败', e);
    }
  }

  /** 从书目录读 _meta.json (供 listAll 使用), 解析失败返回 null */
  private async readMeta(dirPath: string): Promise<BookMeta | null> {
    try {
      const buf = await fs.readFile(
        path.join(dirPath, ChapterCache.META_FILENAME),
        'utf-8',
      );
      const p = JSON.parse(buf);
      if (!p || typeof p !== 'object') return null;
      const meta = p as Partial<BookMeta>;
      return {
        bookId: typeof meta.bookId === 'string' ? meta.bookId : '',
        bookTitle:
          typeof meta.bookTitle === 'string' ? meta.bookTitle : undefined,
        author: typeof meta.author === 'string' ? meta.author : undefined,
        chapters:
          meta.chapters && typeof meta.chapters === 'object'
            ? (meta.chapters as Record<string, string>)
            : {},
        chapterOrder:
          Array.isArray(meta.chapterOrder) &&
          meta.chapterOrder.every((x) => typeof x === 'string')
            ? (meta.chapterOrder as string[])
            : undefined,
        lastUpdatedAt:
          typeof meta.lastUpdatedAt === 'number' ? meta.lastUpdatedAt : 0,
      };
    } catch {
      return null;
    }
  }

  /** 文件名是否一个章节缓存 (非 meta / 非杂项). 章节文件形如 "12345.json". */
  private isChapterFile(name: string): boolean {
    return name !== ChapterCache.META_FILENAME && name.endsWith('.json');
  }

  private metaFile(bookId: string): string {
    return path.join(
      this.rootDir,
      this.sanitize(bookId),
      ChapterCache.META_FILENAME,
    );
  }

  /** 校验从磁盘读出的对象是不是合法 ChapterFetchResult 形状 */
  private isValidStoredShape(obj: unknown): obj is Partial<ChapterFetchResult> {
    if (!obj || typeof obj !== 'object') return false;
    const o = obj as Record<string, unknown>;
    // html / content / style / format 任一字段是 string 或 null 即可
    const okOptionalStringOrNull = (v: unknown) =>
      v === null || typeof v === 'string' || v === undefined;
    return (
      okOptionalStringOrNull(o.html) &&
      okOptionalStringOrNull(o.style) &&
      okOptionalStringOrNull(o.content) &&
      okOptionalStringOrNull(o.format)
    );
  }

  /** 文件系统安全 id (bookId/chapterUid 含特殊字符时防御性 sanitize) */
  private sanitize(s: string | number): string {
    return String(s).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 100);
  }

  private memKey(bookId: string, chapterUid: number | string): string {
    return `${bookId}:${chapterUid}`;
  }

  private chapterFile(bookId: string, chapterUid: number | string): string {
    return path.join(
      this.rootDir,
      this.sanitize(bookId),
      this.sanitize(chapterUid) + '.json',
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

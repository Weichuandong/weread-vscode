import * as vscode from 'vscode';
import { WebNovelClient } from '../api/WebNovelClient';
import { urlKey } from '../api/htmlUtil';
import { WebChapterLink } from '../types';
import { CacheBookMeta, ChapterStore } from './ChapterStore';

export interface CacheJobState {
  bookKey: string;
  bookTitle: string;
  total: number;
  done: number;
  failed: number;
}

export interface CacheProgressEvent {
  job: CacheJobState;
  /** 本次新缓存成功的章节 URL (目录里的链接) */
  cachedUrls: string[];
  finished: boolean;
}

/** 每个请求之间的最小间隔 — 别把小说站打挂 / 触发风控 */
const REQUEST_GAP_MS = 250;

/**
 * Codex 批量缓存任务: 一次只跑一个任务, 进度条通知可取消。
 * 已缓存的章节自动跳过; 单章失败重试一次, 最终失败的计数上报, 不中断整体任务。
 */
export class CacheDownloader {
  private job: (CacheJobState & { cts: vscode.CancellationTokenSource }) | undefined;
  private readonly emitter = new vscode.EventEmitter<CacheProgressEvent>();
  readonly onProgress = this.emitter.event;

  constructor(
    private readonly client: WebNovelClient,
    private readonly store: ChapterStore,
  ) {}

  dispose(): void {
    this.job?.cts.cancel();
    this.emitter.dispose();
  }

  current(): CacheJobState | undefined {
    if (!this.job) return undefined;
    const { cts: _cts, ...rest } = this.job;
    return rest;
  }

  cancel(): void {
    this.job?.cts.cancel();
  }

  /** 启动缓存; 已有任务在跑时返回 false */
  start(book: CacheBookMeta & { bookTitle: string }, chapters: WebChapterLink[]): boolean {
    if (this.job) return false;
    const todo = chapters.filter((c) => !this.store.isCached(book.key, c.url));
    if (todo.length === 0) {
      vscode.window.showInformationMessage(`Codex：所选的 ${chapters.length} 章都已经缓存过了`);
      return true;
    }
    const cts = new vscode.CancellationTokenSource();
    const job = { bookKey: book.key, bookTitle: book.bookTitle, total: todo.length, done: 0, failed: 0, cts };
    this.job = job;
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Codex：缓存《${book.bookTitle}》`,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => cts.cancel());
        try {
          await this.runJob(book, todo, job, (msg, inc) => progress.report({ message: msg, increment: inc }));
        } finally {
          await this.store.flush();
          this.job = undefined;
          this.emitter.fire({ job: { ...job }, cachedUrls: [], finished: true });
          const cancelled = cts.token.isCancellationRequested;
          cts.dispose();
          const ok = job.done - job.failed;
          const tail = job.failed ? `，失败 ${job.failed} 章（可再次缓存补齐）` : '';
          void vscode.window.showInformationMessage(
            cancelled
              ? `Codex：已停止缓存《${book.bookTitle}》，本次缓存 ${ok} 章${tail}`
              : `Codex：《${book.bookTitle}》缓存完成，本次缓存 ${ok} 章${tail}`,
          );
        }
      },
    );
    this.emitter.fire({ job: { ...job }, cachedUrls: [], finished: false });
    return true;
  }

  private async runJob(
    book: CacheBookMeta,
    todo: WebChapterLink[],
    job: CacheJobState & { cts: vscode.CancellationTokenSource },
    report: (msg: string, increment: number) => void,
  ): Promise<void> {
    const token = job.cts.token;
    const concurrency = Math.min(
      5,
      Math.max(1, vscode.workspace.getConfiguration('webnovel').get<number>('cacheConcurrency', 2)),
    );
    const step = 100 / todo.length;
    let next = 0;
    let pending: string[] = [];
    let lastFire = 0;
    const flushEvent = (force = false) => {
      const now = Date.now();
      if (!force && now - lastFire < 400) return;
      lastFire = now;
      const urls = pending;
      pending = [];
      this.emitter.fire({ job: { ...job }, cachedUrls: urls, finished: false });
    };

    const worker = async () => {
      while (!token.isCancellationRequested && next < todo.length) {
        const link = todo[next++];
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok && !token.isCancellationRequested; attempt++) {
          try {
            if (attempt > 0) await sleep(1000);
            const c = await this.client.getChapter(link.url);
            const aliases = urlKey(c.url) === urlKey(link.url) ? [] : [link.url];
            await this.store.putChapter(book, c, ...aliases);
            ok = true;
          } catch {
            /* 重试一次 */
          }
        }
        if (token.isCancellationRequested && !ok) break;
        job.done++;
        if (ok) pending.push(link.url);
        else job.failed++;
        report(`${job.done}/${job.total}${job.failed ? ` · 失败 ${job.failed}` : ''} · ${link.title}`, step);
        flushEvent();
        await sleep(REQUEST_GAP_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    flushEvent(true);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

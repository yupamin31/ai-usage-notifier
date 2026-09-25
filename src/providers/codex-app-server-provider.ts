import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, delimiter } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import { z } from 'zod';

import type { CodexProviderConfig } from '../config/schema.js';
import type { Logger, UsageProvider, UsageSnapshot } from '../types.js';

const rateWindowSchema = z.object({
  usedPercent: z.number().finite(),
  windowDurationMins: z.number().finite().positive(),
  resetsAt: z.number().finite().nullable().optional(),
});

const rateLimitSchema = z
  .object({
    limitId: z.string().min(1),
    limitName: z.string().nullable().optional(),
    primary: rateWindowSchema.nullable().optional(),
    secondary: rateWindowSchema.nullable().optional(),
  })
  .passthrough();

const rateLimitsResultSchema = z.object({
  rateLimits: rateLimitSchema.nullable().optional(),
  rateLimitsByLimitId: z.record(z.string(), rateLimitSchema).nullable().optional(),
});

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppServerMessage {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CodexAppServerProviderDependencies {
  spawn?: typeof spawn;
  now?: () => Date;
  /** Test seam that bypasses the subprocess while exercising response mapping. */
  readRateLimits?: () => Promise<unknown>;
}

/**
 * Reads account quota data from Codex's official app-server JSON-RPC API.
 *
 * A single app-server process is reused across polling cycles to keep CPU use
 * low. Local session JSONL files remain a bounded fallback for temporary CLI
 * or network failures, but stale cached data is never presented as current.
 */
export class CodexAppServerProvider implements UsageProvider {
  public readonly id = 'codex';
  public readonly displayName: string;

  private readonly spawnImplementation: typeof spawn;
  private readonly now: () => Date;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private initialization: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  public constructor(
    private readonly config: CodexProviderConfig,
    private readonly sessionFallback: UsageProvider,
    private readonly logger: Logger,
    private readonly dependencies: CodexAppServerProviderDependencies = {},
  ) {
    this.displayName = config.displayName;
    this.spawnImplementation = dependencies.spawn ?? spawn;
    this.now = dependencies.now ?? (() => new Date());
  }

  public async poll(): Promise<UsageSnapshot[]> {
    let appServerError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const rawResult = this.dependencies.readRateLimits
          ? await this.dependencies.readRateLimits()
          : await this.readFromAppServer();
        return this.mapResult(rawResult);
      } catch (error) {
        appServerError = error;
        this.disposeProcess('Codex app-serverを再起動します');
        if (attempt === 1) {
          this.logger.warn('Codex app-server usage request failed; retrying with a new process', {
            error: errorMessage(error),
          });
        }
      }
    }

    this.logger.warn('Codex app-server retry failed; trying session fallback', {
      error: errorMessage(appServerError),
    });

    try {
      const cutoff = this.now().getTime() - this.config.sessionFallbackMaxAgeMinutes * 60_000;
      const fresh = (await this.sessionFallback.poll()).filter(
        (snapshot) => snapshot.observedAt.getTime() >= cutoff,
      );
      if (fresh.length > 0) {
        this.logger.info('Using recent Codex session data as a temporary fallback', {
          windows: fresh.map((snapshot) => snapshot.windowId),
        });
        return fresh;
      }
    } catch (fallbackError) {
      this.logger.warn('Codex session fallback also failed', {
        error: errorMessage(fallbackError),
      });
    }

    throw new Error(
      `Codex使用量の取得に失敗しました。Mac miniのCodex CLIログイン状態を確認してください（${errorMessage(appServerError)}）`,
      { cause: appServerError },
    );
  }

  public close(): void {
    this.disposeProcess('Codex使用量監視を終了しました');
    this.sessionFallback.close?.();
  }

  private async readFromAppServer(): Promise<unknown> {
    await this.ensureInitialized();
    return this.request('account/rateLimits/read');
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialization) {
      return this.initialization;
    }

    // JSON-RPC ids only need to be unique within one connection. Restarting
    // from 1 also avoids carrying state from a timed-out app-server process.
    this.nextRequestId = 1;
    const child = this.spawnImplementation(this.config.appServerCommand, ['app-server'], {
      env: withCommandPath(process.env, this.config.appServerCommand),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) {
        this.logger.debug('Codex app-server stderr', { message: message.slice(0, 1000) });
      }
    });
    child.once('error', (error) => this.handleProcessFailure(child, error));
    child.once('exit', (code, signal) => {
      this.handleProcessFailure(
        child,
        new Error(
          `Codex app-serverが終了しました（code=${String(code)}, signal=${String(signal)}）`,
        ),
      );
    });

    const initialization = (async (): Promise<void> => {
      await this.request('initialize', {
        clientInfo: {
          name: 'codex_usage_notifier',
          title: 'Codex Usage Notifier',
          version: '1.0.0',
        },
      });
      this.notify('initialized', {});
    })();
    this.initialization = initialization;

    try {
      await initialization;
    } catch (error) {
      this.disposeProcess('Codex app-serverの初期化に失敗しました');
      throw error;
    }
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      return Promise.reject(new Error('Codex app-serverが起動していません'));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(
          new Error(
            `Codex app-serverの${method}応答がタイムアウトしました（${this.config.requestTimeoutSeconds}秒）`,
          ),
        );
      }, this.config.requestTimeoutSeconds * 1000);
      timer.unref();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      child.stdin.write(`${JSON.stringify({ method, id, ...(params ? { params } : {}) })}\n`);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error('Codex app-serverが起動していません');
    }
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch {
      this.logger.debug('Ignoring non-JSON Codex app-server output');
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(
        new Error(`Codex app-serverエラー: ${JSON.stringify(message.error).slice(0, 500)}`),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private handleProcessFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return;
    }
    this.disposeProcess(error.message);
  }

  private disposeProcess(reason: string): void {
    const child = this.child;
    this.child = null;
    this.initialization = null;
    this.lines?.close();
    this.lines = null;

    const error = new Error(reason);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();

    if (child && !child.killed) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  }

  private mapResult(rawResult: unknown): UsageSnapshot[] {
    const parsed = rateLimitsResultSchema.safeParse(rawResult);
    if (!parsed.success) {
      throw new Error('Codex app-serverから想定外の利用率データが返されました');
    }

    const result = parsed.data;
    const multiBucketEntries = result.rateLimitsByLimitId
      ? Object.entries(result.rateLimitsByLimitId)
      : [];
    const entries: Array<[string, z.infer<typeof rateLimitSchema>]> =
      multiBucketEntries.length > 0
        ? multiBucketEntries
        : result.rateLimits
          ? [[result.rateLimits.limitId, result.rateLimits]]
          : [];
    const observedAt = this.now();
    const snapshots = new Map<string, UsageSnapshot>();

    for (const [entryId, bucket] of entries) {
      const limitId = bucket.limitId || entryId;
      if (!this.config.limitIds.includes(limitId)) {
        continue;
      }
      for (const window of [bucket.primary, bucket.secondary]) {
        if (!window) {
          continue;
        }
        const mapping = this.config.windowMappings.find(
          (candidate) =>
            window.windowDurationMins >= candidate.minMinutes &&
            window.windowDurationMins <= candidate.maxMinutes,
        );
        if (!mapping) {
          this.logger.debug('Ignoring an unmapped Codex app-server rate-limit window', {
            limitId,
            windowMinutes: window.windowDurationMins,
          });
          continue;
        }
        snapshots.set(mapping.id, {
          providerId: this.id,
          providerDisplayName: this.displayName,
          windowId: mapping.id,
          windowLabel: mapping.label,
          usedPercent: clampPercent(window.usedPercent),
          windowMinutes: window.windowDurationMins,
          resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000) : null,
          observedAt,
        });
      }
    }

    if (snapshots.size === 0) {
      throw new Error('Codex app-serverに監視対象の利用率ウィンドウがありません');
    }
    return [...snapshots.values()];
  }
}

function withCommandPath(environment: NodeJS.ProcessEnv, command: string): NodeJS.ProcessEnv {
  if (!command.includes('/')) {
    return environment;
  }
  const commandDirectory = dirname(command);
  const currentPath = environment['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin';
  const pathEntries = currentPath.split(delimiter);
  return {
    ...environment,
    PATH: pathEntries.includes(commandDirectory)
      ? currentPath
      : `${commandDirectory}${delimiter}${currentPath}`,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

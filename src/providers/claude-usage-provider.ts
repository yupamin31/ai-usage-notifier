import { execFile as execFileCallback } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { ClaudeProviderConfig } from '../config/schema.js';
import type { Logger, UsageProvider, UsageSnapshot } from '../types.js';
import { ProviderPollError } from './provider-poll-error.js';

const execFile = promisify(execFileCallback);

const credentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1) }),
});

const usageWindowSchema = z.object({
  utilization: z.number().min(0).max(100),
  resets_at: z.string().nullable().optional(),
});

const usageSchema = z.object({
  five_hour: usageWindowSchema.nullable().optional(),
  seven_day: usageWindowSchema.nullable().optional(),
});

interface ClaudeProviderDependencies {
  loadAccessToken?: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class ClaudeUsageProvider implements UsageProvider {
  public readonly id = 'claude';
  public readonly displayName: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;

  public constructor(
    private readonly config: ClaudeProviderConfig,
    private readonly logger: Logger,
    private readonly dependencies: ClaudeProviderDependencies = {},
  ) {
    this.displayName = config.displayName;
    this.fetchImplementation = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
  }

  public async poll(): Promise<UsageSnapshot[]> {
    const accessToken = await (this.dependencies.loadAccessToken?.() ?? this.loadAccessToken());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutSeconds * 1000);
    timeout.unref();

    let response: Response;
    try {
      response = await this.fetchImplementation('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
          'user-agent': 'claude-code/1.0',
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new Error(
          `Claude使用量の取得がタイムアウトしました（${this.config.requestTimeoutSeconds}秒）`,
          { cause: error },
        );
      }
      throw new Error(`Claude使用量の取得中に通信エラーが発生しました: ${errorMessage(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new ProviderPollError(
          'Claudeの認証に失敗しました（HTTP 401）。Mac miniでClaude Codeへ再ログインしてください。',
          'claude-http-401',
          this.config.authenticationErrorDelayMinutes * 60_000,
        );
      }
      throw new Error(`Claude使用量の取得に失敗しました（HTTP ${response.status}）`);
    }

    const parsedUsage = usageSchema.safeParse(await response.json());
    if (!parsedUsage.success) {
      throw new Error('Claude使用量APIから想定外のデータが返されました');
    }
    const usage = parsedUsage.data;
    const observedAt = this.now();
    const snapshots: UsageSnapshot[] = [];
    if (usage.five_hour) {
      snapshots.push(this.snapshot('fiveHour', '5時間', 300, usage.five_hour, observedAt));
    }
    if (usage.seven_day) {
      snapshots.push(this.snapshot('weekly', '週間', 10_080, usage.seven_day, observedAt));
    }
    return snapshots;
  }

  private snapshot(
    windowId: string,
    windowLabel: string,
    windowMinutes: number,
    window: z.infer<typeof usageWindowSchema>,
    observedAt: Date,
  ): UsageSnapshot {
    return {
      providerId: this.id,
      providerDisplayName: this.displayName,
      windowId,
      windowLabel,
      usedPercent: Math.min(100, Math.max(0, window.utilization)),
      windowMinutes,
      resetsAt: window.resets_at ? new Date(window.resets_at) : null,
      observedAt,
    };
  }

  private async loadAccessToken(): Promise<string> {
    let stdout: string;
    try {
      const result = await execFile(
        '/usr/bin/security',
        [
          'find-generic-password',
          '-a',
          userInfo().username,
          '-s',
          this.config.keychainService,
          '-w',
        ],
        { timeout: this.config.requestTimeoutSeconds * 1000, maxBuffer: 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (error) {
      this.logger.warn('Unable to read Claude credentials from macOS Keychain');
      throw new Error('macOSキーチェーンからClaudeの認証情報を取得できませんでした', {
        cause: error,
      });
    }

    try {
      const credentials = credentialsSchema.parse(JSON.parse(stdout) as unknown);
      return credentials.claudeAiOauth.accessToken;
    } catch (error) {
      throw new Error(
        'Claudeの認証情報を読み取れませんでした。Claude Codeへ再ログインしてください。',
        {
          cause: error,
        },
      );
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

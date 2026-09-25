import { describe, expect, it } from 'vitest';

import { ClaudeUsageProvider } from '../src/providers/claude-usage-provider.js';
import type { Logger } from '../src/types.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('ClaudeUsageProvider', () => {
  it('maps five-hour and weekly usage responses', async () => {
    const provider = new ClaudeUsageProvider(
      {
        enabled: true,
        displayName: 'Claude',
        keychainService: 'Claude Code-credentials',
        requestTimeoutSeconds: 10,
        authenticationErrorDelayMinutes: 5,
      },
      silentLogger,
      {
        loadAccessToken: () => Promise.resolve('test-token'),
        now: () => new Date('2026-08-02T04:15:00.000Z'),
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 42, resets_at: '2026-08-02T06:00:00.000Z' },
                seven_day: { utilization: 71, resets_at: '2026-08-08T06:00:00.000Z' },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          ),
      },
    );

    const snapshots = await provider.poll();

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      providerId: 'claude',
      windowId: 'fiveHour',
      usedPercent: 42,
      windowMinutes: 300,
    });
    expect(snapshots[1]).toMatchObject({
      windowId: 'weekly',
      usedPercent: 71,
      windowMinutes: 10_080,
    });
  });

  it('returns a Japanese authentication error for HTTP 401', async () => {
    const provider = new ClaudeUsageProvider(
      {
        enabled: true,
        displayName: 'Claude',
        keychainService: 'Claude Code-credentials',
        requestTimeoutSeconds: 20,
        authenticationErrorDelayMinutes: 5,
      },
      silentLogger,
      {
        loadAccessToken: () => Promise.resolve('expired-token'),
        fetch: () => Promise.resolve(new Response(null, { status: 401 })),
      },
    );

    await expect(provider.poll()).rejects.toThrow('Claudeの認証に失敗しました');
  });
});

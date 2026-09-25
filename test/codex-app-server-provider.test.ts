import { describe, expect, it } from 'vitest';

import type { CodexProviderConfig } from '../src/config/schema.js';
import { CodexAppServerProvider } from '../src/providers/codex-app-server-provider.js';
import type { Logger, UsageProvider } from '../src/types.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const emptyFallback: UsageProvider = {
  id: 'codex',
  displayName: 'Codex',
  poll: () => Promise.resolve([]),
};

describe('CodexAppServerProvider', () => {
  it('maps official app-server windows by duration', async () => {
    const provider = new CodexAppServerProvider(providerConfig(), emptyFallback, silentLogger, {
      now: () => new Date('2026-08-19T09:00:00.000Z'),
      readRateLimits: () =>
        Promise.resolve({
          rateLimits: {
            limitId: 'codex',
            primary: {
              usedPercent: 61,
              windowDurationMins: 10_080,
              resetsAt: 1_787_231_637,
            },
            secondary: null,
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: 'codex',
              primary: {
                usedPercent: 61,
                windowDurationMins: 10_080,
                resetsAt: 1_787_231_637,
              },
              secondary: null,
            },
          },
        }),
    });

    const snapshots = await provider.poll();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      providerId: 'codex',
      windowId: 'weekly',
      windowLabel: '週間',
      usedPercent: 61,
      windowMinutes: 10_080,
    });
  });

  it('retries once with a fresh app-server request before falling back', async () => {
    let attempts = 0;
    const provider = new CodexAppServerProvider(providerConfig(), emptyFallback, silentLogger, {
      readRateLimits: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error('temporary app-server failure'));
        }
        return Promise.resolve({
          rateLimits: {
            limitId: 'codex',
            primary: {
              usedPercent: 42,
              windowDurationMins: 10_080,
              resetsAt: 1_787_231_637,
            },
          },
        });
      },
    });

    const snapshots = await provider.poll();

    expect(attempts).toBe(2);
    expect(snapshots[0]).toMatchObject({ windowId: 'weekly', usedPercent: 42 });
  });
});

function providerConfig(): CodexProviderConfig {
  return {
    enabled: true,
    displayName: 'Codex',
    appServerCommand: '/opt/homebrew/bin/codex',
    requestTimeoutSeconds: 20,
    sessionFallbackMaxAgeMinutes: 1440,
    limitIds: ['codex'],
    sessionsDirectory: '~/.codex/sessions',
    lookbackDays: 14,
    initialTailKilobytes: 64,
    maxReadKilobytesPerPoll: 1024,
    windowMappings: [
      { id: 'fiveHour', label: '5時間', minMinutes: 240, maxMinutes: 360 },
      { id: 'weekly', label: '週間', minMinutes: 9000, maxMinutes: 11000 },
    ],
  };
}

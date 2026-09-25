import { describe, expect, it, vi } from 'vitest';

import { Monitor } from '../src/core/monitor.js';
import { ProviderPollError } from '../src/providers/provider-poll-error.js';
import type { Logger, UsageProvider, UsageSnapshot } from '../src/types.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('Monitor delayed provider errors', () => {
  it('notifies once only after a 401 continues for five minutes and resets on recovery', async () => {
    let now = new Date('2026-08-19T11:30:00.000Z');
    let failing = true;
    const provider: UsageProvider = {
      id: 'claude',
      displayName: 'Claude',
      poll: () =>
        failing
          ? Promise.reject(new ProviderPollError('HTTP 401', 'claude-http-401', 5 * 60_000))
          : Promise.resolve([]),
    };
    const engine = {
      process: vi.fn(() => Promise.resolve()),
      tick: vi.fn(() => Promise.resolve()),
      reportProviderError: vi.fn(() => Promise.resolve()),
    };
    const monitor = new Monitor([provider], engine, 60_000, silentLogger, () => now);

    await monitor.runOnce();
    now = new Date('2026-08-19T11:34:59.000Z');
    await monitor.runOnce();
    expect(engine.reportProviderError).not.toHaveBeenCalled();

    now = new Date('2026-08-19T11:35:00.000Z');
    await monitor.runOnce();
    now = new Date('2026-08-19T11:36:00.000Z');
    await monitor.runOnce();
    expect(engine.reportProviderError).toHaveBeenCalledTimes(1);

    failing = false;
    await monitor.runOnce();
    failing = true;
    now = new Date('2026-08-19T11:37:00.000Z');
    await monitor.runOnce();
    expect(engine.reportProviderError).toHaveBeenCalledTimes(1);
  });
});

describe('Monitor reset ordering', () => {
  it('checks due resets before processing fresh snapshots', async () => {
    const usage: UsageSnapshot = {
      providerId: 'codex',
      providerDisplayName: 'Codex',
      windowId: 'fiveHour',
      windowLabel: '5時間',
      usedPercent: 0,
      windowMinutes: 300,
      resetsAt: new Date('2026-08-19T16:00:00.000Z'),
      observedAt: new Date('2026-08-19T11:00:00.000Z'),
    };
    const provider: UsageProvider = {
      id: 'codex',
      displayName: 'Codex',
      poll: () => Promise.resolve([usage]),
    };
    const calls: string[] = [];
    const engine = {
      process: vi.fn(() => {
        calls.push('process');
        return Promise.resolve();
      }),
      tick: vi.fn(() => {
        calls.push('tick');
        return Promise.resolve();
      }),
      reportProviderError: vi.fn(() => Promise.resolve()),
    };
    const monitor = new Monitor([provider], engine, 60_000, silentLogger);

    await monitor.runOnce();

    expect(calls).toEqual(['tick', 'process', 'tick']);
  });
});

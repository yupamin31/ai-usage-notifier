import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CodexProviderConfig } from '../src/config/schema.js';
import { CodexSessionProvider } from '../src/providers/codex-session-provider.js';
import type { Logger } from '../src/types.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codex-provider-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('CodexSessionProvider', () => {
  it('maps rate-limit windows by duration rather than primary/secondary order', async () => {
    const now = new Date();
    const sessions = join(
      directory,
      'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    );
    await mkdir(sessions, { recursive: true });
    const record = {
      timestamp: now.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 42, window_minutes: 10080, resets_at: 1786240000 },
          secondary: { used_percent: 90, window_minutes: 300, resets_at: 1785640000 },
        },
      },
    };
    await writeFile(join(sessions, 'rollout-test.jsonl'), `${JSON.stringify(record)}\n`);

    const provider = new CodexSessionProvider(
      providerConfig(join(directory, 'sessions')),
      join(directory, 'cursors.json'),
      silentLogger,
      true,
    );
    const snapshots = await provider.poll();

    expect(snapshots.find((value) => value.windowId === 'fiveHour')?.usedPercent).toBe(90);
    expect(snapshots.find((value) => value.windowId === 'weekly')?.usedPercent).toBe(42);
  });
});

function providerConfig(sessionsDirectory: string): CodexProviderConfig {
  return {
    enabled: true,
    displayName: 'Codex',
    appServerCommand: '/opt/homebrew/bin/codex',
    requestTimeoutSeconds: 20,
    sessionFallbackMaxAgeMinutes: 1440,
    limitIds: ['codex'],
    sessionsDirectory,
    lookbackDays: 14,
    initialTailKilobytes: 64,
    maxReadKilobytesPerPoll: 1024,
    windowMappings: [
      { id: 'fiveHour', label: '5時間', minMinutes: 240, maxMinutes: 360 },
      { id: 'weekly', label: '週間', minMinutes: 9000, maxMinutes: 11000 },
    ],
  };
}

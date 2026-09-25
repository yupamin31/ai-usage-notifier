import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigRepository } from '../src/config/config-repository.js';
import { configSchema } from '../src/config/schema.js';
import type { Logger } from '../src/types.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'notifier-config-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('ConfigRepository', () => {
  it('persists dashboard settings and updates the active runtime config', async () => {
    const raw = JSON.parse(
      await readFile(new URL('../config/config.example.json', import.meta.url), 'utf8'),
    ) as unknown;
    const runtimeConfig = configSchema.parse(raw);
    const filePath = join(directory, 'config.json');
    await writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const repository = new ConfigRepository(filePath, runtimeConfig, silentLogger);

    const settings = await repository.updateDashboardSettings({
      providerId: 'claude',
      notificationsEnabled: false,
      thresholdNotificationsEnabled: false,
      resetNotificationsEnabled: true,
      remainingThresholds: [25, 10, 10],
    });

    expect(settings.providers.claude).toMatchObject({
      notificationsEnabled: false,
      thresholdNotificationsEnabled: false,
      resetNotificationsEnabled: true,
      remainingThresholds: [25, 10],
    });
    expect(settings.providers.codex.notificationsEnabled).toBe(true);
    expect(runtimeConfig.notifications.providerSettings.claude).toMatchObject({
      enabled: false,
      thresholdsEnabled: false,
      thresholds: [75, 90],
    });
    expect(runtimeConfig.notifications.providerSettings.codex?.thresholds).toEqual([80, 90, 95]);
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      notifications: {
        providerSettings: Record<
          string,
          { enabled: boolean; thresholdsEnabled: boolean; thresholds: number[] }
        >;
      };
    };
    expect(persisted.notifications.providerSettings['claude']).toMatchObject({
      enabled: false,
      thresholdsEnabled: false,
      thresholds: [75, 90],
    });
    expect(persisted.notifications.providerSettings['codex']?.thresholds).toEqual([80, 90, 95]);
  });

  it('rejects unknown settings without modifying the file', async () => {
    const rawText = await readFile(
      new URL('../config/config.example.json', import.meta.url),
      'utf8',
    );
    const runtimeConfig = configSchema.parse(JSON.parse(rawText) as unknown);
    const filePath = join(directory, 'config.json');
    await writeFile(filePath, rawText, 'utf8');
    const repository = new ConfigRepository(filePath, runtimeConfig, silentLogger);

    await expect(repository.updateDashboardSettings({ token: 'nope' })).rejects.toThrow();
    expect(await readFile(filePath, 'utf8')).toBe(rawText);
  });

  it('rejects remaining percentages outside 0 to 100', async () => {
    const rawText = await readFile(
      new URL('../config/config.example.json', import.meta.url),
      'utf8',
    );
    const runtimeConfig = configSchema.parse(JSON.parse(rawText) as unknown);
    const filePath = join(directory, 'config.json');
    await writeFile(filePath, rawText, 'utf8');
    const repository = new ConfigRepository(filePath, runtimeConfig, silentLogger);

    await expect(
      repository.updateDashboardSettings({ providerId: 'codex', remainingThresholds: [101] }),
    ).rejects.toThrow();
    expect(await readFile(filePath, 'utf8')).toBe(rawText);
  });
});

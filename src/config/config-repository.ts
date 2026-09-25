import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { Logger } from '../types.js';
import { configSchema, type AppConfig, providerNotificationSettings } from './schema.js';

const dashboardProviderIdSchema = z.enum(['claude', 'codex']);

export const dashboardSettingsSchema = z
  .object({
    providerId: dashboardProviderIdSchema,
    notificationsEnabled: z.boolean().optional(),
    thresholdNotificationsEnabled: z.boolean().optional(),
    resetNotificationsEnabled: z.boolean().optional(),
    errorNotificationsEnabled: z.boolean().optional(),
    remainingThresholds: z
      .array(z.number().int().min(0).max(100))
      .min(1)
      .max(10)
      .transform((values) => [...new Set(values)].sort((left, right) => right - left))
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.notificationsEnabled !== undefined ||
      value.thresholdNotificationsEnabled !== undefined ||
      value.resetNotificationsEnabled !== undefined ||
      value.errorNotificationsEnabled !== undefined ||
      value.remainingThresholds !== undefined,
    {
      message: 'At least one setting is required',
    },
  );

export type DashboardSettingsUpdate = z.infer<typeof dashboardSettingsSchema>;

export interface DashboardProviderSettings {
  notificationsEnabled: boolean;
  thresholdNotificationsEnabled: boolean;
  resetNotificationsEnabled: boolean;
  errorNotificationsEnabled: boolean;
  thresholds: number[];
  remainingThresholds: number[];
}

export interface DashboardSettings {
  discordEnabled: boolean;
  providers: Record<'claude' | 'codex', DashboardProviderSettings>;
}

export class ConfigRepository {
  public constructor(
    private readonly filePath: string,
    private readonly runtimeConfig: AppConfig,
    private readonly logger: Logger,
  ) {}

  public getDashboardSettings(): DashboardSettings {
    return {
      discordEnabled: this.runtimeConfig.discord.enabled,
      providers: {
        claude: this.getProviderSettings('claude'),
        codex: this.getProviderSettings('codex'),
      },
    };
  }

  public async updateDashboardSettings(input: unknown): Promise<DashboardSettings> {
    const update = dashboardSettingsSchema.parse(input);
    const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, unknown>;
    const notifications = asRecord(raw['notifications']);
    const providerSettings = asRecord(notifications['providerSettings']);
    const provider = asRecord(providerSettings[update.providerId]);

    if (update.notificationsEnabled !== undefined) {
      provider['enabled'] = update.notificationsEnabled;
    }
    if (update.thresholdNotificationsEnabled !== undefined) {
      provider['thresholdsEnabled'] = update.thresholdNotificationsEnabled;
    }
    if (update.resetNotificationsEnabled !== undefined) {
      provider['resetsEnabled'] = update.resetNotificationsEnabled;
    }
    if (update.errorNotificationsEnabled !== undefined) {
      provider['errorsEnabled'] = update.errorNotificationsEnabled;
    }
    if (update.remainingThresholds !== undefined) {
      provider['thresholds'] = update.remainingThresholds.map((remaining) => 100 - remaining);
    }
    providerSettings[update.providerId] = provider;
    notifications['providerSettings'] = providerSettings;
    raw['notifications'] = notifications;
    const validated = configSchema.parse(raw);
    if (update.remainingThresholds !== undefined) {
      provider['thresholds'] = [
        ...(validated.notifications.providerSettings[update.providerId]?.thresholds ?? []),
      ];
      providerSettings[update.providerId] = provider;
      notifications['providerSettings'] = providerSettings;
      raw['notifications'] = notifications;
    }

    const temporary = join(dirname(this.filePath), `.${randomUUID()}.config.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      this.logger.error('Dashboard settings could not be persisted', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const runtimeProvider = {
      ...(this.runtimeConfig.notifications.providerSettings[update.providerId] ?? {}),
    };
    if (update.notificationsEnabled !== undefined) {
      runtimeProvider.enabled = update.notificationsEnabled;
    }
    if (update.thresholdNotificationsEnabled !== undefined) {
      runtimeProvider.thresholdsEnabled = update.thresholdNotificationsEnabled;
    }
    if (update.resetNotificationsEnabled !== undefined) {
      runtimeProvider.resetsEnabled = update.resetNotificationsEnabled;
    }
    if (update.errorNotificationsEnabled !== undefined) {
      runtimeProvider.errorsEnabled = update.errorNotificationsEnabled;
    }
    if (update.remainingThresholds !== undefined) {
      runtimeProvider.thresholds = [
        ...(validated.notifications.providerSettings[update.providerId]?.thresholds ?? []),
      ];
    }
    this.runtimeConfig.notifications.providerSettings[update.providerId] = runtimeProvider;

    this.logger.info('Dashboard notification settings updated', {
      ...this.getDashboardSettings(),
    });
    return this.getDashboardSettings();
  }

  private getProviderSettings(providerId: 'claude' | 'codex'): DashboardProviderSettings {
    const settings = providerNotificationSettings(this.runtimeConfig, providerId);
    return {
      notificationsEnabled: settings.enabled,
      thresholdNotificationsEnabled: settings.thresholdsEnabled,
      resetNotificationsEnabled: settings.resetsEnabled,
      errorNotificationsEnabled: settings.errorsEnabled,
      thresholds: [...settings.thresholds],
      remainingThresholds: settings.thresholds.map((threshold) => 100 - threshold),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

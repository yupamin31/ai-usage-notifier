import { z } from 'zod';

const pathSchema = z.string().min(1);

const windowMappingSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    minMinutes: z.number().int().positive(),
    maxMinutes: z.number().int().positive(),
  })
  .refine((value) => value.minMinutes <= value.maxMinutes, {
    message: 'minMinutes must be less than or equal to maxMinutes',
  });

const externalProviderSchema = z.object({
  enabled: z.boolean(),
  displayName: z.string().min(1),
  sourceFile: pathSchema,
});

const claudeProviderSchema = z.object({
  enabled: z.boolean(),
  displayName: z.string().min(1),
  keychainService: z.string().min(1),
  requestTimeoutSeconds: z.number().int().min(1).max(60),
  authenticationErrorDelayMinutes: z.number().int().min(0).max(60).default(5),
});

const providerNotificationSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  thresholdsEnabled: z.boolean().optional(),
  resetsEnabled: z.boolean().optional(),
  errorsEnabled: z.boolean().optional(),
  thresholds: z
    .array(z.number().min(0).max(100))
    .min(1)
    .transform((values) => [...new Set(values)].sort((left, right) => left - right))
    .optional(),
});

export const configSchema = z.object({
  version: z.literal(1),
  web: z.object({
    enabled: z.boolean(),
    host: z.string().min(1),
    port: z.number().int().min(1024).max(65535),
    refreshSeconds: z.number().int().min(5).max(300),
  }),
  app: z.object({
    pollIntervalSeconds: z.number().int().min(15).max(3600),
    timeZone: z.string().min(1),
    notifyOnStartup: z.boolean(),
    stateDirectory: pathSchema,
    logDirectory: pathSchema,
    logRetentionDays: z.number().int().min(1).max(365),
    logMaxMegabytes: z.number().int().min(1).max(1024),
  }),
  discord: z.object({
    enabled: z.boolean(),
    botTokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    channelIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    requestTimeoutSeconds: z.number().int().min(1).max(60),
    maxRetries: z.number().int().min(0).max(10),
  }),
  notifications: z.object({
    enabled: z.boolean(),
    thresholdsEnabled: z.boolean(),
    resetsEnabled: z.boolean(),
    errorsEnabled: z.boolean(),
    thresholds: z
      .array(z.number().min(0).max(100))
      .min(1)
      .transform((values) => [...new Set(values)].sort((left, right) => left - right)),
    thresholdRearmMargin: z.number().min(0).max(50),
    restoredUsedPercent: z.number().min(0).max(100),
    minimumUsedBeforeRestore: z.number().min(0).max(100),
    resetNotificationCooldownMinutes: z.number().int().min(0).max(1440),
    lateResetNotificationMinutes: z.number().int().min(0).max(10080),
    providerSettings: z.record(z.string().min(1), providerNotificationSettingsSchema).default({}),
    templates: z.object({
      threshold: z.string().min(1).max(2000),
      reset: z.string().min(1).max(2000),
      weeklyReset: z.string().min(1).max(2000),
      unscheduledReset: z.string().min(1).max(2000),
      test: z.string().min(1).max(2000),
      error: z.string().min(1).max(2000),
    }),
  }),
  providers: z.object({
    codex: z.object({
      enabled: z.boolean(),
      displayName: z.string().min(1),
      appServerCommand: pathSchema.default('/opt/homebrew/bin/codex'),
      requestTimeoutSeconds: z.number().int().min(1).max(60).default(20),
      sessionFallbackMaxAgeMinutes: z.number().int().min(1).max(10080).default(1440),
      limitIds: z.array(z.string().min(1)).min(1).default(['codex']),
      sessionsDirectory: pathSchema,
      lookbackDays: z.number().int().min(1).max(90),
      initialTailKilobytes: z.number().int().min(64).max(10240),
      maxReadKilobytesPerPoll: z.number().int().min(64).max(102400),
      windowMappings: z.array(windowMappingSchema).min(1),
    }),
    claude: claudeProviderSchema,
    gemini: externalProviderSchema,
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
export type CodexProviderConfig = AppConfig['providers']['codex'];
export type ClaudeProviderConfig = AppConfig['providers']['claude'];
export type ExternalProviderConfig = AppConfig['providers']['gemini'];

export interface ResolvedProviderNotificationSettings {
  enabled: boolean;
  thresholdsEnabled: boolean;
  resetsEnabled: boolean;
  errorsEnabled: boolean;
  thresholds: number[];
}

export function providerNotificationSettings(
  config: AppConfig,
  providerId: string,
): ResolvedProviderNotificationSettings {
  const override = config.notifications.providerSettings[providerId];
  return {
    enabled: override?.enabled ?? config.notifications.enabled,
    thresholdsEnabled: override?.thresholdsEnabled ?? config.notifications.thresholdsEnabled,
    resetsEnabled: override?.resetsEnabled ?? config.notifications.resetsEnabled,
    errorsEnabled: override?.errorsEnabled ?? config.notifications.errorsEnabled,
    thresholds: [...(override?.thresholds ?? config.notifications.thresholds)],
  };
}

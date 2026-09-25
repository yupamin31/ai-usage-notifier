import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { ExternalProviderConfig } from '../config/schema.js';
import type { Logger, UsageProvider, UsageSnapshot } from '../types.js';

const sourceSchema = z.object({
  observedAt: z.iso.datetime(),
  windows: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      usedPercent: z.number().min(0).max(100),
      windowMinutes: z.number().positive().nullable().optional(),
      resetsAt: z.iso.datetime().nullable(),
    }),
  ),
});

/**
 * Stable adapter boundary for services that do not expose an official usage
 * API. A separate, replaceable collector writes one small JSON file atomically;
 * the monitor applies the same dedupe and notification rules as Codex.
 */
export class JsonFileProvider implements UsageProvider {
  public readonly displayName: string;

  public constructor(
    public readonly id: string,
    private readonly config: ExternalProviderConfig,
    private readonly logger: Logger,
  ) {
    this.displayName = config.displayName;
  }

  public async poll(): Promise<UsageSnapshot[]> {
    let text: string;
    try {
      text = await readFile(this.config.sourceFile, 'utf8');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') {
        this.logger.debug('Optional provider file does not exist yet', {
          provider: this.id,
          file: this.config.sourceFile,
        });
        return [];
      }
      throw error;
    }

    const parsed = sourceSchema.parse(JSON.parse(text) as unknown);
    return parsed.windows.map((window) => ({
      providerId: this.id,
      providerDisplayName: this.displayName,
      windowId: window.id,
      windowLabel: window.label,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes ?? null,
      resetsAt: window.resetsAt ? new Date(window.resetsAt) : null,
      observedAt: new Date(parsed.observedAt),
    }));
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Logger } from '../types.js';

export interface WindowState {
  providerId: string;
  providerDisplayName: string;
  windowId: string;
  windowLabel: string;
  windowMinutes: number | null;
  lastUsedPercent: number | null;
  lastSnapshotFingerprint: string | null;
  notifiedThresholds: number[];
  scheduledResetAt: string | null;
  scheduledResetNotified: boolean;
  lastResetNotificationAt: string | null;
  cycle: number;
}

interface PersistedState {
  version: 1;
  windows: Record<string, WindowState>;
  claims: Record<string, string>;
}

const EMPTY_STATE: PersistedState = {
  version: 1,
  windows: {},
  claims: {},
};

export class StateStore {
  private state: PersistedState = structuredClone(EMPTY_STATE);

  public constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    private readonly readOnly = false,
  ) {}

  public async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedState>;
      if (parsed.version !== 1 || typeof parsed.windows !== 'object' || parsed.windows === null) {
        throw new Error('Unsupported state file format');
      }
      this.state = {
        version: 1,
        windows: parsed.windows,
        claims: parsed.claims ?? {},
      };
      this.pruneClaims();
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        this.logger.warn('State file could not be loaded; starting with empty state', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.state = structuredClone(EMPTY_STATE);
    }
  }

  public getWindow(key: string): WindowState | undefined {
    const value = this.state.windows[key];
    return value ? structuredClone(value) : undefined;
  }

  public listWindows(): Array<[string, WindowState]> {
    return Object.entries(this.state.windows).map(([key, value]) => [key, structuredClone(value)]);
  }

  public async setWindow(key: string, value: WindowState): Promise<void> {
    this.state.windows[key] = structuredClone(value);
    await this.persist();
  }

  /**
   * Claims are persisted before Discord is called. This gives at-most-once
   * behavior even if the process crashes after Discord accepted a message.
   */
  public async claim(key: string): Promise<boolean> {
    this.pruneClaims();
    if (this.state.claims[key]) {
      return false;
    }
    this.state.claims[key] = new Date().toISOString();
    await this.persist();
    return true;
  }

  private pruneClaims(): void {
    const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
    this.state.claims = Object.fromEntries(
      Object.entries(this.state.claims).filter(([, date]) => Date.parse(date) >= cutoff),
    );
  }

  private async persist(): Promise<void> {
    if (this.readOnly) {
      return;
    }
    const temporary = join(dirname(this.filePath), `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

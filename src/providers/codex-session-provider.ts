import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexProviderConfig } from '../config/schema.js';
import type { Logger, UsageProvider, UsageSnapshot } from '../types.js';

interface FileCursor {
  offset: number;
  skipUntilNewline?: boolean;
}

interface SerializedSnapshot extends Omit<UsageSnapshot, 'observedAt' | 'resetsAt'> {
  observedAt: string;
  resetsAt: string | null;
}

interface CursorState {
  version: 1;
  files: Record<string, FileCursor>;
  latest: Record<string, SerializedSnapshot>;
}

interface RawRateWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

const EMPTY_CURSORS: CursorState = { version: 1, files: {}, latest: {} };

export class CodexSessionProvider implements UsageProvider {
  public readonly id = 'codex';
  public readonly displayName: string;
  private cursors: CursorState = structuredClone(EMPTY_CURSORS);
  private loaded = false;

  public constructor(
    private readonly config: CodexProviderConfig,
    private readonly cursorFile: string,
    private readonly logger: Logger,
    private readonly readOnly = false,
  ) {
    this.displayName = config.displayName;
  }

  public async poll(): Promise<UsageSnapshot[]> {
    if (!this.loaded) {
      await this.loadCursors();
      this.loaded = true;
    }

    const files = await this.findRecentSessionFiles();
    let changed = false;

    for (const filePath of files) {
      changed = (await this.consumeFile(filePath)) || changed;
    }

    if (changed) {
      await this.saveCursors();
    }

    return Object.values(this.cursors.latest).map((snapshot) => ({
      ...snapshot,
      observedAt: new Date(snapshot.observedAt),
      resetsAt: snapshot.resetsAt ? new Date(snapshot.resetsAt) : null,
    }));
  }

  private async findRecentSessionFiles(): Promise<string[]> {
    const cutoff = Date.now() - this.config.lookbackDays * 24 * 60 * 60 * 1000;
    const results = new Set<string>();

    const readDateDirectory = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code === 'ENOENT') {
          return;
        }
        throw error;
      }

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.add(join(directory, entry.name));
        }
      }
    };

    // Codex stores sessions in YYYY/MM/DD directories. Looking at only the
    // configured date range avoids walking years of history every minute.
    for (let age = 0; age <= this.config.lookbackDays; age += 1) {
      const date = new Date(Date.now() - age * 24 * 60 * 60 * 1000);
      await readDateDirectory(
        join(
          this.config.sessionsDirectory,
          String(date.getFullYear()),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0'),
        ),
      );
    }

    // Keep following a known recent file even across a timezone/date boundary.
    for (const filePath of Object.keys(this.cursors.files)) {
      try {
        if ((await stat(filePath)).mtimeMs >= cutoff) {
          results.add(filePath);
        } else {
          delete this.cursors.files[filePath];
        }
      } catch {
        delete this.cursors.files[filePath];
      }
    }
    return [...results].sort();
  }

  private async consumeFile(filePath: string): Promise<boolean> {
    const metadata = await stat(filePath);
    const knownCursor = this.cursors.files[filePath];
    const initialOffset = Math.max(0, metadata.size - this.config.initialTailKilobytes * 1024);
    let offset = knownCursor?.offset ?? initialOffset;

    if (metadata.size < offset) {
      this.logger.info('Codex session file was truncated; cursor reset', { file: filePath });
      offset = 0;
    }
    if (metadata.size === offset) {
      return false;
    }

    const maximumBytes = this.config.maxReadKilobytesPerPoll * 1024;
    const bytesToRead = Math.min(metadata.size - offset, maximumBytes);
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      let data = buffer.subarray(0, bytesRead);

      if (knownCursor?.skipUntilNewline) {
        const firstNewline = data.indexOf(0x0a);
        if (firstNewline < 0) {
          this.cursors.files[filePath] = { offset: offset + bytesRead, skipUntilNewline: true };
          return true;
        }
        offset += firstNewline + 1;
        data = data.subarray(firstNewline + 1);
      }

      // A tail scan starts in the middle of an arbitrary JSONL record.
      if (!knownCursor && initialOffset > 0) {
        const firstNewline = data.indexOf(0x0a);
        if (firstNewline < 0) {
          return false;
        }
        offset += firstNewline + 1;
        data = data.subarray(firstNewline + 1);
      }

      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        if (metadata.size > offset + data.length) {
          this.cursors.files[filePath] = {
            offset: offset + data.length,
            skipUntilNewline: true,
          };
          return true;
        }
        return false;
      }

      const completeContents = data.subarray(0, lastNewline).toString('utf8');
      for (const line of completeContents.split('\n')) {
        this.consumeLine(line);
      }

      this.cursors.files[filePath] = { offset: offset + lastNewline + 1 };
      return true;
    } finally {
      await handle.close();
    }
  }

  private consumeLine(line: string): void {
    if (!line.includes('"rate_limits"') || !line.includes('"token_count"')) {
      return;
    }

    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(record) || !isRecord(record['payload'])) {
      return;
    }
    const payload = record['payload'];
    if (payload['type'] !== 'token_count' || !isRecord(payload['rate_limits'])) {
      return;
    }

    const observedAt = parseDate(record['timestamp']) ?? new Date();
    for (const key of ['primary', 'secondary'] as const) {
      const rawWindow = payload['rate_limits'][key];
      if (!isRecord(rawWindow)) {
        continue;
      }
      this.consumeRateWindow(rawWindow, observedAt);
    }
  }

  private consumeRateWindow(raw: RawRateWindow, observedAt: Date): void {
    const usedPercent = finiteNumber(raw.used_percent);
    const windowMinutes = finiteNumber(raw.window_minutes);
    if (usedPercent === null || windowMinutes === null) {
      return;
    }

    const mapping = this.config.windowMappings.find(
      (candidate) => windowMinutes >= candidate.minMinutes && windowMinutes <= candidate.maxMinutes,
    );
    if (!mapping) {
      this.logger.debug('Ignoring an unmapped Codex rate-limit window', { windowMinutes });
      return;
    }

    const resetsAtSeconds = finiteNumber(raw.resets_at);
    const snapshot: UsageSnapshot = {
      providerId: this.id,
      providerDisplayName: this.displayName,
      windowId: mapping.id,
      windowLabel: mapping.label,
      usedPercent: clampPercent(usedPercent),
      windowMinutes,
      resetsAt: resetsAtSeconds === null ? null : new Date(resetsAtSeconds * 1000),
      observedAt,
    };
    const current = this.cursors.latest[mapping.id];
    if (!current || Date.parse(current.observedAt) <= observedAt.getTime()) {
      this.cursors.latest[mapping.id] = serializeSnapshot(snapshot);
    }
  }

  private async loadCursors(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.cursorFile, 'utf8')) as Partial<CursorState>;
      if (parsed.version === 1 && parsed.files && parsed.latest) {
        this.cursors = { version: 1, files: parsed.files, latest: parsed.latest };
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        this.logger.warn('Codex cursor cache is invalid; rebuilding from session tails');
      }
    }
  }

  private async saveCursors(): Promise<void> {
    if (this.readOnly) {
      return;
    }
    await mkdir(dirname(this.cursorFile), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.cursorFile), `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(this.cursors)}\n`, { mode: 0o600 });
    await rename(temporary, this.cursorFile);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function serializeSnapshot(snapshot: UsageSnapshot): SerializedSnapshot {
  return {
    ...snapshot,
    observedAt: snapshot.observedAt.toISOString(),
    resetsAt: snapshot.resetsAt?.toISOString() ?? null,
  };
}

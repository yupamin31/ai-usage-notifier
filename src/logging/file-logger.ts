import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { LogContext, Logger } from '../types.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface FileLoggerOptions {
  directory: string;
  retentionDays: number;
  maxMegabytes: number;
  console: boolean;
}

export class FileLogger implements Logger {
  private readonly maxBytes: number;
  private lastMaintenanceDate = '';

  public constructor(private readonly options: FileLoggerOptions) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.maxBytes = options.maxMegabytes * 1024 * 1024;
    this.maintain();
  }

  public debug(message: string, context: LogContext = {}): void {
    this.write('debug', message, context);
  }

  public info(message: string, context: LogContext = {}): void {
    this.write('info', message, context);
  }

  public warn(message: string, context: LogContext = {}): void {
    this.write('warn', message, context);
  }

  public error(message: string, context: LogContext = {}): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context: LogContext): void {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const line = `${JSON.stringify({ timestamp: now.toISOString(), level, message, ...context })}\n`;
    const target = join(this.options.directory, `notifier-${date}.log`);

    try {
      this.rotateIfOversized(target, now);
      appendFileSync(target, line, { encoding: 'utf8', mode: 0o600 });
      if (date !== this.lastMaintenanceDate) {
        this.maintain();
      }
    } catch (error) {
      // Logging must never take down the monitor. Avoid including secrets or
      // serializing the original event payload in this fallback.
      console.error(`CodexNotifier logging failure: ${String(error)}`);
    }

    if (this.options.console) {
      const output = level === 'error' ? console.error : console.log;
      output(line.trimEnd());
    }
  }

  private rotateIfOversized(target: string, now: Date): void {
    try {
      if (statSync(target).size < this.maxBytes) {
        return;
      }
      const suffix = now.toISOString().replaceAll(':', '').replaceAll('.', '-');
      renameSync(target, `${target}.${suffix}`);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private maintain(): void {
    const now = Date.now();
    const cutoff = now - this.options.retentionDays * 24 * 60 * 60 * 1000;
    this.lastMaintenanceDate = new Date(now).toISOString().slice(0, 10);

    for (const entry of readdirSync(this.options.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^notifier-\d{4}-\d{2}-\d{2}\.log(?:\..+)?$/.test(entry.name)) {
        continue;
      }
      const filePath = join(this.options.directory, basename(entry.name));
      try {
        if (statSync(filePath).mtimeMs < cutoff) {
          unlinkSync(filePath);
        }
      } catch {
        // A concurrent cleanup or Time Machine snapshot can race this check.
      }
    }
  }
}

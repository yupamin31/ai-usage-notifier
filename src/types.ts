export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export interface UsageSnapshot {
  providerId: string;
  providerDisplayName: string;
  windowId: string;
  windowLabel: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
  observedAt: Date;
}

export interface UsageProvider {
  readonly id: string;
  readonly displayName: string;
  poll(): Promise<UsageSnapshot[]>;
  /** Release persistent subprocesses or other resources on shutdown. */
  close?(): void;
}

export type NotificationKind =
  'threshold' | 'reset' | 'weeklyReset' | 'unscheduledReset' | 'test' | 'error';

export interface NotificationEvent {
  kind: NotificationKind;
  providerId: string;
  providerDisplayName: string;
  windowId: string;
  windowLabel: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: Date | null;
  occurredAt: Date;
  threshold?: number;
  error?: string;
}

export interface NotificationSink {
  send(event: NotificationEvent): Promise<void>;
}

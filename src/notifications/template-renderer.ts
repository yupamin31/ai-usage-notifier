import type { AppConfig } from '../config/schema.js';
import type { NotificationEvent, NotificationKind } from '../types.js';

export class TemplateRenderer {
  public constructor(
    private readonly templates: AppConfig['notifications']['templates'],
    private readonly timeZone: string,
  ) {}

  public render(event: NotificationEvent): string {
    const template = this.templateFor(event.kind);
    const replacements: Record<string, string> = {
      provider: event.providerDisplayName,
      window: event.windowLabel,
      windowId: event.windowId,
      usedPercent: formatPercent(event.usedPercent),
      remainingPercent: formatPercent(event.remainingPercent),
      threshold: event.threshold === undefined ? '' : formatPercent(event.threshold),
      resetAt: event.resetsAt ? formatDateTime(event.resetsAt, this.timeZone) : '不明',
      resetIn: formatDuration(event.resetsAt, event.occurredAt),
      time: formatDateTime(event.occurredAt, this.timeZone),
      error: event.error ?? '',
    };

    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name: string) => {
      return replacements[name] ?? match;
    });
  }

  private templateFor(kind: NotificationKind): string {
    switch (kind) {
      case 'threshold':
        return this.templates.threshold;
      case 'reset':
        return this.templates.reset;
      case 'weeklyReset':
        return this.templates.weeklyReset;
      case 'unscheduledReset':
        return this.templates.unscheduledReset;
      case 'test':
        return this.templates.test;
      case 'error':
        return this.templates.error;
    }
  }
}

export function formatDuration(target: Date | null, now: Date): string {
  if (!target) {
    return '不明';
  }
  const totalMinutes = Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  parts.push(`${minutes}分`);
  return parts.join(' ');
}

export function formatDateTime(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const zoneName = timeZone === 'Asia/Tokyo' ? 'JST' : timeZone;
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']} ${zoneName}`;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

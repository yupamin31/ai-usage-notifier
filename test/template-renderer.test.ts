import { describe, expect, it } from 'vitest';

import {
  formatDateTime,
  formatDuration,
  TemplateRenderer,
} from '../src/notifications/template-renderer.js';

const templates = {
  threshold: '{provider}|{window}|{usedPercent}|{remainingPercent}|{resetIn}|{time}',
  reset: 'reset {provider}',
  weeklyReset: 'weekly {provider}',
  unscheduledReset: 'unscheduled {provider} {remainingPercent} {resetAt}',
  test: 'test {time}',
  error: 'error {error}',
};

describe('TemplateRenderer', () => {
  it('renders percentages, duration, and JST time', () => {
    const renderer = new TemplateRenderer(templates, 'Asia/Tokyo');
    const now = new Date('2026-08-02T04:15:00.000Z');
    expect(
      renderer.render({
        kind: 'threshold',
        providerId: 'codex',
        providerDisplayName: 'Codex',
        windowId: 'fiveHour',
        windowLabel: '5-hour',
        usedPercent: 90,
        remainingPercent: 10,
        resetsAt: new Date('2026-08-02T06:29:00.000Z'),
        occurredAt: now,
      }),
    ).toBe('Codex|5-hour|90|10|2時間 14分|2026-08-02 13:15 JST');
  });
});

describe('format helpers', () => {
  it('clamps expired durations to zero', () => {
    expect(
      formatDuration(new Date('2026-08-02T04:14:00.000Z'), new Date('2026-08-02T04:15:00.000Z')),
    ).toBe('0分');
  });

  it('formats Tokyo time explicitly as JST', () => {
    expect(formatDateTime(new Date('2026-08-02T04:15:00.000Z'), 'Asia/Tokyo')).toBe(
      '2026-08-02 13:15 JST',
    );
  });
});

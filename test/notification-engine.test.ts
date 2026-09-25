import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configSchema, type AppConfig } from '../src/config/schema.js';
import { NotificationEngine } from '../src/core/notification-engine.js';
import { StateStore } from '../src/state/state-store.js';
import type { Logger, NotificationEvent, NotificationSink, UsageSnapshot } from '../src/types.js';

class MemorySink implements NotificationSink {
  public readonly events: NotificationEvent[] = [];

  public send(event: NotificationEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let directory: string;
let config: AppConfig;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codex-notifier-test-'));
  const raw = JSON.parse(
    await readFile(new URL('../config/config.example.json', import.meta.url), 'utf8'),
  ) as unknown;
  config = configSchema.parse(raw);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('NotificationEngine', () => {
  it('sends each threshold once and only the highest threshold on a jump', async () => {
    const sink = new MemorySink();
    const engine = await createEngine(sink);
    const reset = new Date('2026-08-02T09:00:00.000Z');

    const now = new Date('2026-08-02T04:02:00.000Z');
    await engine.process(snapshot(79, '2026-08-02T04:00:00.000Z', reset), now);
    await engine.process(snapshot(96, '2026-08-02T04:01:00.000Z', reset), now);
    await engine.process(snapshot(97, '2026-08-02T04:02:00.000Z', reset), now);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.kind).toBe('threshold');
    expect(sink.events[0]?.threshold).toBe(95);
  });

  it('sends an inferred reset once when the scheduled reset time arrives', async () => {
    const sink = new MemorySink();
    const engine = await createEngine(sink);
    const reset = new Date('2026-08-02T04:01:00.000Z');

    await engine.process(
      snapshot(95, '2026-08-02T04:00:00.000Z', reset),
      new Date('2026-08-02T04:00:00.000Z'),
    );
    await engine.tick(new Date('2026-08-02T04:02:00.000Z'));
    await engine.tick(new Date('2026-08-02T04:03:00.000Z'));

    expect(sink.events.map((event) => event.kind)).toEqual(['threshold', 'reset']);
  });

  it('detects an observed weekly restoration and sends the weekly template event', async () => {
    const sink = new MemorySink();
    const engine = await createEngine(sink);
    const reset = new Date('2026-08-09T04:00:00.000Z');

    const now = new Date('2026-08-02T04:01:00.000Z');
    await engine.process(weeklySnapshot(90, '2026-08-02T04:00:00.000Z', reset), now);
    await engine.process(weeklySnapshot(0, '2026-08-02T04:01:00.000Z', reset), now);

    expect(sink.events.map((event) => event.kind)).toEqual(['threshold', 'weeklyReset']);
  });

  it('does not duplicate a reset observed at the scheduled reset time', async () => {
    const sink = new MemorySink();
    const engine = await createEngine(sink);
    const reset = new Date('2026-08-02T04:01:00.000Z');

    await engine.process(
      snapshot(95, '2026-08-02T04:00:00.000Z', reset),
      new Date('2026-08-02T04:00:00.000Z'),
    );
    await engine.process(
      snapshot(0, '2026-08-02T04:01:00.000Z', reset),
      new Date('2026-08-02T04:01:00.000Z'),
    );
    await engine.tick(new Date('2026-08-02T04:02:00.000Z'));

    expect(sink.events.map((event) => event.kind)).toEqual(['threshold', 'reset']);
  });

  it('keeps a due low-usage reset before accepting the next schedule', async () => {
    const sink = new MemorySink();
    const engine = await createEngine(sink);
    const dueReset = new Date('2026-08-02T04:01:00.000Z');

    await engine.process(
      snapshot(10, '2026-08-02T04:00:00.000Z', dueReset),
      new Date('2026-08-02T04:00:00.000Z'),
    );
    await engine.tick(new Date('2026-08-02T04:02:00.000Z'));
    await engine.process(
      snapshot(0, '2026-08-02T04:02:00.000Z', new Date('2026-08-02T09:02:00.000Z')),
      new Date('2026-08-02T04:02:00.000Z'),
    );

    expect(sink.events.map((event) => event.kind)).toEqual(['reset']);
  });

  it('detects an early schedule change and usage drop as a possible unscheduled reset', async () => {
    const sink = new MemorySink();
    const engine = await createEngine(sink);

    await engine.process(
      snapshot(10, '2026-08-02T04:00:00.000Z', new Date('2026-08-02T09:00:00.000Z')),
      new Date('2026-08-02T04:00:00.000Z'),
    );
    await engine.process(
      snapshot(0, '2026-08-02T04:01:00.000Z', new Date('2026-08-02T10:01:00.000Z')),
      new Date('2026-08-02T04:01:00.000Z'),
    );

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: 'unscheduledReset',
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: new Date('2026-08-02T10:01:00.000Z'),
    });
  });

  it('detects a possible Claude unscheduled reset when resets_at disappears at zero', async () => {
    const sink = new MemorySink();
    const engine = await createEngine(sink);
    const claudeSnapshot = (usedPercent: number, observedAt: string, resetsAt: Date | null) => ({
      ...snapshot(usedPercent, observedAt, resetsAt),
      providerId: 'claude',
      providerDisplayName: 'Claude',
    });

    await engine.process(
      claudeSnapshot(10, '2026-08-02T04:00:00.000Z', new Date('2026-08-02T09:00:00.000Z')),
      new Date('2026-08-02T04:00:00.000Z'),
    );
    await engine.process(
      claudeSnapshot(0, '2026-08-02T04:01:00.000Z', null),
      new Date('2026-08-02T04:01:00.000Z'),
    );

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: 'unscheduledReset',
      providerId: 'claude',
      remainingPercent: 100,
      resetsAt: null,
    });
  });

  it('does not label a normal reset within the polling grace period as unscheduled', async () => {
    const sink = new MemorySink();
    const engine = await createEngine(sink);

    await engine.process(
      snapshot(90, '2026-08-02T04:00:00.000Z', new Date('2026-08-02T04:01:00.000Z')),
      new Date('2026-08-02T04:00:00.000Z'),
    );
    await engine.process(
      snapshot(0, '2026-08-02T04:00:30.000Z', new Date('2026-08-02T09:00:30.000Z')),
      new Date('2026-08-02T04:00:30.000Z'),
    );

    expect(sink.events.map((event) => event.kind)).toEqual(['threshold', 'reset']);
  });

  it('applies threshold settings independently for Claude and Codex', async () => {
    config.notifications.providerSettings.codex = {
      enabled: true,
      thresholdsEnabled: false,
      resetsEnabled: true,
      errorsEnabled: true,
      thresholds: [80],
    };
    config.notifications.providerSettings.claude = {
      enabled: true,
      thresholdsEnabled: true,
      resetsEnabled: true,
      errorsEnabled: true,
      thresholds: [80],
    };
    const sink = new MemorySink();
    const engine = await createEngine(sink);
    const reset = new Date('2026-08-02T09:00:00.000Z');
    const now = new Date('2026-08-02T04:02:00.000Z');

    await engine.process(snapshot(90, '2026-08-02T04:01:00.000Z', reset), now);
    await engine.process(
      {
        ...snapshot(90, '2026-08-02T04:01:00.000Z', reset),
        providerId: 'claude',
        providerDisplayName: 'Claude',
      },
      now,
    );

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.providerId).toBe('claude');
  });

  async function createEngine(sink: MemorySink): Promise<NotificationEngine> {
    const store = new StateStore(join(directory, 'state.json'), silentLogger);
    const engine = new NotificationEngine(config, store, sink, silentLogger);
    await engine.initialize();
    return engine;
  }
});

function snapshot(usedPercent: number, observedAt: string, resetsAt: Date | null): UsageSnapshot {
  return {
    providerId: 'codex',
    providerDisplayName: 'Codex',
    windowId: 'fiveHour',
    windowLabel: '5-hour',
    usedPercent,
    windowMinutes: 300,
    resetsAt,
    observedAt: new Date(observedAt),
  };
}

function weeklySnapshot(usedPercent: number, observedAt: string, resetsAt: Date): UsageSnapshot {
  return {
    ...snapshot(usedPercent, observedAt, resetsAt),
    windowId: 'weekly',
    windowLabel: 'Weekly',
    windowMinutes: 10080,
  };
}

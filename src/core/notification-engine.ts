import { createHash } from 'node:crypto';

import { type AppConfig, providerNotificationSettings } from '../config/schema.js';
import type { StateStore, WindowState } from '../state/state-store.js';
import type {
  Logger,
  NotificationEvent,
  NotificationKind,
  NotificationSink,
  UsageSnapshot,
} from '../types.js';

export class NotificationEngine {
  public constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly sink: NotificationSink,
    private readonly logger: Logger,
  ) {}

  public async initialize(): Promise<void> {
    await this.store.load();
  }

  public async process(snapshot: UsageSnapshot, now = new Date()): Promise<void> {
    const notificationSettings = providerNotificationSettings(this.config, snapshot.providerId);
    const key = windowKey(snapshot.providerId, snapshot.windowId);
    const existing = this.store.getWindow(key);
    const state = existing ?? createWindowState(snapshot);
    const fingerprint = snapshotFingerprint(snapshot);
    if (state.lastSnapshotFingerprint === fingerprint) {
      return;
    }

    const firstObservation = state.lastSnapshotFingerprint === null;
    const unscheduledReset = isUnscheduledReset(
      state,
      snapshot,
      now,
      this.config.app.pollIntervalSeconds,
      this.config.notifications.restoredUsedPercent,
    );
    const restored =
      state.lastUsedPercent !== null &&
      state.lastUsedPercent >= this.config.notifications.minimumUsedBeforeRestore &&
      snapshot.usedPercent <= this.config.notifications.restoredUsedPercent;
    const cooldownPassed = resetCooldownPassed(
      state.lastResetNotificationAt,
      now,
      this.config.notifications.resetNotificationCooldownMinutes,
    );

    if (unscheduledReset) {
      state.cycle += 1;
      state.notifiedThresholds = [];
      state.scheduledResetNotified = true;
      state.lastResetNotificationAt = now.toISOString();
      await this.updateStateFromSnapshot(key, state, snapshot, now);
      await this.sendUnscheduledReset(state, snapshot, now);
      return;
    }

    if (restored) {
      state.cycle += 1;
      state.notifiedThresholds = [];
      if (cooldownPassed) {
        // The observed restoration and the scheduled reset can occur in the
        // same polling cycle. Mark the old schedule as handled before saving
        // the snapshot so tick() cannot emit the same reset a second time.
        state.scheduledResetNotified = true;
        state.lastResetNotificationAt = now.toISOString();
        await this.updateStateFromSnapshot(key, state, snapshot, now);
        await this.sendReset(state, snapshot.resetsAt, now);
        return;
      }
    }

    this.updateSchedule(state, snapshot, now);
    state.notifiedThresholds = state.notifiedThresholds.filter(
      (threshold) =>
        snapshot.usedPercent > threshold - this.config.notifications.thresholdRearmMargin,
    );

    const periodHasNotExpired = !snapshot.resetsAt || snapshot.resetsAt.getTime() > now.getTime();
    const crossed = notificationSettings.thresholds.filter(
      (threshold) =>
        snapshot.usedPercent >= threshold && !state.notifiedThresholds.includes(threshold),
    );
    state.notifiedThresholds.push(...crossed);
    state.notifiedThresholds.sort((left, right) => left - right);

    await this.updateStateFromSnapshot(key, state, snapshot, now);

    if (
      crossed.length > 0 &&
      periodHasNotExpired &&
      (!firstObservation || this.config.app.notifyOnStartup)
    ) {
      const highest = Math.max(...crossed);
      await this.emit(
        `threshold:${snapshot.providerId}:${snapshot.windowId}:${state.cycle}:${highest}`,
        {
          kind: 'threshold',
          providerId: snapshot.providerId,
          providerDisplayName: snapshot.providerDisplayName,
          windowId: snapshot.windowId,
          windowLabel: snapshot.windowLabel,
          usedPercent: snapshot.usedPercent,
          remainingPercent: 100 - snapshot.usedPercent,
          resetsAt: snapshot.resetsAt,
          occurredAt: now,
          threshold: highest,
        },
      );
    }
  }

  public async tick(now = new Date()): Promise<void> {
    for (const [key, state] of this.store.listWindows()) {
      if (!state.scheduledResetAt || state.scheduledResetNotified) {
        continue;
      }
      const scheduled = new Date(state.scheduledResetAt);
      if (scheduled.getTime() > now.getTime()) {
        continue;
      }

      const latenessMinutes = (now.getTime() - scheduled.getTime()) / 60_000;
      state.scheduledResetNotified = true;
      state.notifiedThresholds = [];
      state.lastUsedPercent = 0;
      state.cycle += 1;

      if (latenessMinutes <= this.config.notifications.lateResetNotificationMinutes) {
        state.lastResetNotificationAt = now.toISOString();
        await this.store.setWindow(key, state);
        await this.sendReset(state, scheduled, now);
      } else {
        await this.store.setWindow(key, state);
        this.logger.info('Skipped an old inferred reset notification', {
          provider: state.providerId,
          window: state.windowId,
          latenessMinutes: Math.round(latenessMinutes),
        });
      }
    }
  }

  public async reportProviderError(
    providerId: string,
    providerDisplayName: string,
    error: unknown,
    now = new Date(),
  ): Promise<void> {
    this.logger.error('Provider poll failed', {
      provider: providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!providerNotificationSettings(this.config, providerId).errorsEnabled) {
      return;
    }

    const safeMessage =
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    const hour = now.toISOString().slice(0, 13);
    const digest = createHash('sha256').update(safeMessage).digest('hex').slice(0, 12);
    await this.emit(`error:${providerId}:${hour}:${digest}`, {
      kind: 'error',
      providerId,
      providerDisplayName,
      windowId: 'monitor',
      windowLabel: 'Monitor',
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: null,
      occurredAt: now,
      error: safeMessage,
    });
  }

  private updateSchedule(state: WindowState, snapshot: UsageSnapshot, now: Date): void {
    if (!snapshot.resetsAt) {
      return;
    }
    if (
      state.scheduledResetNotified &&
      snapshot.resetsAt.getTime() > now.getTime() &&
      snapshot.resetsAt.toISOString() !== state.scheduledResetAt
    ) {
      state.scheduledResetNotified = false;
    }
    if (!state.scheduledResetNotified) {
      state.scheduledResetAt = snapshot.resetsAt.toISOString();
    }
  }

  private async updateStateFromSnapshot(
    key: string,
    state: WindowState,
    snapshot: UsageSnapshot,
    now: Date,
  ): Promise<void> {
    this.updateSchedule(state, snapshot, now);
    state.providerDisplayName = snapshot.providerDisplayName;
    state.windowLabel = snapshot.windowLabel;
    state.windowMinutes = snapshot.windowMinutes;
    state.lastUsedPercent = snapshot.usedPercent;
    state.lastSnapshotFingerprint = snapshotFingerprint(snapshot);
    await this.store.setWindow(key, state);
  }

  private async sendReset(state: WindowState, resetsAt: Date | null, now: Date): Promise<void> {
    const kind: NotificationKind = state.windowId === 'weekly' ? 'weeklyReset' : 'reset';
    await this.emit(`reset:${state.providerId}:${state.windowId}:${state.cycle}`, {
      kind,
      providerId: state.providerId,
      providerDisplayName: state.providerDisplayName,
      windowId: state.windowId,
      windowLabel: state.windowLabel,
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt,
      occurredAt: now,
    });
  }

  private async sendUnscheduledReset(
    state: WindowState,
    snapshot: UsageSnapshot,
    now: Date,
  ): Promise<void> {
    await this.emit(`unscheduled-reset:${state.providerId}:${state.windowId}:${state.cycle}`, {
      kind: 'unscheduledReset',
      providerId: state.providerId,
      providerDisplayName: state.providerDisplayName,
      windowId: state.windowId,
      windowLabel: state.windowLabel,
      usedPercent: snapshot.usedPercent,
      remainingPercent: 100 - snapshot.usedPercent,
      resetsAt: snapshot.resetsAt,
      occurredAt: now,
    });
  }

  private async emit(claimKey: string, event: NotificationEvent): Promise<void> {
    const settings = providerNotificationSettings(this.config, event.providerId);
    if (!settings.enabled || !this.config.discord.enabled) {
      return;
    }
    const eventEnabled =
      event.kind === 'threshold'
        ? settings.thresholdsEnabled
        : event.kind === 'reset' ||
            event.kind === 'weeklyReset' ||
            event.kind === 'unscheduledReset'
          ? settings.resetsEnabled
          : true;
    if (!eventEnabled || !(await this.store.claim(claimKey))) {
      return;
    }
    await this.sink.send(event);
  }
}

function createWindowState(snapshot: UsageSnapshot): WindowState {
  return {
    providerId: snapshot.providerId,
    providerDisplayName: snapshot.providerDisplayName,
    windowId: snapshot.windowId,
    windowLabel: snapshot.windowLabel,
    windowMinutes: snapshot.windowMinutes,
    lastUsedPercent: null,
    lastSnapshotFingerprint: null,
    notifiedThresholds: [],
    scheduledResetAt: snapshot.resetsAt?.toISOString() ?? null,
    scheduledResetNotified: false,
    lastResetNotificationAt: null,
    cycle: 0,
  };
}

function snapshotFingerprint(snapshot: UsageSnapshot): string {
  return [
    snapshot.observedAt.toISOString(),
    snapshot.usedPercent.toFixed(6),
    snapshot.resetsAt?.toISOString() ?? '',
  ].join('|');
}

function windowKey(providerId: string, windowId: string): string {
  return `${providerId}:${windowId}`;
}

function resetCooldownPassed(
  lastReset: string | null,
  now: Date,
  cooldownMinutes: number,
): boolean {
  if (!lastReset) {
    return true;
  }
  return now.getTime() - Date.parse(lastReset) >= cooldownMinutes * 60_000;
}

function isUnscheduledReset(
  state: WindowState,
  snapshot: UsageSnapshot,
  now: Date,
  pollIntervalSeconds: number,
  restoredUsedPercent: number,
): boolean {
  if (
    state.scheduledResetNotified ||
    !state.scheduledResetAt ||
    state.lastUsedPercent === null ||
    snapshot.usedPercent >= state.lastUsedPercent
  ) {
    return false;
  }

  const previousResetAt = Date.parse(state.scheduledResetAt);
  if (!Number.isFinite(previousResetAt)) {
    return false;
  }

  // A normal reset can appear slightly before its advertised time because of
  // polling and clock skew. Only label a reset as unscheduled when the old
  // deadline is still at least two polling intervals away and the new
  // deadline moved materially later. Claude can remove resets_at entirely
  // when a five-hour window returns to zero, so that combination is also a
  // strong early-reset signal.
  const graceMilliseconds = Math.max(120, pollIntervalSeconds * 2) * 1000;
  const scheduleMovedLater =
    snapshot.resetsAt !== null && snapshot.resetsAt.getTime() - previousResetAt > graceMilliseconds;
  const scheduleDisappearedAtRestore =
    snapshot.resetsAt === null && snapshot.usedPercent <= restoredUsedPercent;
  return (
    previousResetAt - now.getTime() > graceMilliseconds &&
    (scheduleMovedLater || scheduleDisappearedAtRestore)
  );
}

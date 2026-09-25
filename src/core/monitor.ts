import type { Logger, UsageProvider, UsageSnapshot } from '../types.js';
import { ProviderPollError } from '../providers/provider-poll-error.js';

interface NotificationProcessor {
  process(snapshot: UsageSnapshot): Promise<void>;
  tick(): Promise<void>;
  reportProviderError(
    providerId: string,
    providerDisplayName: string,
    error: unknown,
    now?: Date,
  ): Promise<void>;
}

interface DelayedFailureState {
  incidentKey: string;
  firstSeenAtMilliseconds: number;
  notificationSent: boolean;
}

export class Monitor {
  private stopping = false;
  private activePoll: Promise<UsageSnapshot[]> | null = null;
  private readonly delayedFailures = new Map<string, DelayedFailureState>();

  public constructor(
    private readonly providers: UsageProvider[],
    private readonly engine: NotificationProcessor,
    private readonly pollIntervalMilliseconds: number,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly onSnapshots?: (snapshots: UsageSnapshot[]) => void,
  ) {}

  public stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    for (const provider of this.providers) {
      try {
        provider.close?.();
      } catch (error) {
        this.logger.warn('Usage provider shutdown failed', {
          provider: provider.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public runOnce(): Promise<UsageSnapshot[]> {
    if (this.activePoll) {
      return this.activePoll;
    }
    this.activePoll = this.performRunOnce().finally(() => {
      this.activePoll = null;
    });
    return this.activePoll;
  }

  private async performRunOnce(): Promise<UsageSnapshot[]> {
    const settled = await Promise.allSettled(
      this.providers.map(async (provider) => provider.poll()),
    );
    const snapshots: UsageSnapshot[] = [];

    for (const [index, result] of settled.entries()) {
      const provider = this.providers[index];
      if (!provider) continue;
      if (result.status === 'rejected') {
        try {
          await this.handleProviderFailure(provider, result.reason);
        } catch (error) {
          this.logger.error('Provider error notification failed', {
            provider: provider.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      if (this.delayedFailures.delete(provider.id)) {
        this.logger.info('Provider recovered before a delayed error notification', {
          provider: provider.id,
        });
      }
      snapshots.push(...result.value);
    }

    snapshots.sort((left, right) =>
      `${left.providerId}:${left.windowId}`.localeCompare(`${right.providerId}:${right.windowId}`),
    );
    // Preserve an already-due reset before a fresh snapshot can replace its
    // reset timestamp with the next usage window's schedule.
    await this.engine.tick();
    for (const snapshot of snapshots) {
      try {
        await this.engine.process(snapshot);
      } catch (error) {
        this.logger.error('Usage snapshot processing failed', {
          provider: snapshot.providerId,
          window: snapshot.windowId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Newly observed stale schedules (for example after startup) still need
    // the existing lateness handling in the same monitoring cycle.
    await this.engine.tick();
    this.onSnapshots?.(snapshots);
    return snapshots;
  }

  private async handleProviderFailure(provider: UsageProvider, error: unknown): Promise<void> {
    if (!(error instanceof ProviderPollError) || error.notificationDelayMilliseconds <= 0) {
      this.delayedFailures.delete(provider.id);
      await this.engine.reportProviderError(provider.id, provider.displayName, error, this.now());
      return;
    }

    const now = this.now();
    const existing = this.delayedFailures.get(provider.id);
    const state: DelayedFailureState =
      existing?.incidentKey === error.incidentKey
        ? existing
        : {
            incidentKey: error.incidentKey,
            firstSeenAtMilliseconds: now.getTime(),
            notificationSent: false,
          };
    this.delayedFailures.set(provider.id, state);

    const elapsedMilliseconds = now.getTime() - state.firstSeenAtMilliseconds;
    if (elapsedMilliseconds < error.notificationDelayMilliseconds) {
      this.logger.warn('Provider error notification deferred', {
        provider: provider.id,
        incidentKey: error.incidentKey,
        elapsedSeconds: Math.floor(elapsedMilliseconds / 1000),
        notifyAfterSeconds: Math.ceil(error.notificationDelayMilliseconds / 1000),
      });
      return;
    }

    if (state.notificationSent) {
      this.logger.warn('Persistent provider error already notified', {
        provider: provider.id,
        incidentKey: error.incidentKey,
      });
      return;
    }

    await this.engine.reportProviderError(provider.id, provider.displayName, error, now);
    state.notificationSent = true;
  }

  public async runForever(): Promise<void> {
    this.logger.info('Usage monitor started', {
      providers: this.providers.map((provider) => provider.id),
      pollIntervalMilliseconds: this.pollIntervalMilliseconds,
    });

    while (!this.stopping) {
      const startedAt = Date.now();
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Unexpected monitor cycle failure', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const elapsed = Date.now() - startedAt;
      await this.wait(Math.max(1000, this.pollIntervalMilliseconds - elapsed));
    }
    this.logger.info('Usage monitor stopped');
  }

  private async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(stopPolling);
        resolvePromise();
      };
      const timer = setTimeout(finish, milliseconds);
      const stopPolling = setInterval(
        () => {
          if (this.stopping) {
            finish();
          }
        },
        Math.min(1000, milliseconds),
      );
    });
  }
}

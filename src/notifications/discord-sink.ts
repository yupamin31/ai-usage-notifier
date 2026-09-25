import type { AppConfig } from '../config/schema.js';
import type { Logger, NotificationEvent, NotificationSink } from '../types.js';
import type { TemplateRenderer } from './template-renderer.js';

export class DiscordSink implements NotificationSink {
  public constructor(
    private readonly botToken: string,
    private readonly channelId: string,
    private readonly config: AppConfig['discord'],
    private readonly renderer: TemplateRenderer,
    private readonly logger: Logger,
  ) {}

  public async send(event: NotificationEvent): Promise<void> {
    const content = this.renderer.render(event);
    const payload = {
      content,
      allowed_mentions: { parse: [] },
    };

    const url = new URL(`https://discord.com/api/v10/channels/${this.channelId}/messages`);

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.requestTimeoutSeconds * 1000,
      );
      timeout.unref();

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bot ${this.botToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        // A transport timeout is ambiguous: Discord may have accepted the
        // message. Do not retry it automatically, which prevents duplicates.
        throw new Error('Discord Bot request failed before a response was received', {
          cause: error,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) {
        this.logger.info('Discord Bot notification delivered', {
          kind: event.kind,
          provider: event.providerId,
          window: event.windowId,
        });
        return;
      }

      const retryDelay = await retryDelayMilliseconds(response, attempt);
      const canRetry =
        attempt < this.config.maxRetries &&
        (response.status === 429 || (response.status >= 500 && response.status <= 599));
      if (!canRetry) {
        throw new Error(`Discord rejected the Bot request with HTTP ${response.status}`);
      }
      await delay(retryDelay);
    }
  }
}

export class ConsoleSink implements NotificationSink {
  public constructor(private readonly renderer: TemplateRenderer) {}

  public send(event: NotificationEvent): Promise<void> {
    console.log(
      `\n--- dry-run notification ---\n${this.renderer.render(event)}\n----------------------------`,
    );
    return Promise.resolve();
  }
}

async function retryDelayMilliseconds(response: Response, attempt: number): Promise<number> {
  if (response.status === 429) {
    try {
      const body = (await response.json()) as { retry_after?: unknown };
      if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) {
        return Math.min(30_000, Math.max(250, body.retry_after * 1000));
      }
    } catch {
      // Fall through to exponential backoff when Discord did not return JSON.
    }
  }
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

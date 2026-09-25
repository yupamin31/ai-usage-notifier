/**
 * A provider failure with notification policy metadata.
 *
 * The monitor uses incidentKey to group consecutive occurrences. A successful
 * poll or a different incident key resets the delay timer.
 */
export class ProviderPollError extends Error {
  public override readonly name = 'ProviderPollError';

  public constructor(
    message: string,
    public readonly incidentKey: string,
    public readonly notificationDelayMilliseconds = 0,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

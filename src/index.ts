#!/usr/bin/env node
import { join, resolve } from 'node:path';

import { ConfigRepository } from './config/config-repository.js';
import { loadConfig } from './config/load.js';
import { Monitor } from './core/monitor.js';
import { NotificationEngine } from './core/notification-engine.js';
import { FileLogger } from './logging/file-logger.js';
import { ConsoleSink, DiscordSink } from './notifications/discord-sink.js';
import { formatDuration, TemplateRenderer } from './notifications/template-renderer.js';
import { ClaudeUsageProvider } from './providers/claude-usage-provider.js';
import { CodexAppServerProvider } from './providers/codex-app-server-provider.js';
import { CodexSessionProvider } from './providers/codex-session-provider.js';
import { JsonFileProvider } from './providers/json-file-provider.js';
import { StateStore } from './state/state-store.js';
import type { NotificationEvent, NotificationSink, UsageProvider, UsageSnapshot } from './types.js';
import { DashboardServer } from './web/dashboard-server.js';

interface CliOptions {
  configPath: string;
  once: boolean;
  dryRun: boolean;
  printStatus: boolean;
  testWebhook: boolean;
  testReset: boolean;
}

async function main(): Promise<void> {
  process.umask(0o077);
  const options = parseArguments(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const logger = new FileLogger({
    directory: process.env['CODEX_NOTIFIER_LOG_DIR'] ?? config.app.logDirectory,
    retentionDays: config.app.logRetentionDays,
    maxMegabytes: config.app.logMaxMegabytes,
    console: true,
  });
  const renderer = new TemplateRenderer(config.notifications.templates, config.app.timeZone);
  const sink = createSink(options, config, renderer, logger);

  if (options.testWebhook) {
    await sink.send(testEvent('codex', 'Codex'));
    await sink.send(testEvent('claude', 'Claude'));
    console.log('Discord Bot tests for Codex and Claude completed successfully.');
    return;
  }
  if (options.testReset) {
    await sink.send(resetTestEvent('claude'));
    await sink.send(resetTestEvent('codex'));
    console.log('Discord Bot 100% reset test completed successfully.');
    return;
  }

  const stateDirectory = process.env['CODEX_NOTIFIER_STATE_DIR'] ?? config.app.stateDirectory;
  const stateStore = new StateStore(join(stateDirectory, 'state.json'), logger, options.dryRun);
  const engine = new NotificationEngine(config, stateStore, sink, logger);
  await engine.initialize();

  const providers = createProviders(config, stateDirectory, logger, options.dryRun);
  if (providers.length === 0) {
    throw new Error('No usage providers are enabled in config/config.json');
  }

  const dashboard = new DashboardServer(
    config,
    resolve(options.configPath, '..', '..', 'webui'),
    new ConfigRepository(resolve(options.configPath), config, logger),
    logger,
  );
  const monitor = new Monitor(
    providers,
    engine,
    config.app.pollIntervalSeconds * 1000,
    logger,
    () => new Date(),
    (snapshots) => dashboard.updateSnapshots(snapshots),
  );
  dashboard.setActions({
    refresh: async () => {
      await monitor.runOnce();
    },
    sendTest: async (kind, providerId) => {
      const displayName = providerId === 'claude' ? 'Claude' : 'Codex';
      await sink.send(
        kind === 'reset' ? resetTestEvent(providerId) : testEvent(providerId, displayName),
      );
    },
  });
  const stop = (): void => {
    monitor.stop();
    void dashboard.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  if (options.once) {
    try {
      const snapshots = await monitor.runOnce();
      if (options.printStatus) {
        printStatus(snapshots);
      }
    } finally {
      monitor.stop();
    }
    return;
  }

  await dashboard.start();
  try {
    await monitor.runForever();
  } finally {
    await dashboard.stop();
  }
}

function createSink(
  options: CliOptions,
  config: Awaited<ReturnType<typeof loadConfig>>,
  renderer: TemplateRenderer,
  logger: FileLogger,
): NotificationSink {
  if (options.dryRun) {
    return new ConsoleSink(renderer);
  }
  const botToken = process.env[config.discord.botTokenEnv];
  if (!botToken) {
    throw new Error(`${config.discord.botTokenEnv} is required. Run the Bot setup script.`);
  }
  const channelId = process.env[config.discord.channelIdEnv];
  if (!channelId || !/^\d{17,20}$/.test(channelId)) {
    throw new Error(`${config.discord.channelIdEnv} must be a Discord channel ID.`);
  }
  return new DiscordSink(botToken, channelId, config.discord, renderer, logger);
}

function createProviders(
  config: Awaited<ReturnType<typeof loadConfig>>,
  stateDirectory: string,
  logger: FileLogger,
  readOnly: boolean,
): UsageProvider[] {
  const providers: UsageProvider[] = [];
  if (config.providers.codex.enabled) {
    const sessionFallback = new CodexSessionProvider(
      config.providers.codex,
      join(stateDirectory, 'codex-cursors.json'),
      logger,
      readOnly,
    );
    providers.push(new CodexAppServerProvider(config.providers.codex, sessionFallback, logger));
  }
  if (config.providers.claude.enabled) {
    providers.push(new ClaudeUsageProvider(config.providers.claude, logger));
  }
  if (config.providers.gemini.enabled) {
    providers.push(new JsonFileProvider('gemini', config.providers.gemini, logger));
  }
  return providers;
}

function parseArguments(arguments_: string[]): CliOptions {
  const defaultConfig =
    process.env['CODEX_NOTIFIER_CONFIG'] ?? resolve(process.cwd(), 'config/config.json');
  const options: CliOptions = {
    configPath: defaultConfig,
    once: false,
    dryRun: false,
    printStatus: false,
    testWebhook: false,
    testReset: false,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case '--config': {
        const path = arguments_[index + 1];
        if (!path) throw new Error('--config requires a path');
        options.configPath = path;
        index += 1;
        break;
      }
      case '--once':
        options.once = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--print-status':
        options.printStatus = true;
        break;
      case '--test-webhook':
      case '--test-discord':
        options.testWebhook = true;
        break;
      case '--test-reset':
        options.testReset = true;
        break;
      default:
        throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }
  return options;
}

function printStatus(snapshots: UsageSnapshot[]): void {
  if (snapshots.length === 0) {
    console.log('No usage snapshots found yet. Run at least one Codex task and try again.');
    return;
  }
  const now = new Date();
  console.log(
    JSON.stringify(
      snapshots.map((snapshot) => ({
        provider: snapshot.providerDisplayName,
        window: snapshot.windowLabel,
        usedPercent: snapshot.usedPercent,
        remainingPercent: 100 - snapshot.usedPercent,
        resetIn: formatDuration(snapshot.resetsAt, now),
        resetsAt: snapshot.resetsAt?.toISOString() ?? null,
        observedAt: snapshot.observedAt.toISOString(),
      })),
      null,
      2,
    ),
  );
}

function testEvent(providerId: string, providerDisplayName: string): NotificationEvent {
  return {
    kind: 'test',
    providerId,
    providerDisplayName,
    windowId: 'test',
    windowLabel: 'テスト',
    usedPercent: 0,
    remainingPercent: 100,
    resetsAt: null,
    occurredAt: new Date(),
  };
}

function resetTestEvent(providerId: 'claude' | 'codex'): NotificationEvent {
  const providerDisplayName = providerId === 'claude' ? 'Claude' : 'Codex';
  return {
    kind: 'reset',
    providerId,
    providerDisplayName,
    windowId: 'test-reset',
    windowLabel: '5時間 / 週間',
    usedPercent: 0,
    remainingPercent: 100,
    resetsAt: null,
    occurredAt: new Date(),
  };
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

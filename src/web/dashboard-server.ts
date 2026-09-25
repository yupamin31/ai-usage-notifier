import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { ZodError } from 'zod';

import type { AppConfig } from '../config/schema.js';
import type { ConfigRepository } from '../config/config-repository.js';
import type { Logger, UsageSnapshot } from '../types.js';

interface SerializedWindow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  observedAt: string;
}

interface SerializedProvider {
  id: string;
  name: string;
  windows: SerializedWindow[];
}

interface DashboardActions {
  refresh: () => Promise<void>;
  sendTest: (kind: 'connection' | 'reset', providerId: 'claude' | 'codex') => Promise<void>;
}

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
};

export class DashboardServer {
  private server: Server | null = null;
  private readonly snapshots = new Map<string, UsageSnapshot>();
  private updatedAt: Date | null = null;
  private actions: DashboardActions | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly assetsDirectory: string,
    private readonly configRepository: ConfigRepository,
    private readonly logger: Logger,
  ) {}

  public setActions(actions: DashboardActions): void {
    this.actions = actions;
  }

  public updateSnapshots(snapshots: UsageSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.snapshots.set(`${snapshot.providerId}:${snapshot.windowId}`, structuredClone(snapshot));
    }
    this.updatedAt = new Date();
  }

  public async start(): Promise<void> {
    if (this.server || !this.config.web.enabled) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        const isBadRequest =
          error instanceof SyntaxError ||
          error instanceof ZodError ||
          (error instanceof Error && error.message === 'Request body is too large');
        this.logger.error('Dashboard request failed', {
          method: request.method,
          path: request.url,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          this.sendJson(response, isBadRequest ? 400 : 500, {
            error: isBadRequest ? '設定値が不正です' : '処理に失敗しました',
          });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(this.config.web.port, this.config.web.host, () => resolvePromise());
    });
    if (this.server !== server) {
      await closeServer(server);
      return;
    }
    this.logger.info('Usage dashboard started', {
      url: `http://${this.config.web.host}:${this.config.web.port}`,
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    if (!server.listening) return;
    await closeServer(server);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/api/status' && request.method === 'GET') {
      this.sendJson(response, 200, this.statusPayload());
      return;
    }
    if (pathname === '/api/settings' && request.method === 'PATCH') {
      if (!this.hasSameOrigin(request)) {
        this.sendJson(response, 403, { error: 'Origin not allowed' });
        return;
      }
      const settings = await this.configRepository.updateDashboardSettings(
        await this.readJsonBody(request),
      );
      this.sendJson(response, 200, { settings });
      return;
    }
    if (pathname === '/api/refresh' && request.method === 'POST') {
      if (!this.hasSameOrigin(request)) {
        this.sendJson(response, 403, { error: 'Origin not allowed' });
        return;
      }
      if (!this.actions) {
        this.sendJson(response, 503, { error: '監視処理を準備中です' });
        return;
      }
      await this.actions.refresh();
      this.sendJson(response, 200, this.statusPayload());
      return;
    }
    if (pathname === '/api/test-discord' && request.method === 'POST') {
      if (!this.hasSameOrigin(request)) {
        this.sendJson(response, 403, { error: 'Origin not allowed' });
        return;
      }
      if (!this.config.discord.enabled) {
        this.sendJson(response, 409, { error: 'Discord通知がOFFです' });
        return;
      }
      if (!this.actions) {
        this.sendJson(response, 503, { error: '通知処理を準備中です' });
        return;
      }
      const kind = url.searchParams.get('kind');
      const providerId = url.searchParams.get('provider');
      if (kind !== 'connection' && kind !== 'reset') {
        this.sendJson(response, 400, { error: 'Unknown test kind' });
        return;
      }
      if (providerId !== 'claude' && providerId !== 'codex') {
        this.sendJson(response, 400, { error: 'Unknown provider' });
        return;
      }
      await this.actions.sendTest(kind, providerId);
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname.startsWith('/api/')) {
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      this.sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    const asset = STATIC_FILES[pathname];
    if (!asset) {
      this.sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const filePath = join(this.assetsDirectory, asset.file);
    try {
      await stat(filePath);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        'content-type': asset.contentType,
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
      createReadStream(filePath).pipe(response);
    } catch (error) {
      this.logger.error('Dashboard asset could not be served', {
        file: asset.file,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendJson(response, 500, { error: 'Dashboard asset unavailable' });
    }
  }

  private statusPayload(): {
    updatedAt: string | null;
    refreshSeconds: number;
    providers: SerializedProvider[];
    settings: ReturnType<ConfigRepository['getDashboardSettings']>;
  } {
    const providers = new Map<string, SerializedProvider>();
    for (const snapshot of this.snapshots.values()) {
      const provider = providers.get(snapshot.providerId) ?? {
        id: snapshot.providerId,
        name: snapshot.providerDisplayName,
        windows: [],
      };
      provider.windows.push({
        id: snapshot.windowId,
        label: snapshot.windowLabel,
        usedPercent: snapshot.usedPercent,
        remainingPercent: Math.max(0, 100 - snapshot.usedPercent),
        resetsAt: snapshot.resetsAt?.toISOString() ?? null,
        observedAt: snapshot.observedAt.toISOString(),
      });
      providers.set(snapshot.providerId, provider);
    }
    for (const provider of providers.values()) {
      provider.windows.sort((left, right) => left.id.localeCompare(right.id));
    }
    return {
      updatedAt: this.updatedAt?.toISOString() ?? null,
      refreshSeconds: this.config.web.refreshSeconds,
      providers: [...providers.values()].sort((left, right) => left.id.localeCompare(right.id)),
      settings: this.configRepository.getDashboardSettings(),
    };
  }

  private hasSameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    const host = request.headers.host;
    if (!host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      totalBytes += buffer.length;
      if (totalBytes > 16 * 1024) {
        throw new Error('Request body is too large');
      }
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    response.end(`${JSON.stringify(body)}\n`);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

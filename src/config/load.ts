import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { ZodError } from 'zod';

import { configSchema, type AppConfig } from './schema.js';

export function expandPath(input: string, baseDirectory = process.cwd()): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/')) {
    return resolve(homedir(), input.slice(2));
  }
  return isAbsolute(input) ? input : resolve(baseDirectory, input);
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absoluteConfigPath = expandPath(configPath);
  const projectDirectory = resolve(absoluteConfigPath, '..', '..');

  // launchd does not load shell profiles. Loading .env here keeps credentials
  // out of plist files and makes foreground/LaunchAgent behavior identical.
  loadDotEnv({ path: resolve(projectDirectory, '.env'), quiet: true });

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absoluteConfigPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read config file: ${absoluteConfigPath}`, { cause: error });
  }

  try {
    const parsed = configSchema.parse(raw);
    return {
      ...parsed,
      app: {
        ...parsed.app,
        stateDirectory: expandPath(parsed.app.stateDirectory, projectDirectory),
        logDirectory: expandPath(parsed.app.logDirectory, projectDirectory),
      },
      providers: {
        codex: {
          ...parsed.providers.codex,
          sessionsDirectory: expandPath(
            process.env['CODEX_HOME']
              ? resolve(expandPath(process.env['CODEX_HOME']), 'sessions')
              : parsed.providers.codex.sessionsDirectory,
            projectDirectory,
          ),
        },
        claude: parsed.providers.claude,
        gemini: {
          ...parsed.providers.gemini,
          sourceFile: expandPath(parsed.providers.gemini.sourceFile, projectDirectory),
        },
      },
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid configuration: ${details}`, { cause: error });
    }
    throw error;
  }
}

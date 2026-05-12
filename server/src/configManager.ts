/**
 * ConfigManager — File-based settings persistence for Pixel Agents standalone.
 *
 * Stores user preferences in ~/.pixel-agents/config.json
 * Layout persistence is also handled here (separate file for atomic writes).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PixelAgentsConfig {
  soundEnabled: boolean;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  hooksInfoShown: boolean;
  lastSeenVersion: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
}

const CONFIG_DIR = path.join(os.homedir(), '.pixel-agents');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LAYOUT_PATH = path.join(CONFIG_DIR, 'layout.json');

const DEFAULT_CONFIG: PixelAgentsConfig = {
  soundEnabled: false,
  watchAllSessions: false,
  alwaysShowLabels: false,
  hooksInfoShown: true,
  lastSeenVersion: '0.0',
};

export class ConfigManager {
  private config: PixelAgentsConfig;

  constructor() {
    this.config = this.loadInternal();
  }

  /** Load config from disk, return current value. */
  private loadInternal(): PixelAgentsConfig {
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        return { ...DEFAULT_CONFIG };
      }
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** Get current config snapshot. */
  get(): PixelAgentsConfig {
    return { ...this.config };
  }

  /** Apply partial updates and persist. */
  update(partial: Partial<PixelAgentsConfig>): PixelAgentsConfig {
    this.config = { ...this.config, ...partial };
    this.persist();
    return this.get();
  }

  /** Atomic write to disk. */
  private persist(): void {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      }
      const tmpPath = CONFIG_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, CONFIG_PATH);
    } catch (e) {
      console.error('[ConfigManager] Failed to persist config:', e);
    }
  }

  // ── Layout persistence ────────────────────────────────────────────────────

  /** Load saved layout or return null. */
  loadLayout(): Record<string, unknown> | null {
    try {
      if (!fs.existsSync(LAYOUT_PATH)) return null;
      return JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf-8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Save layout atomically. */
  saveLayout(layout: Record<string, unknown>): void {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      }
      const tmpPath = LAYOUT_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(layout, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, LAYOUT_PATH);
    } catch (e) {
      console.error('[ConfigManager] Failed to save layout:', e);
    }
  }
}

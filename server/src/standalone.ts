/**
 * Pixel Agents Standalone Server
 *
 * Serves the Vite-built frontend, provides a WebSocket endpoint for
 * real-time agent state updates via OpenClaw gateway integration,
 * and persists user settings + layout to disk.
 *
 * Optional security (opt-in via env vars):
 *   API_TOKEN=<secret>      — Bearer auth for /api/* and /ws
 *   TLS_CERT=<path>         — HTTPS/WSS (also requires TLS_KEY)
 *   TLS_KEY=<path>          — TLS private key
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';

import { ConfigManager } from './configManager.js';
import { OpenClawClient, type AgentEvent, type AgentSession } from './openclaw-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

// Resolve project root (dist/server/ → project root)
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_DIST = join(PROJECT_ROOT, 'dist', 'webview');

const PORT = parseInt(process.env.PORT || '19100', 10);

// ── Optional auth token ──────────────────────────────────────────────────────
const API_TOKEN = process.env['API_TOKEN'] || '';
const requiresAuth = API_TOKEN.length > 0;

/** Check Authorization header against API_TOKEN. */
function authOk(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  if (!requiresAuth) return true;
  const header = req.headers['authorization'];
  if (!header) return false;
  const match = (Array.isArray(header) ? header[0] : header).match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  return match[1] === API_TOKEN;
}

/** Express middleware — 401 if auth is required and missing. */
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!requiresAuth) return next();
  if (authOk(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

/** Validate WebSocket upgrade request against API_TOKEN. */
function wsAuthOk(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  if (!requiresAuth) return true;
  return authOk(req);
}

// ── TLS ──────────────────────────────────────────────────────────────────────

const TLS_CERT = process.env['TLS_CERT'] || '';
const TLS_KEY = process.env['TLS_KEY'] || '';
const useTls = !!(TLS_CERT && TLS_KEY && existsSync(TLS_CERT) && existsSync(TLS_KEY));

let tlsOptions: { cert: string; key: string } | undefined;
if (useTls) {
  tlsOptions = {
    cert: readFileSync(TLS_CERT, 'utf-8'),
    key: readFileSync(TLS_KEY, 'utf-8'),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const proto = useTls ? 'https' : 'http';
  const wsProto = useTls ? 'wss' : 'ws';

  if (requiresAuth) {
    console.log(`[PixelAgents] Auth enabled (API_TOKEN set)`);
  }
  if (useTls) {
    console.log(`[PixelAgents] TLS enabled (${TLS_CERT})`);
  }

  console.log(`[PixelAgents] Starting standalone server on port ${PORT}...`);
  console.log(`[PixelAgents] Webview dist: ${WEBVIEW_DIST}`);

  if (!existsSync(WEBVIEW_DIST)) {
    console.error(`[PixelAgents] Webview dist not found at ${WEBVIEW_DIST}`);
    console.error(`[PixelAgents] Run: npm run build:webview`);
    process.exit(1);
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  const config = new ConfigManager();

  // ── Express app ─────────────────────────────────────────────────────────────

  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Auth middleware for /api/*
  app.use('/api', authMiddleware);

  // Serve static frontend
  app.use('/assets', express.static(join(WEBVIEW_DIST, 'assets'), {
    maxAge: '1y',
    immutable: true,
  }));
  app.use('/fonts', express.static(join(WEBVIEW_DIST, 'fonts'), {
    maxAge: '1y',
    immutable: true,
  }));

  // Health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Settings API
  app.get('/api/settings', (_req, res) => {
    res.json(config.get());
  });

  app.post('/api/settings', (req, res) => {
    const updates = req.body as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    if (typeof updates.soundEnabled === 'boolean') sanitized.soundEnabled = updates.soundEnabled;
    if (typeof updates.watchAllSessions === 'boolean') sanitized.watchAllSessions = updates.watchAllSessions;
    if (typeof updates.alwaysShowLabels === 'boolean') sanitized.alwaysShowLabels = updates.alwaysShowLabels;
    if (typeof updates.hooksInfoShown === 'boolean') sanitized.hooksInfoShown = updates.hooksInfoShown;
    if (typeof updates.lastSeenVersion === 'string') sanitized.lastSeenVersion = updates.lastSeenVersion;
    config.update(sanitized as Partial<import('./configManager.js').PixelAgentsConfig>);
    res.json({ ok: true, config: config.get() });
  });

  // Layout API
  app.get('/api/layout', (_req, res) => {
    const layout = config.loadLayout();
    if (layout) {
      res.json({ ok: true, layout });
    } else {
      res.json({ ok: true, layout: null });
    }
  });

  app.post('/api/layout', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.layout) {
      config.saveLayout(body.layout as Record<string, unknown>);
      res.json({ ok: true });
    } else {
      res.status(400).json({ ok: false, error: 'Missing layout field' });
    }
  });

  // Agent spawn API
  app.post('/api/spawn', (_req, res) => {
    openclaw.spawnAgent('New agent spawned from Pixel Agents');
    res.json({ ok: true });
  });

  // HTML must never be cached
  app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // Serve static files (no auth — these are public assets)
  app.use(express.static(WEBVIEW_DIST));

  // Fallback to index.html for SPA routing
  app.use((_req, res) => {
    res.sendFile(join(WEBVIEW_DIST, 'index.html'));
  });

  // ── HTTP(S) + WebSocket server ─────────────────────────────────────────────

  const httpServer = useTls
    ? createTlsServer(tlsOptions!, app)
    : createServer(app);

  // WebSocket with optional auth check on upgrade
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    verifyClient: (info, cb) => {
      if (wsAuthOk(info.req as unknown as { headers: Record<string, string | string[] | undefined> })) {
        cb(true);
      } else {
        cb(false, 401, 'unauthorized');
      }
    },
  });

  const wsClients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    console.log('[PixelAgents] Frontend connected');
    wsClients.add(ws);

    // Send current settings + layout immediately
    sendToClient(ws, {
      type: 'settings_loaded',
      ...config.get(),
      extensionVersion: '1.3.0',
    });

    const layout = config.loadLayout();
    sendToClient(ws, {
      type: 'layout_loaded',
      layout,
    });

    const sessions = openclaw.getSessions();
    sendToClient(ws, {
      type: 'initial_state',
      sessions: sessions.map((s) => serializeSession(s)),
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleClientMessage(ws, msg);
      } catch (err) {
        console.error('[PixelAgents] Invalid WS message:', err);
      }
    });

    ws.on('close', () => {
      console.log('[PixelAgents] Frontend disconnected');
      wsClients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('[PixelAgents] WS error:', err.message);
      wsClients.delete(ws);
    });
  });

  // ── Client message handler ──────────────────────────────────────────────────

  function handleClientMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'saveLayout': {
        const layout = msg.layout as Record<string, unknown>;
        if (layout) {
          config.saveLayout(layout);
          sendToClient(ws, { type: 'layout_saved', ok: true });
        }
        break;
      }
      case 'setSoundEnabled': {
        const enabled = msg.enabled as boolean;
        config.update({ soundEnabled: enabled });
        broadcast({ type: 'sound_enabled', enabled });
        break;
      }
      case 'setWatchAllSessions': {
        const enabled = msg.enabled as boolean;
        config.update({ watchAllSessions: enabled });
        break;
      }
      case 'setAlwaysShowLabels': {
        const enabled = msg.enabled as boolean;
        config.update({ alwaysShowLabels: enabled });
        break;
      }
      case 'setLastSeenVersion': {
        const version = msg.version as string;
        config.update({ lastSeenVersion: version });
        break;
      }
      case 'setHooksEnabled': {
        config.update({ ...config.get() });
        break;
      }
      case 'setHooksInfoShown': {
        config.update({ hooksInfoShown: true });
        break;
      }
      case 'openClaude': {
        openclaw.spawnAgent('New agent spawned from Pixel Agents panel');
        break;
      }
      case 'closeAgent': {
        const agentId = msg.id as number;
        broadcast({ type: 'agent_remove', id: agentId });
        break;
      }
      case 'focusAgent': {
        // No terminal to focus in standalone mode
        break;
      }
      default:
        console.log('[PixelAgents] Unknown client message:', msg.type);
    }
  }

  // ── Broadcast helpers ──────────────────────────────────────────────────────

  function sendToClient(ws: WebSocket, event: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(event));
      } catch { /* ignore */ }
    }
  }

  function broadcast(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch { /* ignore */ }
      }
    }
  }

  // ── OpenClaw Gateway client ─────────────────────────────────────────────────

  const openclaw = new OpenClawClient();

  openclaw.on('agent_join', (event: AgentEvent) => {
    broadcast({ type: 'agent_join', session: serializeSession(event.session) });
  });

  openclaw.on('agent_leave', (event: AgentEvent) => {
    broadcast({ type: 'agent_leave', sessionKey: event.session.key });
  });

  openclaw.on('agent_active', (event: AgentEvent) => {
    broadcast({ type: 'agent_update', session: serializeSession({ ...event.session, isActive: true }), active: true });
  });

  openclaw.on('agent_idle', (event: AgentEvent) => {
    broadcast({ type: 'agent_update', session: serializeSession({ ...event.session, isActive: false }), active: false });
  });

  openclaw.on('agent_waiting', (event: AgentEvent) => {
    broadcast({ type: 'agent_waiting', sessionKey: event.session.key });
  });

  openclaw.on('agent_permission', (event: AgentEvent) => {
    broadcast({ type: 'agent_permission', sessionKey: event.session.key, toolName: event.toolName, toolId: event.toolId });
  });

  openclaw.on('agent_tool_start', (event: AgentEvent) => {
    broadcast({ type: 'agent_tool_start', session: serializeSession(event.session), toolName: event.toolName, toolId: event.toolId || `tool-${Date.now()}` });
  });

  openclaw.on('agent_tool_end', (event: AgentEvent) => {
    broadcast({ type: 'agent_tool_end', session: serializeSession(event.session), toolName: event.toolName, toolId: event.toolId || `tool-${Date.now()}` });
  });

  openclaw.on('subagent_join', (event: AgentEvent) => {
    broadcast({ type: 'subagent_join', session: serializeSession(event.session), toolName: event.toolName, toolId: event.toolId, parentSessionKey: event.parentSessionKey });
  });

  openclaw.on('subagent_tool_start', (event: AgentEvent) => {
    broadcast({ type: 'subagent_tool_start', session: serializeSession(event.session), toolName: event.toolName, toolId: event.toolId, parentSessionKey: event.parentSessionKey });
  });

  openclaw.on('subagent_leave', (event: AgentEvent) => {
    broadcast({ type: 'subagent_leave', sessionKey: event.session.key });
  });

  openclaw.on('connected', () => {
    console.log('[PixelAgents] Reconnected to OpenClaw gateway, re-sending sessions');
    broadcast({ type: 'initial_state', sessions: openclaw.getSessions().map((s) => serializeSession(s)) });
  });

  // ── Detect leaves via periodic session diff ────────────────────────────────

  const previousKeys = new Set<string>();
  setInterval(() => {
    const currentKeys = new Set(openclaw.getSessions().map((s) => s.key));
    for (const key of previousKeys) {
      if (!currentKeys.has(key)) broadcast({ type: 'agent_leave', sessionKey: key });
    }
    previousKeys.clear();
    for (const key of currentKeys) previousKeys.add(key);

    const subagents = openclaw.getSubagents();
    for (const [skey] of subagents) {
      if (!currentKeys.has(skey)) broadcast({ type: 'subagent_leave', sessionKey: skey });
    }
  }, 5000);

  // ── Connect to OpenClaw gateway ────────────────────────────────────────────

  try {
    await openclaw.connect();
  } catch (err) {
    console.error('[PixelAgents] Failed to connect to OpenClaw gateway:', err);
    console.log('[PixelAgents] Server will run without agents — reconnect in progress');
  }

  // ── Start HTTP(S) server ──────────────────────────────────────────────────

  httpServer.listen(PORT, () => {
    console.log(`[PixelAgents] Server running on ${proto}://localhost:${PORT}`);
    console.log(`[PixelAgents] WebSocket endpoint: ${wsProto}://localhost:${PORT}/ws`);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = () => {
    console.log('[PixelAgents] Shutting down...');
    openclaw.dispose();
    wss.close();
    httpServer.close(() => {
      console.log('[PixelAgents] Goodbye');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function serializeSession(s: AgentSession): Record<string, unknown> {
  return {
    id: s.sessionId,
    key: s.key,
    displayName: s.displayName,
    kind: s.kind,
    isActive: s.isActive,
    currentTool: s.currentTool || null,
    updatedAt: s.updatedAt,
  };
}

main().catch((err) => {
  console.error('[PixelAgents] Fatal error:', err);
  process.exit(1);
});

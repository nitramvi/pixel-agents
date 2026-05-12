/**
 * Pixel Agents Standalone Server
 *
 * Serves the Vite-built frontend, provides a WebSocket endpoint for
 * real-time agent state updates via OpenClaw gateway integration,
 * and persists user settings + layout to disk.
 *
 * Usage:
 *   npm run build:standalone
 *   npm run start
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import { ConfigManager } from './configManager.js';
import { OpenClawClient, type AgentEvent, type AgentSession } from './openclaw-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

// Resolve project root (dist/server/ → project root)
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_DIST = join(PROJECT_ROOT, 'dist', 'webview');

const PORT = parseInt(process.env.PORT || '19100', 10);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
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

  // JSON body parser for REST endpoints
  app.use(express.json({ limit: '1mb' }));

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

  // HTML must never be cached (SPA with hashed assets for cache busting)
  app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // Serve index.html and other root-level files
  app.use(express.static(WEBVIEW_DIST));

  // Fallback to index.html for SPA routing
  app.use((_req, res) => {
    res.sendFile(join(WEBVIEW_DIST, 'index.html'));
  });

  // ── HTTP + WebSocket server ────────────────────────────────────────────────

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

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

    // Send all current sessions immediately
    const sessions = openclaw.getSessions();
    sendToClient(ws, {
      type: 'initial_state',
      sessions: sessions.map((s) => serializeSession(s)),
    });

    // Handle incoming messages from the webview client
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
        const enabled = msg.enabled as boolean;
        config.update({ ...config.get() }); // hooksEnabled is Claude-specific, just persist
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
        // Find session key by agent ID (reverse lookup via the server's agent map)
        // broadcast removal so bridge handles cleanup
        broadcast({ type: 'agent_remove', id: agentId });
        break;
      }

      case 'focusAgent': {
        // No terminal to focus in standalone mode — this is a no-op
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

  // Agent joining
  openclaw.on('agent_join', (event: AgentEvent) => {
    broadcast({
      type: 'agent_join',
      session: serializeSession(event.session),
    });
  });

  // Agent left
  openclaw.on('agent_leave', (event: AgentEvent) => {
    broadcast({
      type: 'agent_leave',
      sessionKey: event.session.key,
    });
  });

  // Active state changes
  openclaw.on('agent_active', (event: AgentEvent) => {
    broadcast({
      type: 'agent_update',
      session: serializeSession({ ...event.session, isActive: true }),
      active: true,
    });
  });

  openclaw.on('agent_idle', (event: AgentEvent) => {
    broadcast({
      type: 'agent_update',
      session: serializeSession({ ...event.session, isActive: false }),
      active: false,
    });
  });

  // Waiting state (tool call complete, awaiting user input)
  openclaw.on('agent_waiting', (event: AgentEvent) => {
    broadcast({
      type: 'agent_waiting',
      sessionKey: event.session.key,
    });
  });

  // Permission request
  openclaw.on('agent_permission', (event: AgentEvent) => {
    broadcast({
      type: 'agent_permission',
      sessionKey: event.session.key,
      toolName: event.toolName,
      toolId: event.toolId,
    });
  });

  // Tool events
  openclaw.on('agent_tool_start', (event: AgentEvent) => {
    broadcast({
      type: 'agent_tool_start',
      session: serializeSession(event.session),
      toolName: event.toolName,
      toolId: event.toolId || `tool-${Date.now()}`,
    });
  });

  openclaw.on('agent_tool_end', (event: AgentEvent) => {
    broadcast({
      type: 'agent_tool_end',
      session: serializeSession(event.session),
      toolName: event.toolName,
      toolId: event.toolId || `tool-${Date.now()}`,
    });
  });

  // Sub-agent events
  openclaw.on('subagent_join', (event: AgentEvent) => {
    broadcast({
      type: 'subagent_join',
      session: serializeSession(event.session),
      toolName: event.toolName,
      toolId: event.toolId,
      parentSessionKey: event.parentSessionKey,
    });
  });

  openclaw.on('subagent_tool_start', (event: AgentEvent) => {
    broadcast({
      type: 'subagent_tool_start',
      session: serializeSession(event.session),
      toolName: event.toolName,
      toolId: event.toolId,
      parentSessionKey: event.parentSessionKey,
    });
  });

  openclaw.on('subagent_leave', (event: AgentEvent) => {
    broadcast({
      type: 'subagent_leave',
      sessionKey: event.session.key,
    });
  });

  // Connected event — re-send state after reconnect
  openclaw.on('connected', () => {
    console.log('[PixelAgents] Reconnected to OpenClaw gateway, re-sending sessions');
    const sessions = openclaw.getSessions();
    broadcast({
      type: 'initial_state',
      sessions: sessions.map((s) => serializeSession(s)),
    });
  });

  // ── Detect leaves via periodic session diff ────────────────────────────────

  const previousKeys = new Set<string>();
  setInterval(() => {
    const currentKeys = new Set(openclaw.getSessions().map((s) => s.key));
    for (const key of previousKeys) {
      if (!currentKeys.has(key)) {
        broadcast({ type: 'agent_leave', sessionKey: key });
      }
    }
    previousKeys.clear();
    for (const key of currentKeys) previousKeys.add(key);

    // Clean detached sub-agents
    const subagents = openclaw.getSubagents();
    for (const [skey] of subagents) {
      if (!currentKeys.has(skey)) {
        broadcast({ type: 'subagent_leave', sessionKey: skey });
      }
    }
  }, 5000);

  // ── Connect to OpenClaw gateway ────────────────────────────────────────────

  try {
    await openclaw.connect();
  } catch (err) {
    console.error('[PixelAgents] Failed to connect to OpenClaw gateway:', err);
    console.log('[PixelAgents] Server will run without agents — reconnect in progress');
  }

  // ── Start HTTP server ──────────────────────────────────────────────────────

  httpServer.listen(PORT, () => {
    console.log(`[PixelAgents] Server running on http://localhost:${PORT}`);
    console.log(`[PixelAgents] WebSocket endpoint: ws://localhost:${PORT}/ws`);
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

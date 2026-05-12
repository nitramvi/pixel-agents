/**
 * OpenClaw Gateway WebSocket Client
 *
 * Connects to the OpenClaw gateway, subscribes to session events,
 * and emits structured agent events with sub-agent and permission support.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentSession {
  key: string;
  sessionId: string;
  displayName: string;
  kind: string;
  updatedAt: number;
  systemSent: boolean;
  isActive: boolean;
  currentTool?: string;
  lastToolAt?: number;
}

export interface AgentEvent {
  type:
    | 'agent_join'
    | 'agent_update'
    | 'agent_leave'
    | 'agent_tool_start'
    | 'agent_tool_end'
    | 'agent_idle'
    | 'agent_active'
    | 'agent_waiting'
    | 'agent_permission'
    | 'subagent_join'
    | 'subagent_leave'
    | 'subagent_tool_start'
    | 'subagent_tool_end';
  session: AgentSession;
  toolName?: string;
  toolId?: string;
  parentSessionKey?: string;
}

interface SubagentInfo {
  key: string;
  parentKey: string;
  toolId: string;
  toolName: string;
  displayName: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 18789;
const DEFAULT_SCHEME = 'ws';
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;
const TICK_TIMEOUT_MS = 60000;
const TOOL_IDLE_THRESHOLD_MS = 5000;

// ── Client ─────────────────────────────────────────────────────────────────────

export class OpenClawClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private host: string;
  private port: number;
  private token: string;
  private scheme: string;
  private requestId = 0;
  private sessions = new Map<string, AgentSession>();
  private activeToolIds = new Map<string, string>();
  private subagents = new Map<string, SubagentInfo>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Tracks resolved promise for connect() */
  private connectedPromise: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor() {
    super();
    this.loadConfig();
  }

  private loadConfig(): void {
    const envHost = process.env['OPENCLAW_HOST'];
    const envToken = process.env['OPENCLAW_TOKEN'];
    const envPort = process.env['OPENCLAW_PORT'];

    if (envToken && envPort) {
      const envScheme = process.env['OPENCLAW_SCHEME'] || DEFAULT_SCHEME;
      const envTokenFile = process.env['OPENCLAW_TOKEN_FILE'];

      // Resolve token: from file takes precedence over env var
      let resolvedToken = envToken;
      if (envTokenFile) {
        try {
          resolvedToken = readFileSync(envTokenFile, 'utf-8').trim();
          console.log(`[OpenClawClient] Token loaded from file: ${envTokenFile}`);
        } catch (e) {
          console.error(`[OpenClawClient] Failed to read token file: ${envTokenFile}`, e);
        }
      }

      this.host = envHost || 'host.docker.internal';
      this.token = resolvedToken || '';
      this.port = parseInt(envPort, 10) || DEFAULT_PORT;
      this.scheme = envScheme;
      console.log(`[OpenClawClient] Using env vars → ${this.scheme}://${this.host}:${this.port}`);
      return;
    }

    // Fallback: ~/.openclaw/openclaw.json
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const gateway = (config.gateway as Record<string, unknown>) || {};
      const auth = (gateway.auth as Record<string, unknown>) || {};
      this.host = 'localhost';
      this.token = auth.token as string;
      this.port = (gateway.port as number) || DEFAULT_PORT;
      this.scheme = DEFAULT_SCHEME;
    } catch {
      // Last resort: env vars only
      const fbToken = process.env['OPENCLAW_TOKEN'];
      const fbPort = process.env['OPENCLAW_PORT'];
      if (!fbToken) {
        throw new Error(
          `Cannot read OpenClaw config at ${configPath}. ` +
            'Set OPENCLAW_TOKEN, OPENCLAW_PORT env vars as fallback.',
        );
      }
      this.host = process.env['OPENCLAW_HOST'] || 'localhost';
      this.token = fbToken;
      this.port = parseInt(fbPort || String(DEFAULT_PORT), 10);
      this.scheme = process.env['OPENCLAW_SCHEME'] || DEFAULT_SCHEME;
    }

    if (!this.token) {
      throw new Error('No gateway auth token found in OpenClaw config or env vars');
    }
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    const url = `${this.scheme}://${this.host}:${this.port}`;
    console.log(`[OpenClawClient] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      this.connectedPromise = { resolve, reject };

      // Connect timeout: reject after 10s if no hello-ok received
      const connectTimeout = setTimeout(() => {
        if (this.connectedPromise) {
          this.connectedPromise.reject(new Error('Connection timeout after 10s'));
          this.connectedPromise = null;
        }
      }, 10000);

      const originalResolve = resolve;
      const wrappedResolve = () => {
        clearTimeout(connectTimeout);
        originalResolve();
      };
      this.connectedPromise = { resolve: wrappedResolve, reject };

      const ws = new WebSocket(url);

      ws.onopen = () => {
        console.log('[OpenClawClient] WebSocket connected');
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);
          this.handleMessage(msg);
        } catch (err) {
          console.error('[OpenClawClient] Error parsing message:', err);
        }
      };

      ws.onerror = (err: ErrorEvent) => {
        console.error('[OpenClawClient] WebSocket error:', err.message);
        if (!this.ws) {
          this.connectedPromise?.reject(new Error(err.message));
          this.connectedPromise = null;
        }
      };

      ws.onclose = () => {
        console.log('[OpenClawClient] Connection closed');
        this.ws = null;
        this.clearTimers();
        if (!this.disposed) {
          this.scheduleReconnect();
        }
      };

      this.ws = ws;
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Protocol handshake
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      this.sendRequest('connect', {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'gateway-client',
          version: '1.0.0',
          platform: 'linux',
          mode: 'backend',
        },
        role: 'operator',
        scopes: ['operator.read'],
        auth: { token: this.token },
        locale: 'en-US',
        userAgent: 'pixel-agents/1.0.0',
      });
      return;
    }

    // Auth success
    if (msg.type === 'res' && (msg.payload as Record<string, unknown>)?.type === 'hello-ok') {
      console.log('[OpenClawClient] Connected and authenticated');
      this.startTickTimer();
      this.startIdleCheck();
      this.sendRequest('sessions.subscribe', {});
      this.sendRequest('sessions.list', {});
      this.connectedPromise?.resolve();
      this.connectedPromise = null;
      this.emit('connected');
      return;
    }

    // Response to a request
    if (msg.type === 'res' && msg.id && msg.ok) {
      this.handleResponse(msg);
      return;
    }

    // Push event from gateway
    if (msg.type === 'event') {
      this.handlePushEvent(msg);
    }
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    const method = msg.method as string | undefined;

    // sessions.list response
    if (payload.sessions) {
      const sessionList = payload.sessions as Array<Record<string, unknown>>;
      for (const sess of sessionList) {
        this.upsertSession(sess);
      }
      console.log(`[OpenClawClient] Loaded ${sessionList.length} session(s)`);
      return;
    }

    // tasks.create response — a new sub-agent was spawned
    if (method === 'tasks.create') {
      console.log('[OpenClawClient] Task created:', payload.taskId ?? '(no id)');
      return;
    }

    // session.spawn response
    if (method === 'session.spawn') {
      console.log('[OpenClawClient] Session spawned:', payload.sessionKey ?? '(no key)');
      return;
    }
  }

  private handlePushEvent(event: Record<string, unknown>): void {
    const eventName = event.event as string;
    const payload = event.payload as Record<string, unknown> | undefined;

    switch (eventName) {
      case 'sessions.changed':
        // Re-fetch sessions when the list changes
        this.sendRequest('sessions.list', {});
        break;

      case 'session.tool': {
        if (!payload) break;
        this.handleToolEvent(payload);
        break;
      }

      case 'session.message': {
        if (!payload) break;
        this.handleMessageEvent(payload);
        break;
      }

      case 'session.waiting': {
        if (!payload) break;
        const sessionKey = payload.sessionKey as string;
        const session = this.sessions.get(sessionKey);
        if (session) {
          session.isActive = false;
          this.emit('agent_waiting', { type: 'agent_waiting', session });
        }
        break;
      }

      default:
        break;
    }
  }

  private handleToolEvent(payload: Record<string, unknown>): void {
    const sessionKey = payload.sessionKey as string;
    const toolId = payload.toolId as string;
    const toolName = payload.toolName as string;
    const eventType = payload.eventType as string;
    const parentToolId = payload.parentToolId as string | undefined;
    const subSessionKey = payload.subSessionKey as string | undefined;

    const session = this.sessions.get(sessionKey);

    if (!session) return;

    if (eventType === 'start') {
      this.activeToolIds.set(sessionKey, toolId);
      session.isActive = true;
      session.currentTool = toolName;
      session.lastToolAt = Date.now();

      // Detect sub-agent spawn (Task/Agent tool creates child session)
      if (subSessionKey && (toolName === 'Task' || toolName === 'Agent')) {
        this.subagents.set(subSessionKey, {
          key: subSessionKey,
          parentKey: sessionKey,
          toolId,
          toolName,
          displayName: payload.displayName as string || `Sub: ${toolName}`,
        });
        const subSession = this.sessions.get(subSessionKey);
        this.emit('subagent_join', {
          type: 'subagent_join',
          session: subSession ?? {
            key: subSessionKey,
            sessionId: subSessionKey,
            displayName: payload.displayName as string || `Sub: ${toolName}`,
            kind: 'subagent',
            updatedAt: Date.now(),
            systemSent: false,
            isActive: true,
            currentTool: toolName,
          },
          toolName,
          toolId,
          parentSessionKey: sessionKey,
        });
        // Subscribe to sub-agent events
        this.sendRequest('sessions.messages.subscribe', { sessionKey: subSessionKey });
      } else {
        this.emit('agent_tool_start', {
          type: 'agent_tool_start',
          session,
          toolName,
          toolId,
        });
      }
    } else if (eventType === 'result') {
      const currentToolId = this.activeToolIds.get(sessionKey);
      if (currentToolId && currentToolId === toolId) {
        this.activeToolIds.delete(sessionKey);
      }
      session.lastToolAt = Date.now();

      this.emit('agent_tool_end', {
        type: 'agent_tool_end',
        session,
        toolName,
        toolId,
      });
    } else if (eventType === 'permission') {
      // Permission request detected
      session.isActive = true;
      this.emit('agent_permission', {
        type: 'agent_permission',
        session,
        toolName,
        toolId,
      });
    }
  }

  private handleMessageEvent(payload: Record<string, unknown>): void {
    const sessionKey = payload.sessionKey as string;
    const message = payload.message as Record<string, unknown> | undefined;
    if (!message) return;

    const role = message.role as string;
    const session = this.sessions.get(sessionKey);

    if (!session) return;

    if (role === 'assistant') {
      session.isActive = true;
      session.lastToolAt = Date.now();
      this.emit('agent_active', { type: 'agent_active', session });
    }

    // If this is a sub-agent message, emit subagent event
    for (const [skey, info] of this.subagents) {
      if (sessionKey === skey && role === 'assistant') {
        this.emit('subagent_tool_start', {
          type: 'subagent_tool_start',
          session,
          toolName: info.toolName,
          toolId: info.toolId,
          parentSessionKey: info.parentKey,
        });
      }
    }
  }

  /** Register a new session (from broadcasts or server responses). */
  upsertSession(sessPayload: Record<string, unknown>): void {
    const key = sessPayload.key as string;
    if (!key) return;

    const existing = this.sessions.get(key);
    const session: AgentSession = {
      key,
      sessionId: sessPayload.sessionId as string || key,
      displayName: sessPayload.displayName as string || key.split(':').pop() || key,
      kind: sessPayload.kind as string || 'session',
      updatedAt: sessPayload.updatedAt as number || Date.now(),
      systemSent: sessPayload.systemSent as boolean || false,
      isActive: existing?.isActive ?? false,
    };

    const isNew = !existing;
    this.sessions.set(key, session);

    if (isNew) {
      this.emit('agent_join', { type: 'agent_join', session });
      this.sendRequest('sessions.messages.subscribe', { sessionKey: key });

      const now = Date.now();
      if (now - session.updatedAt < 30000) {
        session.isActive = true;
        this.emit('agent_active', { type: 'agent_active', session });
      }
    } else {
      session.isActive = existing.isActive;
    }
  }

  /** Remove a session (called externally when a session leaves). */
  removeSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      this.emit('agent_leave', { type: 'agent_leave', session });
      this.sessions.delete(sessionKey);
    }
    // Check if it was a sub-agent
    this.subagents.delete(sessionKey);
  }

  // ── Idle detection ────────────────────────────────────────────────────────

  private checkIdleSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.isActive) {
        const lastActivity = session.lastToolAt || session.updatedAt;
        if (now - lastActivity > TOOL_IDLE_THRESHOLD_MS && !this.activeToolIds.has(key)) {
          session.isActive = false;
          session.currentTool = undefined;
          this.emit('agent_idle', { type: 'agent_idle', session });
        }
      }
    }
  }

  // ── Spawn a new agent session ─────────────────────────────────────────────

  /** Spawn a new OpenClaw sub-agent task and return the session key. */
  spawnAgent(taskDescription: string): void {
    this.sendRequest('tasks.create', {
      task: taskDescription,
      mode: 'run',
      label: 'pixel-agent',
    });
  }

  // ── Timer management ──────────────────────────────────────────────────────

  private startTickTimer(): void {
    this.tickTimer = setTimeout(() => {
      if (!this.disposed) this.startTickTimer();
    }, TICK_TIMEOUT_MS);
  }

  private startIdleCheck(): void {
    this.idleCheckTimer = setInterval(() => this.checkIdleSessions(), 2000);
  }

  private clearTimers(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_DELAY_MS + Math.random() * 2000, MAX_RECONNECT_DELAY_MS);
    console.log(`[OpenClawClient] Reconnecting in ${Math.round(delay)}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) void this.connect();
    }, delay);
  }

  private sendRequest(method: string, params: Record<string, unknown>): void {
    if (!this.ws) return;
    const msg = JSON.stringify({
      type: 'req',
      id: String(++this.requestId),
      method,
      params,
    });
    this.ws.send(msg);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  getSubagents(): Map<string, SubagentInfo> {
    return new Map(this.subagents);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sessions.clear();
    this.subagents.clear();
  }
}

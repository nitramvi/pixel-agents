/**
 * Standalone Bridge — Frontend WebSocket client for Pixel Agents Server
 *
 * Connects to the standalone server WebSocket at /ws, receives agent
 * events from the OpenClaw gateway, and dispatches them as window
 * postMessage events in the exact format useExtensionMessages expects.
 *
 * Also intercepts vscode.postMessage calls in browser mode to forward
 * them to the server (settings, layout save, agent spawn, etc.).
 *
 * Only active when isBrowserRuntime = true.
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

interface ServerSession {
  id: string;
  key: string;
  displayName: string;
  kind: string;
  isActive: boolean;
  currentTool: string | null;
  updatedAt: number;
}

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

/** Stable agent ID mapping: sessionKey → numeric agent ID */
const sessionToAgentId = new Map<string, number>();
/** Reverse mapping: agent ID → sessionKey */
const agentIdToSessionKey = new Map<number, string>();
/** Sub-agent mapping: sub-agent session key → parent agent ID */
const subagentSessions = new Map<string, number>();
let nextAgentId = 100;

let wsInstance: WebSocket | null = null;

// ── Agent ID helpers ───────────────────────────────────────────────────────────

function getAgentId(sessionKey: string): number {
  let id = sessionToAgentId.get(sessionKey);
  if (id === undefined) {
    id = nextAgentId++;
    sessionToAgentId.set(sessionKey, id);
    agentIdToSessionKey.set(id, sessionKey);
  }
  return id;
}

// ── Dispatch helpers ───────────────────────────────────────────────────────────

function dispatch(type: string, payload: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type, ...payload } }));
}

function dispatchAgentJoin(session: ServerSession): void {
  const id = getAgentId(session.key);
  dispatch('agentCreated', {
    id,
    folderName: session.displayName || session.id,
  });
  if (session.isActive) {
    const toolName = session.currentTool || 'Working';
    dispatch('agentToolStart', {
      id,
      toolId: `gw-${id}-${Date.now()}`,
      status: formatToolStatus(toolName),
      toolName,
    });
  }
}

function formatToolStatus(toolName: string): string {
  const statusMap: Record<string, string> = {
    read: 'Reading',
    write: 'Writing',
    edit: 'Editing',
    bash: 'Running command',
    search: 'Searching',
    web_search: 'Searching web',
    web_fetch: 'Fetching page',
    task: 'Running task',
    agent: 'Running agent',
    think: 'Thinking',
    session_spawn: 'Spawning agent',
  };
  return statusMap[toolName.toLowerCase()] || `Tool: ${toolName}`;
}

// function extractToolName kept for potential future use

// ── Server message handler ─────────────────────────────────────────────────────

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    // ── Settings ───────────────────────────────────────────────────────────
    case 'settings_loaded': {
      dispatch('settingsLoaded', {
        soundEnabled: msg.soundEnabled ?? false,
        watchAllSessions: msg.watchAllSessions ?? false,
        alwaysShowLabels: msg.alwaysShowLabels ?? false,
        hooksEnabled: true,
        hooksInfoShown: msg.hooksInfoShown ?? true,
        lastSeenVersion: msg.lastSeenVersion ?? '0.0',
        extensionVersion: msg.extensionVersion ?? '1.3.0',
        externalAssetDirectories: [],
      });
      break;
    }

    case 'layout_loaded': {
      const layout = msg.layout as Record<string, unknown> | null;
      if (layout) {
        dispatch('layoutLoaded', { layout, wasReset: false });
      }
      break;
    }

    case 'sound_enabled': {
      // Update sound state without full settings reload
      break;
    }

    // ── Agents ─────────────────────────────────────────────────────────────
    case 'initial_state': {
      const sessions = msg.sessions as ServerSession[];
      const agentIds: number[] = [];
      const agentMeta: Record<number, { palette?: number }> = {};
      const folderNames: Record<number, string> = {};

      for (const session of sessions) {
        const id = getAgentId(session.key);
        agentIds.push(id);
        folderNames[id] = session.displayName || session.key;
      }

      dispatch('existingAgents', { agents: agentIds, agentMeta, folderNames });

      for (const session of sessions) {
        const id = getAgentId(session.key);
        dispatch('agentCreated', {
          id,
          folderName: session.displayName || session.key,
        });
        if (session.isActive && session.currentTool) {
          dispatch('agentToolStart', {
            id,
            toolId: `gw-${id}-init`,
            status: formatToolStatus(session.currentTool),
            toolName: session.currentTool,
          });
        }
      }
      break;
    }

    case 'agent_join': {
      const session = msg.session as ServerSession;
      dispatchAgentJoin(session);
      break;
    }

    case 'agent_leave': {
      const sessionKey = msg.sessionKey as string;
      const id = sessionToAgentId.get(sessionKey);
      if (id !== undefined) {
        // Clear all tools first
        dispatch('agentToolsClear', { id });
        dispatch('agentClosed', { id });
        sessionToAgentId.delete(sessionKey);
        agentIdToSessionKey.delete(id);
      }
      break;
    }

    case 'agent_remove': {
      const id = msg.id as number;
      dispatch('agentToolsClear', { id });
      dispatch('agentClosed', { id });
      const sessionKey = agentIdToSessionKey.get(id);
      if (sessionKey) {
        sessionToAgentId.delete(sessionKey);
        agentIdToSessionKey.delete(id);
      }
      break;
    }

    // ── Tool events ────────────────────────────────────────────────────────
    case 'agent_tool_start': {
      const session = msg.session as ServerSession;
      const id = getAgentId(session.key);
      const toolName = (msg.toolName as string) || session.currentTool || 'Working';
      const toolId = msg.toolId as string || `gw-${id}-${Date.now()}`;

      dispatch('agentToolStart', {
        id,
        toolId,
        status: formatToolStatus(toolName),
        toolName,
        permissionActive: false,
        runInBackground: false,
      });
      break;
    }

    case 'agent_tool_end': {
      const session = msg.session as ServerSession;
      const id = getAgentId(session.key);
      const toolId = msg.toolId as string;
      const toolName = msg.toolName as string;

      dispatch('agentToolDone', { id, toolId });

      // If it's a Task or Agent tool ending, clear sub-agents
      if (toolName === 'Task' || toolName === 'Agent') {
        dispatch('subagentClear', { id, parentToolId: toolId });
      }

      // If no longer active, clear tools and show done status
      if (!session.isActive) {
        setTimeout(() => {
          dispatch('agentToolsClear', { id });
          dispatch('agentStatus', { id, status: 'done' });
        }, 500);
      }
      break;
    }

    case 'agent_waiting': {
      const sessionKey = msg.sessionKey as string;
      const id = getAgentId(sessionKey);
      // Clear tools and show waiting bubble
      dispatch('agentToolsClear', { id });
      dispatch('agentStatus', { id, status: 'waiting' });
      break;
    }

    case 'agent_permission': {
      const sessionKey = msg.sessionKey as string;
      const id = getAgentId(sessionKey);
      const toolName = (msg.toolName as string) || 'Permission';
      const toolId = msg.toolId as string || `perm-${id}-${Date.now()}`;

      dispatch('agentToolStart', {
        id,
        toolId,
        status: `Awaiting: ${toolName}`,
        toolName,
        permissionActive: true,
      });
      dispatch('agentToolPermission', { id });
      break;
    }

    case 'agent_update': {
      const session = msg.session as ServerSession;
      const id = getAgentId(session.key);
      const active = msg.active as boolean;

      if (active) {
        const toolName = session.currentTool || 'Working';
        const toolId = `gw-${id}-active-${Date.now()}`;
        dispatch('agentToolStart', {
          id,
          toolId,
          status: formatToolStatus(toolName),
          toolName,
        });
      } else {
        // Became idle
        dispatch('agentStatus', { id, status: 'done' });
      }
      break;
    }

    // ── Sub-agent events ──────────────────────────────────────────────────
    case 'subagent_join': {
      const subSession = msg.session as ServerSession;
      const parentSessionKey = msg.parentSessionKey as string;
      const parentId = getAgentId(parentSessionKey);
      const subId = getAgentId(subSession.key);

      subagentSessions.set(subSession.key, parentId);

      dispatch('agentCreated', {
        id: subId,
        folderName: subSession.displayName || subSession.key,
        isTeammate: true,
        parentAgentId: parentId,
        teammateName: subSession.displayName || subSession.key,
        teamName: 'OpenClaw Agent',
      });

      if (subSession.isActive) {
        const toolName = subSession.currentTool || 'Working';
        dispatch('agentToolStart', {
          id: subId,
          toolId: `sub-${subId}-${Date.now()}`,
          status: formatToolStatus(toolName),
          toolName,
        });
      }
      break;
    }

    case 'subagent_leave': {
      const subKey = msg.sessionKey as string;
      const id = sessionToAgentId.get(subKey);
      if (id !== undefined) {
        dispatch('agentToolsClear', { id });
        dispatch('agentClosed', { id });
        sessionToAgentId.delete(subKey);
        agentIdToSessionKey.delete(id);
        subagentSessions.delete(subKey);
      }
      break;
    }

    case 'subagent_tool_start': {
      const subSession = msg.session as ServerSession;
      const parentKey = msg.parentSessionKey as string;
      if (!parentKey) break;
      const parentId = getAgentId(parentKey);
      const subId = getAgentId(subSession.key);
      const toolName = (msg.toolName as string) || subSession.currentTool || 'Running';
      const toolId = msg.toolId as string || `sub-tool-${subId}-${Date.now()}`;

      dispatch('subagentToolStart', {
        id: parentId,
        parentToolId: toolId,
        toolId,
        status: `Subtask: ${toolName}`,
      });

      // Also update the sub-agent character
      dispatch('agentToolStart', {
        id: subId,
        toolId: `sub-${subId}-${Date.now()}`,
        status: formatToolStatus(toolName),
        toolName,
      });
      break;
    }

    case 'subagent_tool_end': {
      const parentKey = msg.parentSessionKey as string;
      if (!parentKey) break;
      const parentId = getAgentId(parentKey);
      const toolId = msg.toolId as string;

      dispatch('subagentToolDone', {
        id: parentId,
        parentToolId: toolId,
        toolId,
      });
      break;
    }

    default:
      break;
  }
}

// ── Forward vscode.postMessage to server WebSocket ───────────────────────────

function forwardToServer(msg: Record<string, unknown>): void {
  if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
    try {
      wsInstance.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[StandaloneBridge] Error forwarding to server:', err);
    }
  } else {
    console.log('[StandaloneBridge] Cannot forward — WS not connected:', msg.type);
  }
}

function patchVscodeApi(): void {
  // Replace the no-op vscode mock with one that forwards to the server WebSocket
  // The module vscodeApi.ts returns { postMessage: console.log } in browser mode.
  // We override window.__pixelAgentsWsSend to let vscodeApi.ts use it.
  (window as unknown as Record<string, unknown>).__pixelAgentsWsSend = forwardToServer;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the standalone bridge.
 * @param serverUrl WebSocket URL of the standalone server
 * @returns cleanup function
 */
export function initStandaloneBridge(serverUrl?: string): () => void {
  // Wait for DOM to be ready before patching vscode API
  patchVscodeApi();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = serverUrl || `${protocol}//${location.host}/ws`;
  console.log('[StandaloneBridge] Connecting to', url);

  const ws = new WebSocket(url);
  wsInstance = ws;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  ws.onopen = () => {
    console.log('[StandaloneBridge] Connected');
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      handleServerMessage(msg);
    } catch (err) {
      console.error('[StandaloneBridge] Parse error:', err);
    }
  };

  ws.onclose = () => {
    console.log('[StandaloneBridge] Disconnected, will reconnect');
    wsInstance = null;
    reconnectTimer = setTimeout(() => {
      // Don't fully re-init, just reconnect
      const newWs = new WebSocket(url);
      wsInstance = newWs;
      newWs.onopen = ws.onopen;
      newWs.onmessage = ws.onmessage;
      newWs.onclose = ws.onclose;
      newWs.onerror = ws.onerror;
    }, 3000);
  };

  ws.onerror = (err: Event) => {
    console.error('[StandaloneBridge] Error:', err);
    ws.close();
  };

  return () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    wsInstance = null;
    ws.close();
    // Clear agent state
    for (const id of sessionToAgentId.values()) {
      dispatch('agentClosed', { id });
    }
    sessionToAgentId.clear();
    agentIdToSessionKey.clear();
    subagentSessions.clear();
  };
}

/**
 * Send a message to the server WebSocket.
 */
export function sendToServer(msg: Record<string, unknown>): void {
  forwardToServer(msg);
}

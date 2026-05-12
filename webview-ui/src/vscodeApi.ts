import { isBrowserRuntime } from './runtime';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

/**
 * In VS Code webview mode: uses acquireVsCodeApi().
 * In standalone browser mode: forwards messages to the server WebSocket
 * (set by standaloneBridge.ts via window.__pixelAgentsWsSend),
 * or falls back to console.log if the bridge isn't ready.
 */
function createBrowserVscode(): { postMessage(msg: unknown): void } {
  return {
    postMessage: (msg: unknown) => {
      const send = (window as unknown as Record<string, unknown>).__pixelAgentsWsSend as
        | ((msg: Record<string, unknown>) => void)
        | undefined;
      if (typeof send === 'function') {
        send(msg as Record<string, unknown>);
      } else {
        console.log('[vscode.postMessage] (no bridge)', msg);
      }
    },
  };
}

export const vscode: { postMessage(msg: unknown): void } = isBrowserRuntime
  ? createBrowserVscode()
  : (acquireVsCodeApi() as { postMessage(msg: unknown): void });

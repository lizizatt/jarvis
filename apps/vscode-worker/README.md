# Jarvis Copilot Worker

This VS Code extension connects open workspace roots to Jarvis through the public VS Code Language Model API. On Linux it can observe visible Copilot Chat controls through AT-SPI to report activity. It does not inspect chat text or private Copilot storage.

## Connect

1. Install the extension in VS Code 1.125 or newer and sign in to GitHub Copilot.
2. Open each registered checkout as a workspace root in its own window.
3. Run **Jarvis: Connect Copilot Worker** once. The enabled state persists and reconnects while the window remains open.

A task is accepted only when its canonical repository path exactly matches an advertised workspace root.

Commands:

- **Jarvis: Connect Copilot Worker**
- **Jarvis: Disconnect Copilot Worker**
- **Jarvis: Show Status**
- **Jarvis: Run Copilot Capability Test**

The capability test makes a small model request and is never run automatically.

## Settings

- `jarvisCopilotWorker.serverUrl`: worker WebSocket URL; default `ws://127.0.0.1:3210/ws/workers`.
- `jarvisCopilotWorker.preferredModel`: model ID, family, or display name; default `auto`.
- `jarvisCopilotWorker.nativeChatActivity.enabled`: enable Linux AT-SPI activity observation; default `true`.

Native chat activity requires `/usr/bin/python3`, the `Atspi` PyGObject binding, and `"editor.accessibilitySupport": "on"` in VS Code settings. When needed, the extension offers an **Enable and Reload** action before changing that global setting. The observer reads only visible button roles, button names, and ancestor container names, then emits `idle`, `thinking`, or `needs-input`.

## Contract

Worker protocol v2 carries model metadata, streamed output, structured questions, tool calls, session context, and cancellation. File and command tools are restricted to the accepted repository root. Commands still run with the VS Code user's operating-system permissions.

Cancellation stops the model request and sends `SIGTERM` to the command process group on POSIX. Windows can terminate the direct shell process but cannot guarantee descendant cleanup.

## Develop and Install

From the repository root:

```bash
npm run typecheck --workspace jarvis-copilot-worker
npm run test --workspace jarvis-copilot-worker
npm run install:local --workspace jarvis-copilot-worker
```

`install:local` builds an ignored `jarvis-copilot-worker.vsix` and installs it with `--force`. Reload every registered VS Code window afterward; running extension hosts retain the previous code until reload. Verify with:

```bash
code --list-extensions --show-versions | grep jarvis-local.jarvis-copilot-worker
curl -fsS http://127.0.0.1:3210/api/workers
```

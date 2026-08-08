# Jarvis Copilot Worker

This VS Code extension connects open workspace folders to a Jarvis server and executes Jarvis turns through the public VS Code Language Model API. It does not inspect existing Copilot chats or private Copilot storage.

## Setup

1. Install the extension in VS Code 1.125 or later and sign in to GitHub Copilot.
2. Open the repository folders that Jarvis may use. A task is accepted only when its canonical repository path exactly matches an open workspace root.
3. Run **Jarvis: Connect Copilot Worker**. This user action requests Copilot model access, enables the worker, and connects it to Jarvis.

The enabled state persists. While the VS Code window remains open, the extension reconnects with exponential backoff. Run **Jarvis: Disconnect Copilot Worker** to disable reconnection and stop active turns.

## Commands

- **Jarvis: Connect Copilot Worker**
- **Jarvis: Disconnect Copilot Worker**
- **Jarvis: Show Status**
- **Jarvis: Run Copilot Capability Test**

The capability test is manual and makes one small model request. It is not run during activation or automated tests.

## Settings

- `jarvisCopilotWorker.serverUrl`: worker WebSocket endpoint. Defaults to `ws://127.0.0.1:3210/ws/workers`.
- `jarvisCopilotWorker.preferredModel`: preferred Copilot model ID, family, or display name. Defaults to Copilot `auto` and falls back defensively when unavailable.

## Worker Behavior

The extension advertises protocol version 1, its stable worker ID, window name, exact canonical workspace roots, and public model metadata. It supports streamed model text, private repository-scoped file tools, exact text replacement, and shell commands run in the requested repository. Cancellation stops the model request and sends `SIGTERM` to the command process group on POSIX systems.

Write operations require the destination directory to exist. Command execution intentionally grants the selected Copilot model the authority of the VS Code user inside the accepted repository, subject to the policy supplied with each Jarvis turn. On Windows, cancellation terminates the direct shell process; POSIX process-group cancellation is needed for guaranteed descendant termination.

## Release

Version 0.0.4 provides per-window workers, automatic model selection, streamed task execution, structured questions, bounded command output, robust disconnect/cancellation handling, and reproducible local installation.

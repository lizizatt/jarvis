# VS Code Chat State Observability

## Goal

Expose built-in Copilot Chat activity to Jarvis as `idle`, `thinking`, or `needs-input` without reading prompts, chat history, credentials, or Copilot storage.

## Findings

### Stable extension API

VS Code 1.134 computes the desired states internally. Its workbench bundle defines `chatSessionRequestInProgress`, `chatSessionHasActiveRequest`, `chatRequestIsPending`, and request-needs-input state. These values belong to the workbench context-key and chat model services.

The stable extension API does not expose those values or a corresponding event. `vscode.commands.executeCommand('getContextKeyInfo')` returns context-key definitions, not live values. `workbench.action.inspectContextKeys` is an interactive developer overlay, not a subscription API.

Sources:

- `/usr/share/code/resources/app/out/vs/workbench/workbench.desktop.main.js`
- `/usr/share/code/resources/app/out/vscode-dts/vscode.d.ts`

### Proposed and Copilot-private APIs

The product allowlists `GitHub.copilot-chat` for private proposals including `chatSessionsProvider`, `chatStatusItem`, and `chatParticipantPrivate`. Jarvis is not allowlisted. The session proposal is provider-facing and does not provide a supported observer for another provider's active request.

Copilot Chat 0.60.0 is bundled into VS Code. It declares no public activity export for third-party extensions.

Sources:

- `/usr/share/code/resources/app/product.json`
- `/usr/share/code/resources/app/extensions/copilot/package.json`

### Ports and IPC

The observed localhost Code listeners are Node inspector endpoints for extension hosts and language servers. There is no dedicated chat-status socket. Attaching to an inspector or intercepting Copilot IPC would expose broad runtime state, including potentially sensitive content, and would be version-sensitive.

Model traffic is encrypted. Packet inspection cannot reliably derive semantic states without a TLS interception layer and should not be used.

### Linux accessibility

The AT-SPI bus is active and publishes each VS Code window as a distinct frame, including `jarvis - Visual Studio Code`. Electron currently exposes no descendants because VS Code accessibility support is not enabled.

With accessibility enabled, a sidecar can observe accessible control events within only the Jarvis frame. The state mapping should use an allowlist:

- visible Stop/Cancel response control: `thinking`
- visible approval, confirmation, or question control: `needs-input`
- neither: `idle`

The observer must ignore text, document, entry, and transcript roles and must never log accessible chat content.

Source:

- AT-SPI application bus at `/run/user/1001/at-spi/bus`

## Implementation

The worker now packages a Python AT-SPI sidecar. It polls only visible button controls, classifies controls under Chat, Copilot, or Agent ancestors, and emits only `idle`, `thinking`, or `needs-input`. The worker includes that value in protocol v2 `hello` messages, and the server combines it with Jarvis task activity using `needs-input` precedence.

The implementation:

1. Run only on Linux when explicitly enabled.
2. Identify windows by accessible frame name and match them to worker workspace names.
3. Poll child/state data and inspect only allowlisted control roles and names.
4. Debounce state changes and send a narrow `chatActivity` field through the existing worker heartbeat.
5. Fall back to Jarvis task activity when accessibility is unavailable.
6. Include fixture tests for state precedence and a manual compatibility check per VS Code release.

If AT-SPI does not expose stable controls, the robust fallback is a maintained VS Code core patch that publishes a narrow read-only chat-state event across the main-thread/extension-host RPC boundary. A renderer DevTools bridge, Node inspector attachment, private extension exports, storage polling, and traffic interception should be rejected.

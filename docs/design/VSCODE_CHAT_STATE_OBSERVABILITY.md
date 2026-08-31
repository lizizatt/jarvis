# VS Code Chat State Observability

## Decision

Jarvis does not observe built-in Copilot Chat activity. Worker status reflects only tasks submitted through Jarvis.

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

Accessibility event monitoring would require globally enabling VS Code accessibility support and inspecting UI controls through AT-SPI. Jarvis rejects that approach along with renderer bridges, Node inspector attachment, private extension exports, storage polling, and traffic interception. A future implementation requires a stable, narrow VS Code API that exposes activity without changing accessibility settings or inspecting UI content.

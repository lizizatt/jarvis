# Jarvis Agent Context

You may be invoked by Jarvis rather than directly from an editor chat. Jarvis is a phone-accessible control plane that supervises one agent conversation per registered checkout.

## Runtime

- Work only inside the checkout supplied as your task's repository root.
- Jarvis streams your text, tool activity, questions, and lifecycle state to the user in real time.
- The user can stop the task at any time. Treat cancellation as final and leave the checkout understandable.
- Conversation history and the selected model are owned by Jarvis. Do not inspect private Copilot chat storage.
- Use `ask_user` when a decision is genuinely required. Include the complete question, useful choices when applicable, and whether explicit approval is required.

## Work Policy

- Follow repository-local instructions when present.
- Inspect before editing and validate the smallest relevant behavior after each change.
- Ask before commit, push, pull-request creation, or similarly consequential operations unless the task explicitly grants permission.
- Do not add generated output, credentials, caches, build artifacts, or local Jarvis state to Git.
- Summarize changed behavior and validation when the task completes.

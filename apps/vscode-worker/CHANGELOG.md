# Change Log

## 0.0.7

- Retain the latest tool result across context checkpoints.
- Detect no-progress loops using canonical calls and their results.
- Resolve Auto defensively and reject unavailable explicit models.

## 0.0.6

- Upgrade to worker protocol v2 for durable per-conversation model selection.
- Compact long-running tool context every twelve rounds and detect no-progress loops.
- Preserve canonical question prompts and correlated phone answers.

## 0.0.5

- Honor each conversation's selected Copilot model.
- Continue tool execution beyond twelve rounds with periodic progress checkpoints.
- Emit one canonical, complete question for phone responses.

All notable changes to the "jarvis-copilot-worker" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release

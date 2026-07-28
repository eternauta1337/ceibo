# @ceibo/gateway

The always-on entry point for users, managing routing and metering.

## Core Responsibilities

- **Multi-Channel Routing**: Receives messages from channels (e.g., Telegram) and resolves them to active users via the `@ceibo/store` allowlist.
- **Session Lifecycle**: Manages the 1:1 mapping between users and MA cloud sessions. Handles session creation, reuse, and restarts (`/new`).
- **Metering Pipeline**: Coordinates the flow of usage data: `MA Cloud` $\rightarrow$ `Agent Relay` $\rightarrow$ `Gateway Sink` $\rightarrow$ `Store Ledger`.
- **Integrated Commands**: Provides slash commands for session management (`/new`, `/stop`) and service connection (`/connect <service> <profile>`, `/disconnect <service> [profile]`, `/connections`). A profile is mandatory on `/connect` (no implicit account).
- **Multi-Account Routing (Phase 7)**: For each non-`default` profile a user has connected, mounts a per-session MCP server (`<service>_<profile>`) onto the live session via `session.update` (`applyProfileServers`) — lazily, and only when the set of profiles changes. The `default` profile is already covered by the agent's base servers, so it requires no session change.
- **Admin Access**: Provides a local Unix socket for the CLI to impersonate users for debugging or administrative chat.

## Architecture
- **Input**: Telegram (polling) or Local Socket.
- **Processing**: `handleIncoming` $\rightarrow$ `ensureRelay` $\rightarrow$ `applyProfileServers` $\rightarrow$ `Relay.send()`.
- **Output**: `Sink` implementation that posts back to the channel.

## Configuration
Requires `ANTHROPIC_API_KEY`, `AGENT_ID`, `ENV_ID`, `TELEGRAM_BOT_TOKEN`, and `OAUTH_BASE_URL`.

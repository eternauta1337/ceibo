# @ceibo/agent

A bidirectional relay for interacting with Managed Agents (MA) cloud sessions.

## Core Responsibilities

- **Session Orchestration**: Handles the creation and reuse of MA sessions, including the mounting of GitHub repositories as resources.
- **Bidirectional Streaming**: Manages the egress stream (events from the agent to a `Sink`) and ingress (sending messages or interrupts to the agent).
- **Vault Management**: Interacts with the Anthropic Vault to store and update credentials (specifically `static_bearer` tokens) for MCP servers.
- **Per-Session Agent Config**: `setSessionAgentConfig` overrides a live session's `mcp_servers`/`tools` via `session.update` (full replacement). Used by the gateway to mount a user's multi-account profiles without pre-declaring them on the global agent.
- **Metering Integration**: Retrieves cumulative session usage from the MA cloud and reports it via the `Sink.turnComplete` callback.

## Key Interfaces

- `Relay`: The handle used to `send()` messages or `interrupt()` the agent.
- `Sink`: The interface that the calling application (e.g., Gateway) implements to receive messages, activity updates, and metering data.
- `SessionConfig`: Configuration for the MA session, including `agentId`, `envId`, `vaultId`, and optional repo mounts.

## Usage Flow
1. Call `reuseOrCreate()` to get a session ID.
2. Call `attach()` with a `Sink` implementation to start receiving events and get a `Relay` for sending messages.

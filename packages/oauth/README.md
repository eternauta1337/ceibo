# @ceibo/oauth

OAuth broker for connecting external user accounts to the system.

## Core Responsibilities

- **Multi-Provider Support**: Generalizes OAuth flows for different providers (e.g., Google, Notion) via `OAuthProvider` configurations.
- **Broker Logic**: Acts as a secure broker. `client_secret` and `refresh_token` are stored exclusively in the local infra (DB/Env) and never sent to the MA Vault.
- **Credential Rotation**: Implements lazy refresh logic. When a user becomes active, the broker refreshes expiring tokens and pushes a short-lived `static_bearer` token to the MA Vault.
- **Enrollment Flow**: Manages the "Enrollment Token" lifecycle—single-use, time-limited links that securely bind an OAuth callback to a specific internal user.
- **Multi-Account (Profiles, Phase 7)**: A user can connect several accounts of the same service. The profile rides in the MCP URL as `?profile=<name>` (`mcpUrlForProfile`), which the MA Vault uses as the credential key — empirically the Vault matches on the full URL (exact, including query string). `serverNameForProfile` names the per-profile MCP server (`gmail_work`). The MCP server and launcher are untouched (they ignore `?profile=`; the injected token already is the account).
- **Agent Config Builder**: `buildAgentMcpConfig` is the single source of the agent's `mcp_servers`/`tools`, shared by `publish-agent` (the base, global agent) and the gateway (per-session override that adds the user's extra profiles).

## Key Processes

- **Enrollment**: `buildAuthUrl` $\rightarrow$ `exchangeCode` $\rightarrow$ `upsertOauthGrant` (with `profile`).
- **Refresh**: `refreshGrantsForUser` $\rightarrow$ `refreshAccessToken` $\rightarrow$ `setStaticBearerCredential` (via `@ceibo/agent`).

## Supported Services
Currently supports Gmail, Google Calendar, Google Drive, Google Sheets, and Notion.

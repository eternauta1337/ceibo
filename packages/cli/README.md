# @ceibo/cli

Administrative Command Line Interface for managing the system.

## Core Responsibilities

- **User Administration**: Creating, renaming, enabling/disabling users, and managing their display names.
- **Identity Management**: Associating external channel IDs (e.g., Telegram IDs) with internal user handles.
- **Wiki Management**: Creating and importing repositories in GitHub and managing N:N access grants for users.
- **OAuth Orchestration**: Generating enrollment links for users to connect external services (`oauth enroll <handle> <service> [profile]`; the optional profile enables multi-account).
- **Billing Reports**: Generating usage and cost reports based on the store's ledger.
- **User Impersonation**: Provides a `chat` command that connects to the gateway's control socket to interact with the agent as a specific user.

## Command Groups

- `user`: Manage user profiles and status.
- `channel`: Manage the allowlist/routing.
- `repo`: Manage wikis and access grants.
- `oauth`: Handle service enrollment.
- `usage`: Generate cost reports.
- `chat`: Interactive REPL for impersonation.

## Usage
Run via `ceibo <command>` on the box or `pnpm cli <command>` locally (if DB path is configured).

# @ceibo/store

Data layer for the ceibo system. It manages the persistence of users, identities, repositories, and usage metering using a synchronous SQLite database (`better-sqlite3`).

## Core Responsibilities

- **User Management**: Handles user profiles, handles (slugs), and account status.
- **Channel Identities**: Maps external IDs (e.g., Telegram IDs) to internal users, acting as an allowlist and router.
- **Repository Access**: Manages a N:N relationship between users and Git repositories (wikis), controlling which user can mount which repo.
- **Session & Metering**: Tracks active Managed Agents sessions and maintains a ledger of token usage (`usage_turns`) for billing.
- **OAuth State**: Stores OAuth grants (refresh tokens, access tokens) and manages single-use enrollment tokens. Multi-account (Phase 7): `oauth_grants`, `connections` and `enroll_tokens` carry a `profile` dimension — PK `(user_id, service, profile)` — where `"default"` is the legacy single-account connection.

## Key Components

- `openDb(path)`: Initializes the database, applies schema and migrations.
- `recordTurn(...)`: Atomic operation that computes token delta from a session snapshot and logs it to the ledger.
- `costOf(model, tokens)`: Calculates the USD cost of a turn based on model-specific pricing and a configurable markup.
- `resolveUser(channel, externalId)`: The primary entry point for the gateway to authorize and route messages.

## Database Schema
The schema includes tables for `users`, `channel_identities`, `repos`, `repo_access`, `sessions`, `usage_turns`, `enroll_tokens`, `connections`, and `oauth_grants`.

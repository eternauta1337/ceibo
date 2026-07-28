# @ceibo/wikis

The wiki substrate for users, currently implemented as a GitHub App.

## Core Responsibilities

- **Repo Provisioning**: Creates private repositories on-demand within a specific GitHub organization.
- **Scoped Access**: Mints short-lived (1 hour) installation tokens scoped to specific repositories. This ensures that the MA session only has access to the repos the user is authorized to see.
- **Abstraction Layer**: Encapsulates all GitHub-specific logic. If the system moves away from GitHub, only this package needs to be replaced.

## Naming Convention (Fase 16)

A user's wiki repo is named **`<handle>-<label>`** (e.g. `demo-personal`, `demo-ceibo`). The
owner's handle is the prefix; the label is the human name the owner sees (the prefix is
stripped for them — see `wikiDisplayName` in `@ceibo/store`). Use `userRepoName(handle,
label)` to compose it and `assertValidLabel(label)` to validate (lowercase, digits, hyphens).

## Key Methods

- `createRepo(name)`: Creates a private repository with an initial commit.
- `renameRepo(oldName, newName)`: Renames a repo in the org (GitHub keeps a redirect from the
  old name).
- `mintToken(repoNames)`: Generates a scoped access token for the specified repositories.
- `listRepos()`: Lists all repositories visible to the App installation.

## Configuration
Requires `GITHUB_APP_ID`, `GITHUB_WIKIS_ORG`, and `GITHUB_APP_PRIVATE_KEY_PATH` environment variables.

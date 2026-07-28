# @ceibo/mcps

A launcher for stateless MCP (Model Context Protocol) servers.

## Core Responsibilities

- **Unified Hosting**: Serves multiple MCP servers (Gmail, Calendar, Drive, Sheets, Notion) from a single process.
- **Secret-Based Mounting**: Only mounts servers that have a corresponding `_MCP_SECRET` environment variable defined.
- **Secure Routing**: Implements a `/<name>/<secret>` routing pattern with timing-safe equality checks to prevent unauthorized access.
- **Transport Layer**: Uses a shared core (`transport.ts`) to handle JSON-RPC over HTTP POST.

## Deployment
Typically runs behind an Nginx ingress that strips the `/mcp/` prefix and forwards requests to the launcher's port (default 8810).

## Adding a New Server
1. Implement the `McpServer` interface in `packages/mcps/src/servers/`.
2. Import the server in `packages/mcps/src/launch.ts`.
3. Add the server instance to the `REGISTRY` array.
4. Define the `<NAME>_MCP_SECRET` in the environment.

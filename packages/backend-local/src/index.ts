// @ceibo/backend-local — implementación de SessionBackend (la costura de @ceibo/agent) sobre
// archima: Agent Vault (credenciales) + cp.sh (lifecycle de VMs) + opencode (el loop del agente).
// Los tipos de la costura (SessionBackend, Sink, Relay, SessionConfig, …) viven en @ceibo/agent.

export type { AgentConfig, ArchimaDeps, Exec, OpencodeClient } from "./archima-backend.ts";
export { ArchimaBackend, SESSION_LOST_USER_MSG } from "./archima-backend.ts";
export type { ArchimaConfig } from "./factory.ts";
export { makeArchimaBackend, makeResolveBase, sshArgv } from "./factory.ts";
export type { HttpOpencodeConfig, RecoverResult } from "./http-opencode-client.ts";
export { HttpOpencodeClient, StreamIdleError } from "./http-opencode-client.ts";
export type {
  OpencodeEvent,
  OpencodeMessageInfo,
  OpencodePart,
  OpencodeTokens,
} from "./opencode-events.ts";
export { RelayTranslator } from "./opencode-events.ts";

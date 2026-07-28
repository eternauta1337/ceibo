// Cliente HTTP contra la REST API de Google, parametrizado por base URL.
// Lo comparten los MCP de la familia Google (gmail, calendar, sheets).
//
// NO guarda credenciales: forwardea el access_token del caller (el que Anthropic
// inyecta desde el vault mcp_oauth) como Bearer y nada más. Nunca loguea tokens.

/** Crea un cliente atado a una base (ej. la de Gmail). Devuelve un fetch tipado. */
export function googleClient(base: string) {
  return async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const msg =
        (body as { error?: { message?: string } })?.error?.message ?? `Google API HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body as T;
  };
}

/** Variante que devuelve el cuerpo crudo como texto (no JSON). La usa Drive para
 *  exportar Google Docs (`/export`) o bajar archivos de texto (`alt=media`), que
 *  no devuelven JSON. Trunca a `maxChars` para no inundar el contexto del agente. */
export function googleText(base: string) {
  return async function call(token: string, path: string, maxChars = 20_000): Promise<string> {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) {
      let msg = `Google API HTTP ${res.status}`;
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? msg;
      } catch {}
      throw new Error(msg);
    }
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncado]` : text;
  };
}

// Envío de magic links de acceso por email (Resend). Opt-in por `RESEND_API_KEY`: sin la key,
// `emailEnabled` es false y el endpoint POST /api/auth/email/start responde 503 (igual que el
// login Google sin config). El dominio `example.com` ya está verificado en Resend.
//
// El módulo NO debe romper el boot si falta la key (se importa siempre desde el entry-point):
// por eso el cliente Resend se construye sólo cuando hay key, y `sendMagicLinkEmail` lanza si lo
// llaman sin configurar (el endpoint ya gatea por `emailEnabled`, así que ese throw es defensivo).

import { Resend } from "resend";

// El env se lee en TIEMPO DE LLAMADA, no de import: el entry-point (`index.ts`) hace
// `process.loadEnvFile(...)` en el cuerpo del módulo, que corre DESPUÉS de que se evalúan los
// imports ES. Leer la key a nivel módulo la capturaría antes de que el .env esté cargado y
// dejaría `emailEnabled` en false aunque la key exista (regresión del PR #246).

/** True si el envío de mail está configurado (hay `RESEND_API_KEY`). Gatea el endpoint. */
export function emailEnabled(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/** Manda el magic link de acceso a `to`. El link vence ~5 min y es de un solo uso (lo da el
 *  token de `web_login_tokens`). Lanza si Resend devuelve un error (el caller lo loguea). */
export async function sendMagicLinkEmail({ to, url }: { to: string; url: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY no configurado");
  const resend = new Resend(apiKey);
  // From verificado en Resend (dominio example.com). Override por `MAIL_FROM`.
  const from = process.env.MAIL_FROM ?? "Ceibo <hello@example.com>";
  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e7e5e4;">
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;">Entrá a Ceibo</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#44403c;">
        Tocá el botón para entrar a tu cuenta. El link vence en ~5 minutos y es de un solo uso.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${url}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:15px;font-weight:600;">
          Entrar a Ceibo
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#78716c;">
        Si el botón no funciona, copiá y pegá este link en tu navegador:
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all;">
        <a href="${url}" style="color:#0369a1;">${url}</a>
      </p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#a8a29e;">
        Si no pediste este acceso, ignorá este mail.
      </p>
    </div>
  </body>
</html>`;
  const text = [
    "Entrá a Ceibo",
    "",
    "Abrí este link para entrar a tu cuenta (vence en ~5 minutos, es de un solo uso):",
    url,
    "",
    "Si no pediste este acceso, ignorá este mail.",
  ].join("\n");
  const { error } = await resend.emails.send({
    from,
    to,
    subject: "Tu link de acceso a Ceibo",
    html,
    text,
  });
  if (error) {
    throw new Error(typeof error === "string" ? error : (error.message ?? "resend error"));
  }
}

/** Manda el mail de invitación a una wiki. El link lleva al invitado a `/invitacion?i=<token>`
 *  donde la SPA (P4) muestra la invitación y el botón de aceptar. */
export async function sendWikiInviteEmail({
  to,
  inviterName,
  wikiLabel,
  acceptUrl,
}: {
  to: string;
  inviterName: string;
  wikiLabel: string;
  acceptUrl: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY no configurado");
  const resend = new Resend(apiKey);
  const from = process.env.MAIL_FROM ?? "Ceibo <hello@example.com>";
  const subject = `${inviterName} te invitó a Ceibo`;
  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e7e5e4;">
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;">${inviterName} te invitó a Ceibo</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#44403c;">
        Te invitaron a la wiki <strong>${wikiLabel}</strong>. Aceptá para quedar en la lista de espera — te avisamos por mail cuando tu acceso esté listo.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${acceptUrl}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:15px;font-weight:600;">
          Aceptar invitación
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#78716c;">
        Si el botón no funciona, copiá y pegá este link en tu navegador:
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all;">
        <a href="${acceptUrl}" style="color:#0369a1;">${acceptUrl}</a>
      </p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#a8a29e;">
        Si no conocés a ${inviterName}, ignorá este mail.
      </p>
    </div>
  </body>
</html>`;
  const text = [
    `${inviterName} te invitó a Ceibo`,
    "",
    `Te invitaron a la wiki "${wikiLabel}". Aceptá para quedar en la lista de espera:`,
    acceptUrl,
    "",
    `Si no conocés a ${inviterName}, ignorá este mail.`,
  ].join("\n");
  const { error } = await resend.emails.send({ from, to, subject, html, text });
  if (error) {
    throw new Error(typeof error === "string" ? error : (error.message ?? "resend error"));
  }
}

/** Manda el mail de aprobación: le avisa al usuario que su acceso está listo. */
export async function sendAccessApprovedEmail({ to }: { to: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY no configurado");
  const resend = new Resend(apiKey);
  const from = process.env.MAIL_FROM ?? "Ceibo <hello@example.com>";
  const loginUrl = "https://ceibo.example.com";
  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e7e5e4;">
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;">Tu acceso a Ceibo está listo</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#44403c;">
        Ya podés entrar con Google o pediendo tu link de acceso.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${loginUrl}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:15px;font-weight:600;">
          Entrar a Ceibo
        </a>
      </p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#a8a29e;">
        Si no esperabas este mensaje, ignoralo.
      </p>
    </div>
  </body>
</html>`;
  const text = [
    "Tu acceso a Ceibo está listo",
    "",
    "Ya podés entrar con Google o pediendo tu link de acceso:",
    loginUrl,
    "",
    "Si no esperabas este mensaje, ignoralo.",
  ].join("\n");
  const { error } = await resend.emails.send({
    from,
    to,
    subject: "Tu acceso a Ceibo está listo",
    html,
    text,
  });
  if (error) {
    throw new Error(typeof error === "string" ? error : (error.message ?? "resend error"));
  }
}

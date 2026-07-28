// Unit del mapeo scope → permisos legibles (detalle de Conexiones). Sin red ni DB: pura función.

import { describe, expect, it } from "vitest";
import { describePermissions } from "./index.ts";

describe("describePermissions", () => {
  it("gmail: traduce el scope otorgado a texto humano", () => {
    expect(
      describePermissions({
        service: "gmail",
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
      }),
    ).toEqual(["Leer tu correo", "Redactar y enviar correo"]);
  });

  it("sin scope otorgado, cae al catálogo del servicio (drive solo lectura)", () => {
    expect(describePermissions({ service: "drive" })).toEqual([
      "Ver y buscar archivos de Drive (solo lectura)",
    ]);
    expect(describePermissions({ service: "calendar", scope: "" })).toEqual([
      "Ver y crear eventos del calendario",
    ]);
    expect(describePermissions({ service: "sheets" })).toEqual(["Ver y editar planillas"]);
  });

  it("notion: mensaje propio (no usa scopes OAuth)", () => {
    expect(describePermissions({ service: "notion" })).toEqual([
      "Según los permisos de la integración de Notion",
    ]);
  });

  it("scope desconocido → fallback prolijo (último segmento de la URL)", () => {
    expect(
      describePermissions({
        service: "gmail",
        scope: "https://www.googleapis.com/auth/gmail.settings.basic",
      }),
    ).toEqual(["gmail.settings.basic"]);
    // openid/email/profile sí los conocemos.
    expect(describePermissions({ service: "gmail", scope: "openid email profile" })).toEqual([
      "Tu identidad básica",
      "Tu dirección de correo",
      "Tu perfil básico",
    ]);
  });

  it("servicio no-OAuth (whatsapp) sin scopes → [] (el caller oculta el bloque)", () => {
    expect(describePermissions({ service: "whatsapp" })).toEqual([]);
    expect(describePermissions({ service: "whatsapp", scope: "" })).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { emailEnabled } from "./email.ts";

// Regresión del PR #246: `email.ts` leía `RESEND_API_KEY` a nivel módulo (tiempo de import).
// Pero el entry-point carga el `.env` en el cuerpo del módulo, que corre DESPUÉS de evaluar los
// imports ES → la key quedaba sin leer y `emailEnabled` era false en prod aunque existiera.
// El fix lee el env en tiempo de LLAMADA. Este test simula ese orden: el módulo ya está
// importado y la key se setea después.
describe("emailEnabled (lectura lazy del env)", () => {
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it("es false sin RESEND_API_KEY", () => {
    delete process.env.RESEND_API_KEY;
    expect(emailEnabled()).toBe(false);
  });

  it("es true cuando RESEND_API_KEY se setea DESPUÉS de importar el módulo", () => {
    // El módulo ya fue importado arriba; setear la key ahora simula el loadEnvFile post-import.
    expect(emailEnabled()).toBe(false);
    process.env.RESEND_API_KEY = "re_test_key";
    expect(emailEnabled()).toBe(true);
  });
});

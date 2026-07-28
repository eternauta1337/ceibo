// Cifrado at-rest de los tokens OAuth (A3 de la auditoría 2026-06-08). Los
// `refresh_token`/`access_token` de `oauth_grants` se guardaban EN CLARO en el SQLite
// de la box; el robo de la DB/backup exponía todas las credenciales. Acá ciframos con
// AEAD (AES-256-GCM) y un nonce aleatorio POR ESCRITURA. La clave maestra vive FUERA de
// la DB (env `OAUTH_ENC_KEY`, 32 bytes en hex) → robar el .db sin el .env no sirve.
//
// Formato en columna: base64(nonce[12] || ciphertext || tag[16]).
//
// Pérdida de la clave = todos los grants ilegibles → los usuarios re-conectan. Backupear
// `OAUTH_ENC_KEY` junto con el resto de secrets de la box.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_BYTES = 12; // tamaño estándar de nonce para AES-GCM
const TAG_BYTES = 16; // tag de autenticación GCM

// Clave de test fija (32 bytes) usada SOLO bajo Vitest (`process.env.VITEST`), para que los
// tests que round-trippean grants no necesiten setear OAUTH_ENC_KEY. NUNCA se alcanza en prod
// (VITEST no está seteada) → si falta la clave real, `masterKey()` tira y no escribe en claro.
const TEST_KEY_HEX = "0".repeat(64);

function masterKey(): Buffer {
  let hex = process.env.OAUTH_ENC_KEY;
  if (!hex && process.env.VITEST) hex = TEST_KEY_HEX;
  if (!hex) {
    throw new Error("OAUTH_ENC_KEY no seteada (32 bytes en hex) — requerida para cifrar tokens OAuth");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(`OAUTH_ENC_KEY debe ser 32 bytes (64 chars hex); tiene ${key.length} bytes`);
  }
  return key;
}

/** Cifra un token (AES-256-GCM, nonce aleatorio por escritura). Devuelve
 *  base64(nonce || ciphertext || tag). */
export function encryptToken(plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

/** Descifra un blob `base64(nonce || ciphertext || tag)`. Lanza si la clave falta/es de
 *  largo inválido, el blob es corto, o el tag GCM no valida (token corrupto, clave equivocada,
 *  o fila vieja en claro de antes del cifrado). El caller decide qué hacer con el throw. */
export function decryptToken(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < NONCE_BYTES + TAG_BYTES) throw new Error("blob de token cifrado demasiado corto");
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

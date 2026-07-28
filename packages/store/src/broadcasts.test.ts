import { describe, expect, it } from "vitest";
import { listBroadcasts, openDb, recordBroadcast } from "./index.ts";

// DB en memoria (sin mocks): la auditoría de broadcasts es SQLite puro.
const freshDb = () => openDb(":memory:");

describe("broadcasts (anuncios de la empresa)", () => {
  it("registra un anuncio con su cuenta de enviados/fallidos", () => {
    const db = freshDb();
    const b = recordBroadcast(db, "Mantenimiento mañana", 5, 1);
    expect(b.id).toBeGreaterThan(0);
    expect(b.text).toBe("Mantenimiento mañana");
    expect(b.sent_count).toBe(5);
    expect(b.failed_count).toBe(1);
    expect(b.created_at).toBeTruthy();
    db.close();
  });

  it("lista del más reciente al más viejo y respeta el limit", () => {
    const db = freshDb();
    const first = recordBroadcast(db, "uno", 1, 0);
    const second = recordBroadcast(db, "dos", 2, 0);
    const third = recordBroadcast(db, "tres", 3, 0);
    expect(third.id).toBeGreaterThan(second.id);
    expect(second.id).toBeGreaterThan(first.id);

    expect(listBroadcasts(db).map((b) => b.text)).toEqual(["tres", "dos", "uno"]);
    expect(listBroadcasts(db, 2).map((b) => b.text)).toEqual(["tres", "dos"]);
    db.close();
  });

  it("default de fallidos a 0", () => {
    const db = freshDb();
    const b = recordBroadcast(db, "sin fallos", 3, 0);
    expect(b.failed_count).toBe(0);
    expect(listBroadcasts(db)).toHaveLength(1);
    db.close();
  });
});

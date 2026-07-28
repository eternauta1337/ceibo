import { afterEach, describe, expect, it, vi } from "vitest";
import { calendar } from "./calendar.ts";

afterEach(() => vi.unstubAllGlobals());

// Router de fetch: googleClient lee text() y hace JSON.parse. Capturamos POSTs.
function route(handler: (url: string, init: RequestInit) => unknown) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === "POST") posts.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true, status: 200, text: async () => JSON.stringify(handler(url, init)) } as Response;
    }),
  );
  return posts;
}

describe("calendar.callTool", () => {
  it("list_events: slim de cada evento + count", async () => {
    route(() => ({
      items: [
        {
          id: "e1",
          summary: "Reu",
          start: { dateTime: "2026-06-01T10:00:00Z" },
          end: { dateTime: "x" },
          location: "Zoom",
          status: "confirmed",
        },
      ],
    }));
    const out = (await calendar.callTool("tok", "list_events", { maxResults: 5 })) as {
      count: number;
      events: { id: string; summary: string; start: string }[];
    };
    expect(out.count).toBe(1);
    expect(out.events[0]).toMatchObject({ id: "e1", summary: "Reu", start: "2026-06-01T10:00:00Z" });
  });

  it("get_event: incluye descripción y asistentes", async () => {
    route(() => ({
      id: "e1",
      summary: "Reu",
      description: "agenda",
      attendees: [{ email: "a@b.com", responseStatus: "accepted" }],
    }));
    const out = (await calendar.callTool("tok", "get_event", { eventId: "e1" })) as {
      description: string;
      attendees: { email: string; status: string }[];
    };
    expect(out.description).toBe("agenda");
    expect(out.attendees[0]).toEqual({ email: "a@b.com", status: "accepted" });
  });

  it("create_event: día entero → {date}; con hora → {dateTime}", async () => {
    const posts = route(() => ({ id: "new", htmlLink: "http://x", summary: "T" }));
    await calendar.callTool("tok", "create_event", { summary: "T", start: "2026-06-01", end: "2026-06-02" });
    expect((posts[0]?.body as { start: unknown }).start).toEqual({ date: "2026-06-01" });
    await calendar.callTool("tok", "create_event", {
      summary: "T",
      start: "2026-06-01T10:00:00Z",
      end: "2026-06-01T11:00:00Z",
    });
    expect((posts[1]?.body as { start: unknown }).start).toEqual({ dateTime: "2026-06-01T10:00:00Z" });
  });

  it("tool desconocida → tira", async () => {
    route(() => ({}));
    await expect(calendar.callTool("tok", "nope", {})).rejects.toThrow(/desconocida/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStateAdapter } from "./state-memory.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("MemoryStateAdapter — KV + TTL", () => {
  it("set/get y delete", async () => {
    const a = new MemoryStateAdapter();
    await a.set("k", { n: 1 });
    expect(await a.get("k")).toEqual({ n: 1 });
    await a.delete("k");
    expect(await a.get("k")).toBeNull();
  });

  it("expira por TTL", async () => {
    const a = new MemoryStateAdapter();
    await a.set("k", "v", 1000);
    expect(await a.get("k")).toBe("v");
    vi.advanceTimersByTime(1001);
    expect(await a.get("k")).toBeNull();
  });

  it("setIfNotExists respeta el valor vivo", async () => {
    const a = new MemoryStateAdapter();
    expect(await a.setIfNotExists("k", "first")).toBe(true);
    expect(await a.setIfNotExists("k", "second")).toBe(false);
    expect(await a.get("k")).toBe("first");
  });
});

describe("MemoryStateAdapter — listas", () => {
  it("append y get devuelven copia, respetando maxLength (FIFO)", async () => {
    const a = new MemoryStateAdapter();
    await a.appendToList("l", 1);
    await a.appendToList("l", 2);
    await a.appendToList("l", 3, { maxLength: 2 });
    expect(await a.getList("l")).toEqual([2, 3]);
  });
});

describe("MemoryStateAdapter — colas", () => {
  it("enqueue/dequeue FIFO + depth + maxSize", async () => {
    const a = new MemoryStateAdapter();
    const e = (id: string) => ({ id }) as never;
    await a.enqueue("t", e("a"), 10);
    const depth = await a.enqueue("t", e("b"), 10);
    expect(depth).toBe(2);
    expect(await a.queueDepth("t")).toBe(2);
    expect(await a.dequeue("t")).toEqual({ id: "a" });
    expect(await a.dequeue("t")).toEqual({ id: "b" });
    expect(await a.dequeue("t")).toBeNull();
  });

  it("maxSize descarta los más viejos", async () => {
    const a = new MemoryStateAdapter();
    const e = (id: string) => ({ id }) as never;
    await a.enqueue("t", e("a"), 1);
    await a.enqueue("t", e("b"), 1);
    expect(await a.queueDepth("t")).toBe(1);
    expect(await a.dequeue("t")).toEqual({ id: "b" });
  });
});

describe("MemoryStateAdapter — locks", () => {
  it("acquire es exclusivo hasta el TTL; release lo libera", async () => {
    const a = new MemoryStateAdapter();
    const lock = await a.acquireLock("t", 1000);
    expect(lock).not.toBeNull();
    expect(await a.acquireLock("t", 1000)).toBeNull(); // tomado
    if (lock) await a.releaseLock(lock);
    expect(await a.acquireLock("t", 1000)).not.toBeNull();
  });

  it("acquire re-disponible tras expirar el TTL", async () => {
    const a = new MemoryStateAdapter();
    await a.acquireLock("t", 1000);
    vi.advanceTimersByTime(1001);
    expect(await a.acquireLock("t", 1000)).not.toBeNull();
  });

  it("extendLock solo con el token correcto; forceRelease siempre", async () => {
    const a = new MemoryStateAdapter();
    const lock = await a.acquireLock("t", 1000);
    expect(lock).not.toBeNull();
    if (!lock) return;
    expect(await a.extendLock(lock, 1000)).toBe(true);
    expect(await a.extendLock({ ...lock, token: "otro" }, 1000)).toBe(false);
    await a.forceReleaseLock("t");
    expect(await a.acquireLock("t", 1000)).not.toBeNull();
  });
});

describe("MemoryStateAdapter — subs", () => {
  it("subscribe/unsubscribe/isSubscribed", async () => {
    const a = new MemoryStateAdapter();
    expect(await a.isSubscribed("t")).toBe(false);
    await a.subscribe("t");
    expect(await a.isSubscribed("t")).toBe(true);
    await a.unsubscribe("t");
    expect(await a.isSubscribed("t")).toBe(false);
  });
});

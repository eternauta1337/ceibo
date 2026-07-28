// StateAdapter in-memory mínimo (single proceso). Implementa el contrato de `chat`
// (StateAdapter) sin backend externo. NO sirve para multi-proceso ni persiste
// cross-restart — para eso, en prod, un adapter Redis/SQLite (ver nanoclaw
// SqliteStateAdapter / @chat-adapter/state-redis). El estado del SDK es efímero
// (metering e identidad viven en el store), así que reset por reinicio no afecta datos.

import type { Lock, QueueEntry, StateAdapter } from "chat";

interface Entry {
  value: unknown;
  expiresAt?: number;
}

export class MemoryStateAdapter implements StateAdapter {
  #kv = new Map<string, Entry>();
  #lists = new Map<string, unknown[]>();
  #queues = new Map<string, QueueEntry[]>();
  #subs = new Set<string>();
  #locks = new Map<string, Lock>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  #live(key: string): Entry | undefined {
    const e = this.#kv.get(key);
    if (e?.expiresAt && e.expiresAt < Date.now()) {
      this.#kv.delete(key);
      return undefined;
    }
    return e;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.#live(key)?.value as T) ?? null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.#kv.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : undefined });
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    if (this.#live(key)) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.#kv.delete(key);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    const list = this.#lists.get(key) ?? [];
    list.push(value);
    if (options?.maxLength && list.length > options.maxLength) {
      list.splice(0, list.length - options.maxLength);
    }
    this.#lists.set(key, list);
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    return [...((this.#lists.get(key) as T[]) ?? [])];
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    const q = this.#queues.get(threadId) ?? [];
    q.push(entry);
    if (q.length > maxSize) q.splice(0, q.length - maxSize);
    this.#queues.set(threadId, q);
    return q.length;
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const q = this.#queues.get(threadId);
    return q?.shift() ?? null;
  }

  async queueDepth(threadId: string): Promise<number> {
    return this.#queues.get(threadId)?.length ?? 0;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const existing = this.#locks.get(threadId);
    if (existing && existing.expiresAt > Date.now()) return null;
    const lock: Lock = { threadId, token: crypto.randomUUID(), expiresAt: Date.now() + ttlMs };
    this.#locks.set(threadId, lock);
    return lock;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const cur = this.#locks.get(lock.threadId);
    if (!cur || cur.token !== lock.token) return false;
    cur.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async releaseLock(lock: Lock): Promise<void> {
    const cur = this.#locks.get(lock.threadId);
    if (cur && cur.token === lock.token) this.#locks.delete(lock.threadId);
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.#locks.delete(threadId);
  }

  async subscribe(threadId: string): Promise<void> {
    this.#subs.add(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.#subs.delete(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.#subs.has(threadId);
  }
}

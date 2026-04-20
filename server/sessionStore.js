/**
 * Session persistence: in-memory for local `npm start`, Upstash Redis when REST env is set (Vercel + Redis).
 */

import { createInitialState } from "./gameState.js";

const mem = new Map();
/** @type {Map<string, Promise<void>>} */
const chains = new Map();

/** @type {Promise<import('@upstash/redis').Redis> | null} */
let redisPromise = null;

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

export function usesPersistentStore() {
  return Boolean(redisEnv());
}

async function getRedis() {
  const cfg = redisEnv();
  if (!cfg) return null;
  if (!redisPromise) {
    redisPromise = import("@upstash/redis").then(({ Redis }) => new Redis({ url: cfg.url, token: cfg.token }));
  }
  return redisPromise;
}

/**
 * @template T
 * @param {string} sessionId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runSerialized(sessionId, fn) {
  const prev = chains.get(sessionId) || Promise.resolve();
  const next = prev.then(fn).catch((err) => {
    throw err;
  });
  chains.set(
    sessionId,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

function kvKey(sessionId) {
  return `tct:s:${sessionId}`;
}

/**
 * @param {string} sessionId
 * @returns {Promise<object | null>}
 */
export async function loadRoomRecord(sessionId) {
  const redis = await getRedis();
  if (!redis) {
    return mem.get(sessionId) || null;
  }
  const raw = await redis.get(kvKey(sessionId));
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {object} record
 */
export async function saveRoomRecord(sessionId, record) {
  const redis = await getRedis();
  if (!redis) {
    mem.set(sessionId, record);
    return;
  }
  await redis.set(kvKey(sessionId), JSON.stringify(record), { ex: 60 * 60 * 24 });
}

export function memorySessionCount() {
  return mem.size;
}

/**
 * @template T
 * @param {string} sessionId
 * @param {(rec: object | null) => Promise<{ record: object; result: T } | { skip: true; result: T }>}
 */
export async function mutateRoom(sessionId, updater) {
  return runSerialized(sessionId, async () => {
    let rec = await loadRoomRecord(sessionId);
    const out = await updater(rec);
    if ("skip" in out && out.skip) {
      return out.result;
    }
    await saveRoomRecord(sessionId, out.record);
    return out.result;
  });
}

/** @param {string} sessionId */
export function deleteRoomLocal(sessionId) {
  mem.delete(sessionId);
}

/**
 * @param {string} sessionId
 * @param {object} patch
 */
export function seedMemoryRoom(sessionId, patch) {
  const base = {
    sessionId,
    hostToken: null,
    revision: 0,
    state: createInitialState(),
    lastActivityAt: Date.now(),
  };
  mem.set(sessionId, { ...base, ...patch });
}

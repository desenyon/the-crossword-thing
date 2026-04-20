import crypto from "crypto";

export function createInitialState() {
  return {
    teams: {},
    events: [],
  };
}

function nowIso() {
  return new Date().toISOString();
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const cs = Math.floor((ms % 1000) / 10);
  if (m > 0) return `${m}:${String(r).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  return `${r}.${String(cs).padStart(2, "0")}s`;
}

function escapeHtmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeTeamName(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 40);
}

function sanitizeNote(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
}

function displayName(raw) {
  const cleaned = sanitizeTeamName(raw);
  return escapeHtmlText(cleaned) || "Team";
}

function pushEvent(state, line) {
  state.events.unshift({ ts: nowIso(), line });
  if (state.events.length > 120) {
    state.events.length = 120;
  }
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {object} msg
 * @param {{ now: number }} ctx
 */
export function applyClientMessage(state, msg, ctx) {
  const { now } = ctx;
  const next = structuredClone(state);
  const push = (line) => pushEvent(next, line);

  if (msg.type === "REGISTER_TEAM") {
    const teamId = typeof msg.teamId === "string" ? msg.teamId.slice(0, 64) : "";
    const rawName = typeof msg.teamName === "string" ? msg.teamName : "";
    const storedName = sanitizeTeamName(rawName) || "Team";
    if (!teamId) return { ok: false, error: "INVALID_TEAM", state: next };
    if (!next.teams[teamId]) {
      next.teams[teamId] = {
        name: storedName,
        bestMs: null,
        lifelines: 0,
        runStartedAt: null,
      };
      push(`<b>${displayName(storedName)}</b> joined the session`);
    } else if (rawName && storedName !== next.teams[teamId].name) {
      next.teams[teamId].name = storedName;
      push(`<b>${displayName(storedName)}</b> updated their display name`);
    }
    return { ok: true, state: next };
  }

  if (msg.type === "START_RUN") {
    const teamId = typeof msg.teamId === "string" ? msg.teamId.slice(0, 64) : "";
    if (!teamId || !next.teams[teamId]) {
      return { ok: false, error: "UNKNOWN_TEAM", state: next };
    }
    if (next.teams[teamId].runStartedAt != null) {
      return { ok: false, error: "ALREADY_RUNNING", state: next };
    }
    next.teams[teamId].runStartedAt = now;
    push(`<b>${displayName(next.teams[teamId].name)}</b> started the clock`);
    return { ok: true, state: next };
  }

  if (msg.type === "END_RUN") {
    const teamId = typeof msg.teamId === "string" ? msg.teamId.slice(0, 64) : "";
    if (!teamId || !next.teams[teamId]) {
      return { ok: false, error: "UNKNOWN_TEAM", state: next };
    }
    const started = next.teams[teamId].runStartedAt;
    if (started == null) {
      return { ok: false, error: "NOT_RUNNING", state: next };
    }
    const durationMs = Math.max(0, now - started);
    if (durationMs > 6 * 60 * 60 * 1000) {
      next.teams[teamId].runStartedAt = null;
      return { ok: false, error: "RUN_TOO_LONG", state: next };
    }
    const prev = next.teams[teamId].bestMs;
    const best = prev == null ? durationMs : Math.min(prev, durationMs);
    next.teams[teamId].bestMs = best;
    next.teams[teamId].runStartedAt = null;
    const nm = displayName(next.teams[teamId].name);
    push(
      `<b>${nm}</b> finished in <b>${formatMs(durationMs)}</b> (best <b>${formatMs(best)}</b>)`,
    );
    return { ok: true, state: next, durationMs, teamId };
  }

  if (msg.type === "LIFELINE") {
    const teamId = typeof msg.teamId === "string" ? msg.teamId.slice(0, 64) : "";
    const noteRaw = typeof msg.note === "string" ? msg.note : "";
    const notePlain = sanitizeNote(noteRaw) || "Physics pass";
    if (!teamId || !next.teams[teamId]) {
      return { ok: false, error: "UNKNOWN_TEAM", state: next };
    }
    next.teams[teamId].lifelines += 1;
    push(
      `<b>${displayName(next.teams[teamId].name)}</b> used a lifeline — <b>${escapeHtmlText(notePlain)}</b>`,
    );
    return { ok: true, state: next };
  }

  if (msg.type === "RESET_SESSION") {
    return { ok: true, state: createInitialState(), reset: true };
  }

  return { ok: false, error: "UNKNOWN_TYPE", state: next };
}

export function newHostToken() {
  return crypto.randomBytes(24).toString("hex");
}

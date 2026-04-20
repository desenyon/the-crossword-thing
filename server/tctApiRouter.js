import { Router } from "express";
import { applyClientMessage, createInitialState, newHostToken } from "./gameState.js";
import {
  mutateRoom,
  loadRoomRecord,
  memorySessionCount,
  usesPersistentStore,
} from "./sessionStore.js";

export const SESSION_RE = /^[A-Z2-9]{6}$/;
const MAX_TEAMS = 100;

const router = Router();

export function normalizeSessionId(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, 6);
}

/**
 * @param {object | null} rec
 * @returns {object}
 */
function emptyRecord(sessionId) {
  return {
    sessionId,
    hostToken: null,
    revision: 0,
    state: createInitialState(),
    lastActivityAt: Date.now(),
  };
}

/**
 * @param {object} rec
 */
function bump(rec) {
  rec.revision += 1;
  rec.lastActivityAt = Date.now();
}

router.post("/hello", async (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = normalizeSessionId(body.sessionId);
    if (!SESSION_RE.test(sessionId)) {
      res.status(400).json({
        ok: false,
        code: "BAD_SESSION",
        message: "Session code must be 6 letters/numbers",
      });
      return;
    }

    const r = body.role === "host" ? "host" : body.role === "play" ? "play" : null;
    if (!r) {
      res.status(400).json({ ok: false, code: "BAD_ROLE", message: "role must be host or play" });
      return;
    }

    const payload = await mutateRoom(sessionId, async (rec) => {
      const isNewSession = !rec;
      let room = rec;
      if (!room) {
        if (!usesPersistentStore() && memorySessionCount() >= 400) {
          return {
            skip: true,
            result: { ok: false, code: "SERVER_FULL", message: "Too many active sessions" },
          };
        }
        room = emptyRecord(sessionId);
      }

      let authorizedReset = false;
      let hostMintedToken = false;
      if (r === "host") {
        if (!room.hostToken) {
          room.hostToken = newHostToken();
          authorizedReset = true;
          hostMintedToken = true;
        } else if (typeof body.hostToken === "string" && body.hostToken === room.hostToken) {
          authorizedReset = true;
        }
      }

      if (r === "play") {
        const teamId = typeof body.teamId === "string" ? body.teamId.slice(0, 64) : "";
        if (!teamId) {
          return { skip: true, result: { ok: false, code: "BAD_TEAM", message: "teamId required" } };
        }
        if (Object.keys(room.state.teams).length >= MAX_TEAMS && !room.state.teams[teamId]) {
          return { skip: true, result: { ok: false, code: "ROOM_FULL", message: "Too many teams in session" } };
        }
        const teamName =
          typeof body.teamName === "string" ? body.teamName.trim().slice(0, 40) : "";
        const reg = applyClientMessage(
          room.state,
          { type: "REGISTER_TEAM", teamId, teamName },
          { now: Date.now() },
        );
        if (reg.ok) {
          room.state = reg.state;
          bump(room);
        }
      } else if (r === "host") {
        if (hostMintedToken) {
          bump(room);
        } else if (isNewSession) {
          bump(room);
        } else {
          room.lastActivityAt = Date.now();
        }
      }

      return {
        record: room,
        result: {
          ok: true,
          type: "hello_ok",
          sessionId: room.sessionId,
          revision: room.revision,
          state: room.state,
          role: r,
          hostToken: r === "host" && authorizedReset ? room.hostToken : undefined,
          authorizedReset,
        },
      };
    });

    if (!payload.ok) {
      res.status(payload.code === "SERVER_FULL" ? 503 : 400).json(payload);
      return;
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

router.get("/state", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    const sessionId = normalizeSessionId(req.query.session);
    if (!SESSION_RE.test(sessionId)) {
      res.status(400).json({ ok: false, message: "Bad session id" });
      return;
    }
    const rec = await loadRoomRecord(sessionId);
    if (!rec) {
      res.json({
        ok: true,
        exists: false,
        revision: 0,
        state: createInitialState(),
      });
      return;
    }
    res.json({
      ok: true,
      exists: true,
      revision: rec.revision,
      state: rec.state,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

router.post("/event", async (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = normalizeSessionId(body.sessionId);
    if (!SESSION_RE.test(sessionId)) {
      res.status(400).json({ ok: false, code: "BAD_SESSION", message: "Bad session" });
      return;
    }

    const baseRevision = Number(body.baseRevision);
    if (!Number.isFinite(baseRevision) || baseRevision < 0) {
      res.status(400).json({ ok: false, code: "BAD_REVISION", message: "baseRevision required" });
      return;
    }

    const role = body.role === "host" ? "host" : body.role === "play" ? "play" : null;
    if (!role) {
      res.status(400).json({ ok: false, code: "BAD_ROLE", message: "role required" });
      return;
    }

    const msg = body.message;
    if (!msg || typeof msg !== "object") {
      res.status(400).json({ ok: false, code: "BAD_MESSAGE", message: "message required" });
      return;
    }

    const teamIdBound =
      typeof body.teamId === "string" ? body.teamId.slice(0, 64) : "";

    const out = await mutateRoom(sessionId, async (rec) => {
      if (!rec) {
        return {
          skip: true,
          result: { ok: false, code: "NO_SESSION", message: "Session not started yet" },
        };
      }
      if (rec.revision !== baseRevision) {
        return {
          skip: true,
          result: {
            ok: false,
            conflict: true,
            revision: rec.revision,
            state: rec.state,
          },
        };
      }

      const now = Date.now();

      if (msg.type === "RESET_SESSION") {
        if (role !== "host") {
          return {
            skip: true,
            result: { ok: false, code: "FORBIDDEN", message: "Only host can reset" },
          };
        }
        if (typeof body.hostToken !== "string" || body.hostToken !== rec.hostToken) {
          return {
            skip: true,
            result: { ok: false, code: "FORBIDDEN", message: "Invalid host key" },
          };
        }
        rec.state = createInitialState();
        bump(rec);
        return {
          record: rec,
          result: { ok: true, revision: rec.revision, state: rec.state },
        };
      }

      if (msg.type === "REGISTER_TEAM") {
        if (role !== "play" || !teamIdBound) {
          return {
            skip: true,
            result: { ok: false, code: "FORBIDDEN", message: "Only team devices can register" },
          };
        }
        if (msg.teamId !== teamIdBound) {
          return {
            skip: true,
            result: { ok: false, code: "FORBIDDEN", message: "teamId mismatch" },
          };
        }
        const result = applyClientMessage(rec.state, msg, { now });
        if (!result.ok) {
          return {
            skip: true,
            result: { ok: false, code: result.error || "BAD", message: "Could not apply" },
          };
        }
        rec.state = result.state;
        bump(rec);
        return {
          record: rec,
          result: { ok: true, revision: rec.revision, state: rec.state },
        };
      }

      if (msg.type === "START_RUN" || msg.type === "END_RUN" || msg.type === "LIFELINE") {
        if (role !== "play" || !teamIdBound) {
          return {
            skip: true,
            result: { ok: false, code: "FORBIDDEN", message: "Only team devices can time runs" },
          };
        }
        if (msg.teamId !== teamIdBound) {
          return {
            skip: true,
            result: { ok: false, code: "FORBIDDEN", message: "teamId mismatch" },
          };
        }
        const result = applyClientMessage(rec.state, msg, { now });
        if (!result.ok) {
          return {
            skip: true,
            result: { ok: false, code: result.error || "BAD", message: "Could not apply" },
          };
        }
        rec.state = result.state;
        bump(rec);
        const base = { ok: true, revision: rec.revision, state: rec.state };
        if (msg.type === "END_RUN" && result.ok && "durationMs" in result) {
          return {
            record: rec,
            result: {
              ...base,
              runResult: {
                durationMs: result.durationMs,
                teamId: result.teamId,
              },
            },
          };
        }
        return { record: rec, result: base };
      }

      return {
        skip: true,
        result: { ok: false, code: "UNKNOWN", message: "Unknown message type" },
      };
    });

    if (!out.ok) {
      const status = out.conflict ? 409 : out.code === "FORBIDDEN" ? 403 : 400;
      res.status(status).json(out);
      return;
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

export { router as tctRouter };

const STORAGE_TEAM = "tct_team_v1";

function randomSessionId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function getOrCreateTeamId() {
  try {
    const raw = localStorage.getItem(STORAGE_TEAM);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.id) return parsed;
    }
  } catch {
    /* ignore */
  }
  const id = `team_${Math.random().toString(36).slice(2, 12)}`;
  const payload = { id, name: "" };
  localStorage.setItem(STORAGE_TEAM, JSON.stringify(payload));
  return payload;
}

function setTeamName(name) {
  const cur = getOrCreateTeamId();
  const next = { ...cur, name: name.trim().slice(0, 40) };
  localStorage.setItem(STORAGE_TEAM, JSON.stringify(next));
  return next;
}

function hostKeyStorage(sessionId) {
  return `tct_host_${sessionId}`;
}

function loadHostToken(sessionId) {
  try {
    return sessionStorage.getItem(hostKeyStorage(sessionId)) || "";
  } catch {
    return "";
  }
}

function saveHostToken(sessionId, token) {
  try {
    if (token) {
      sessionStorage.setItem(hostKeyStorage(sessionId), token);
    }
  } catch {
    /* ignore */
  }
}

function parseRoute() {
  const raw = (location.hash || "#/").slice(1);
  const [path, query = ""] = raw.includes("?") ? raw.split("?") : [raw, ""];
  const params = new URLSearchParams(query);
  return { path: path || "home", params };
}

function setHash(path, params) {
  const qs = params && params.toString ? params.toString() : "";
  location.hash = qs ? `#${path}?${qs}` : `#${path}`;
}

function appBaseUrl() {
  if (window.location.protocol === "file:") {
    return "";
  }
  const u = new URL(window.location.href);
  u.hash = "";
  return u.toString();
}

function buildJoinUrls(sessionId) {
  const base = appBaseUrl();
  if (!base) {
    return {
      host: "",
      play: "",
    };
  }
  const host = `${base}#/host?session=${encodeURIComponent(sessionId)}`;
  const play = `${base}#/play?session=${encodeURIComponent(sessionId)}`;
  return { host, play };
}

function qrUrlFor(text) {
  const enc = encodeURIComponent(text);
  return `/api/qr?text=${enc}`;
}

function apiPrefix() {
  return "";
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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toast(title, detail) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${escapeHtml(title)}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
  stack.appendChild(el);
  window.setTimeout(() => {
    el.remove();
  }, 5200);
}

const defaultState = () => ({
  teams: {},
  events: [],
});

let hostState = defaultState();
let lastRevision = 0;

/** @type {HttpSession | null} */
let rt = null;

class HttpSession {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {'host'|'play'} opts.role
   * @param {() => void} [opts.onState]
   * @param {(info: object) => void} [opts.onHello]
   * @param {(ms: number) => void} [opts.onRunResult]
   * @param {(kind: 'open'|'closed'|'backoff') => void} [opts.onSocket]
   */
  constructor(opts) {
    this.opts = opts;
    this.pollTimer = null;
    this.closedByUser = false;
    this.lastRev = 0;
    this._pollBusy = false;
  }

  async start() {
    if (this.closedByUser) return;
    this.opts.onSocket?.("open");
    try {
      const body = {
        sessionId: this.opts.sessionId,
        role: this.opts.role,
      };
      if (this.opts.role === "host") {
        const token = loadHostToken(this.opts.sessionId);
        if (token) body.hostToken = token;
      }
      if (this.opts.role === "play") {
        const t = getOrCreateTeamId();
        body.teamId = t.id;
        body.teamName = t.name || "";
      }
      const r = await fetch(`${apiPrefix()}/api/tct/hello`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(data.message || "Could not join session", data.code || String(r.status));
        this.opts.onSocket?.("closed");
        return;
      }
      if (typeof data.hostToken === "string" && data.hostToken) {
        saveHostToken(this.opts.sessionId, data.hostToken);
      }
      this.lastRev = Number(data.revision) || 0;
      lastRevision = this.lastRev;
      hostState = data.state || defaultState();
      this.opts.onHello?.(data);
      this.opts.onState?.();
      this.pollTimer = window.setInterval(() => void this.poll(), 1200);
      void this.poll();
    } catch (e) {
      toast("Network error", String(e?.message || e));
      this.opts.onSocket?.("closed");
    }
  }

  async poll() {
    if (this.closedByUser || this._pollBusy) return;
    this._pollBusy = true;
    try {
      const r = await fetch(
        `${apiPrefix()}/api/tct/state?session=${encodeURIComponent(this.opts.sessionId)}`,
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        this.opts.onSocket?.("backoff");
        return;
      }
      const rev = Number(d.revision) || 0;
      if (rev > this.lastRev) {
        this.lastRev = rev;
        lastRevision = this.lastRev;
        hostState = d.state || defaultState();
        this.opts.onState?.();
      }
      this.opts.onSocket?.("open");
    } catch {
      this.opts.onSocket?.("backoff");
    } finally {
      this._pollBusy = false;
    }
  }

  /**
   * @param {object} message
   */
  async sendEvent(message) {
    if (this.closedByUser) return;
    const buildBody = (baseRevision) => ({
      sessionId: this.opts.sessionId,
      role: this.opts.role,
      baseRevision,
      teamId: this.opts.role === "play" ? getOrCreateTeamId().id : undefined,
      hostToken: message.type === "RESET_SESSION" ? loadHostToken(this.opts.sessionId) : undefined,
      message,
    });
    let base = this.lastRev;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const r = await fetch(`${apiPrefix()}/api/tct/event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBody(base)),
        });
        const out = await r.json().catch(() => ({}));
        if (r.status === 409 && out.conflict) {
          this.lastRev = Number(out.revision) || this.lastRev;
          lastRevision = this.lastRev;
          if (out.state) {
            hostState = out.state;
            this.opts.onState?.();
          }
          base = this.lastRev;
          continue;
        }
        if (!r.ok) {
          toast(out.message || "Request failed", out.code || String(r.status));
          return;
        }
        this.lastRev = Number(out.revision) || this.lastRev;
        lastRevision = this.lastRev;
        if (out.state) {
          hostState = out.state;
        }
        if (out.runResult?.durationMs != null) {
          this.opts.onRunResult?.(out.runResult.durationMs);
        }
        this.opts.onState?.();
        return;
      } catch (e) {
        toast("Network error", String(e?.message || e));
        return;
      }
    }
    toast("Still busy", "Try the action again in a moment.");
  }

  stop() {
    this.closedByUser = true;
    if (this.pollTimer) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.opts.onSocket?.("closed");
  }
}

function sortedTeams(state) {
  return Object.entries(state.teams)
    .map(([id, t]) => ({ id, ...t }))
    .sort((a, b) => {
      const ab = a.bestMs ?? Infinity;
      const bb = b.bestMs ?? Infinity;
      if (ab !== bb) return ab - bb;
      return a.name.localeCompare(b.name);
    });
}

function renderTopbar(path, sessionId) {
  const el = document.getElementById("topbar-actions");
  if (!el) return;
  const parts = [];
  if (path !== "home") {
    parts.push(`<button class="btn btn-ghost" type="button" data-nav="home">Home</button>`);
  }
  if (sessionId) {
    parts.push(`<span class="pill">Session <strong class="mono">${escapeHtml(sessionId)}</strong></span>`);
  }
  el.innerHTML = parts.join("");
  el.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => setHash(btn.getAttribute("data-nav"), new URLSearchParams()));
  });
}

function renderHome() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <section class="panel">
      <h1 class="h1">Race the grid. Beat the clock.</h1>
      <p class="lead">
        The host laptop runs this app and shows the live leaderboard. Teams join on their phones, start and stop an official timer, and use a lifeline that is logged for everyone.
        Times are measured on the server so they stay fair on busy classroom WiFi.
      </p>
      <div class="row" style="margin-top:8px;">
        <button class="btn btn-primary" type="button" id="create-session">Create session (host laptop)</button>
      </div>
      <div class="panel" style="margin-top:16px; box-shadow:none;">
        <h2 class="h1" style="font-size:1.1rem;">Join as a team device</h2>
        <p class="lead" style="margin-bottom:10px;">Enter the six-character session code from the host screen.</p>
        <div class="row">
          <input class="input mono" id="join-code" maxlength="8" placeholder="e.g. Q7KP2M" autocomplete="off" />
          <button class="btn btn-primary" type="button" id="join-play">Join as team</button>
        </div>
      </div>
    </section>
  `;

  document.getElementById("create-session").addEventListener("click", () => {
    const sessionId = randomSessionId();
    setHash("host", new URLSearchParams({ session: sessionId }));
  });

  document.getElementById("join-play").addEventListener("click", () => {
    const code = document.getElementById("join-code").value.trim().toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
    if (code.length !== 6) {
      toast("Session codes are 6 characters", "Use the code from the host screen.");
      return;
    }
    setHash("play", new URLSearchParams({ session: code }));
  });
}

let hostUi = {
  canReset: false,
  socket: "closed",
};

function setSyncBadge() {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");
  if (!dot || !label) return;
  dot.classList.remove("off", "warn");
  if (hostUi.socket === "open") {
    label.textContent = "live · synced";
  } else if (hostUi.socket === "backoff") {
    dot.classList.add("warn");
    label.textContent = "reconnecting…";
  } else {
    dot.classList.add("off");
    label.textContent = "offline";
  }
}

function renderHost(sessionId) {
  const urls = buildJoinUrls(sessionId);
  const app = document.getElementById("app");
  app.innerHTML = `
    <section class="panel">
      <div class="row" style="justify-content:space-between;">
        <div>
          <h1 class="h1">Host control room</h1>
          <p class="lead" style="margin:0;">Project this page on the same URL everyone is using. Teams scan the play QR. Keep this tab open for the whole game.</p>
        </div>
        <span class="badge" id="sync-badge"><span class="badge-dot" id="sync-dot"></span><span id="sync-label">connecting…</span></span>
      </div>
      <div id="host-banner"></div>
      <div class="row" style="margin-top:12px;">
        <button class="btn btn-danger" type="button" id="reset-board" disabled>Reset leaderboard</button>
        <button class="btn" type="button" id="copy-play">Copy play link</button>
        <button class="btn btn-ghost" type="button" id="copy-host-key" disabled>Copy host key</button>
      </div>
    </section>

    <div class="grid-2">
      <section class="panel">
        <h2 class="h1" style="font-size:1.15rem;">Scan to join (two QR codes)</h2>
        <p class="lead" style="margin-bottom:12px;">Host QR reopens this leaderboard on another device. Play QR opens the team timer.</p>
        <div class="qr-card">
          <div class="qr-grid">
            <div>
              <h3>Host / leaderboard</h3>
              <div class="qr-frame">
                <img alt="QR code for host URL" src="${urls.host ? qrUrlFor(urls.host) : ""}" />
              </div>
              <div class="qr-caption mono">${escapeHtml(urls.host || "Open this site from the laptop URL first.")}</div>
            </div>
            <div>
              <h3>Team devices</h3>
              <div class="qr-frame">
                <img alt="QR code for play URL" src="${urls.play ? qrUrlFor(urls.play) : ""}" />
              </div>
              <div class="qr-caption mono">${escapeHtml(urls.play || "")}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2 class="h1" style="font-size:1.15rem;">Live leaderboard</h2>
        <p class="lead" style="margin-bottom:12px;">Best official time wins. Lifelines are public.</p>
        <div id="leader-wrap"></div>
        <h3 class="h1" style="font-size:1rem; margin-top:16px;">Room log</h3>
        <div class="log" id="log-wrap"></div>
      </section>
    </div>
  `;

  const banner = document.getElementById("host-banner");
  const resetBtn = document.getElementById("reset-board");
  const copyKey = document.getElementById("copy-host-key");

  function paintHostChrome() {
    const token = loadHostToken(sessionId);
    resetBtn.disabled = !hostUi.canReset;
    copyKey.disabled = !token;
    if (banner) {
      if (hostUi.socket !== "open") {
        banner.innerHTML = "";
      } else if (hostUi.canReset) {
        banner.innerHTML = "";
      } else if (token) {
        banner.innerHTML = `<div class="banner">Read-only host view. A host key is saved on this browser, but the server did not accept it for reset. Use the first host tab, or paste a current key from an authorized tab.</div>`;
      } else {
        banner.innerHTML = `<div class="banner">Read-only host view. Leaderboard updates live, but reset requires the host key from the first host tab (use Copy host key there).</div>`;
      }
    }
    setSyncBadge();
  }

  resetBtn.addEventListener("click", () => {
    const token = loadHostToken(sessionId);
    if (!token) {
      toast("Missing host key", "Open the first host tab once, or copy the host key.");
      return;
    }
    if (!window.confirm("Reset the entire leaderboard and log for this session?")) return;
    void rt?.sendEvent({ type: "RESET_SESSION" });
  });

  document.getElementById("copy-play").addEventListener("click", async () => {
    if (!urls.play) return;
    try {
      await navigator.clipboard.writeText(urls.play);
      toast("Copied play link");
    } catch {
      prompt("Copy this play link:", urls.play);
    }
  });

  copyKey.addEventListener("click", async () => {
    const token = loadHostToken(sessionId);
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      toast("Copied host key", "Store it somewhere safe for this session.");
    } catch {
      prompt("Host key:", token);
    }
  });

  paintHostChrome();
  paintHost();

  rt = new HttpSession({
    sessionId,
    role: "host",
    onHello: (msg) => {
      hostUi.canReset = Boolean(msg.authorizedReset);
      paintHostChrome();
    },
    onState: () => {
      paintHost();
    },
    onSocket: (kind) => {
      hostUi.socket = kind === "open" ? "open" : kind === "backoff" ? "backoff" : "closed";
      paintHostChrome();
    },
  });
  void rt.start();
}

function paintHost() {
  const wrap = document.getElementById("leader-wrap");
  const log = document.getElementById("log-wrap");
  if (!wrap || !log) return;

  const rows = sortedTeams(hostState);
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty">Waiting for teams to join…</div>`;
  } else {
    wrap.innerHTML = `
      <div class="leader">
        <div class="leader-row head">
          <div>#</div><div>Team</div><div class="time">Best</div><div class="life">Lifelines</div>
        </div>
        ${rows
          .map(
            (t, idx) => `
          <div class="leader-row">
            <div class="rank">${idx + 1}</div>
            <div class="team">${escapeHtml(t.name)}</div>
            <div class="time mono">${t.bestMs == null ? "—" : formatMs(t.bestMs)}</div>
            <div class="life mono">${t.lifelines}</div>
          </div>
        `,
          )
          .join("")}
      </div>
    `;
  }

  if (!hostState.events.length) {
    log.innerHTML = `<div class="empty">No events yet.</div>`;
  } else {
    log.innerHTML = hostState.events.map((e) => `<div class="log-item">${e.line}</div>`).join("");
  }
}

function renderPlay(sessionId) {
  const team = getOrCreateTeamId();
  const app = document.getElementById("app");
  app.innerHTML = `
    <section class="panel">
      <div class="row" style="justify-content:space-between;">
        <div>
          <h1 class="h1">Team console</h1>
          <p class="lead" style="margin:0;">Session <span class="mono">${escapeHtml(sessionId)}</span>. Official times are computed on the server when you press End.</p>
        </div>
        <span class="badge" id="sync-badge"><span class="badge-dot" id="sync-dot"></span><span id="sync-label">connecting…</span></span>
      </div>
      <div class="row" style="margin-top:8px;">
        <input class="input" id="team-name" maxlength="40" placeholder="Team name (shown on leaderboard)" value="${escapeHtml(team.name || "")}" />
        <button class="btn btn-primary" type="button" id="save-name">Save name</button>
      </div>
      <div class="status-line">
        <span class="pill">Clock <strong id="clock-state">idle</strong></span>
        <span class="pill">Lifelines used <strong id="life-count">0</strong></span>
      </div>
      <p class="timer-big mono" id="live-timer">0.00s</p>
      <p class="lead" id="official-line" style="margin-top:6px; font-size:0.9rem; display:none;"></p>
      <div class="player-actions" style="margin-top:10px;">
        <button class="btn btn-primary" type="button" id="btn-start">Start time</button>
        <button class="btn btn-danger" type="button" id="btn-end" disabled>End time</button>
        <button class="btn btn-warn" type="button" id="btn-life">Lifeline: Physics pass</button>
      </div>
      <p class="lead" style="margin-top:14px; font-size:0.9rem;">
        Lifelines are meant for a real classroom constraint (for example, a quick physics hint). Every use is announced on the host screen.
      </p>
    </section>
  `;

  let startTs = null;
  let raf = null;
  let playUi = { socket: "closed" };

  const clockState = document.getElementById("clock-state");
  const live = document.getElementById("live-timer");
  const btnStart = document.getElementById("btn-start");
  const btnEnd = document.getElementById("btn-end");
  const lifeCount = document.getElementById("life-count");
  const officialLine = document.getElementById("official-line");
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");

  function setPlayBadge() {
    if (!dot || !label) return;
    dot.classList.remove("off", "warn");
    if (playUi.socket === "open") {
      label.textContent = "live · synced";
    } else if (playUi.socket === "backoff") {
      dot.classList.add("warn");
      label.textContent = "reconnecting…";
    } else {
      dot.classList.add("off");
      label.textContent = "offline";
    }
  }

  function stopTick() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  function tick() {
    if (startTs == null) return;
    const d = Date.now() - startTs;
    live.textContent = formatMs(d);
    raf = requestAnimationFrame(tick);
  }

  function syncLifelinesFromServer() {
    const id = getOrCreateTeamId().id;
    const row = hostState.teams[id];
    const n = row?.lifelines ?? 0;
    lifeCount.textContent = String(n);
  }

  function register() {
    const t = getOrCreateTeamId();
    void rt?.sendEvent({
      type: "REGISTER_TEAM",
      teamId: t.id,
      teamName: t.name || "",
    });
  }

  document.getElementById("save-name").addEventListener("click", () => {
    const name = document.getElementById("team-name").value;
    setTeamName(name);
    register();
  });

  btnStart.addEventListener("click", () => {
    if (startTs != null) return;
    startTs = Date.now();
    clockState.textContent = "running";
    btnStart.disabled = true;
    btnEnd.disabled = false;
    officialLine.style.display = "none";
    void rt?.sendEvent({
      type: "START_RUN",
      teamId: getOrCreateTeamId().id,
      ts: startTs,
    });
    tick();
  });

  btnEnd.addEventListener("click", () => {
    if (startTs == null) return;
    const localMs = Date.now() - startTs;
    stopTick();
    startTs = null;
    live.textContent = formatMs(localMs);
    clockState.textContent = "idle";
    btnStart.disabled = false;
    btnEnd.disabled = true;
    void rt?.sendEvent({
      type: "END_RUN",
      teamId: getOrCreateTeamId().id,
      durationMs: localMs,
    });
  });

  document.getElementById("btn-life").addEventListener("click", () => {
    void rt?.sendEvent({
      type: "LIFELINE",
      teamId: getOrCreateTeamId().id,
      note: "Physics pass",
    });
  });

  rt = new HttpSession({
    sessionId,
    role: "play",
    onState: () => {
      syncLifelinesFromServer();
    },
    onRunResult: (durationMs) => {
      officialLine.style.display = "block";
      officialLine.textContent = `Official time recorded: ${formatMs(durationMs)}`;
    },
    onSocket: (kind) => {
      playUi.socket = kind === "open" ? "open" : kind === "backoff" ? "backoff" : "closed";
      setPlayBadge();
    },
  });
  void rt.start();

  syncLifelinesFromServer();
  setPlayBadge();
}

function attachRealtime(sessionId, role) {
  if (rt) {
    rt.stop();
    rt = null;
  }
  lastRevision = 0;
  hostState = defaultState();
  hostUi = { canReset: false, socket: "closed" };
}

function route() {
  const { path, params } = parseRoute();
  const sessionId = (params.get("session") || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);

  renderTopbar(path, sessionId || null);

  if (path === "home" || path === "") {
    attachRealtime("", "home");
    renderHome();
    return;
  }

  if (!sessionId || sessionId.length !== 6) {
    setHash("home", new URLSearchParams());
    return;
  }

  if (path === "host") {
    attachRealtime(sessionId, "host");
    renderHost(sessionId);
    return;
  }

  if (path === "play") {
    attachRealtime(sessionId, "play");
    renderPlay(sessionId);
    return;
  }

  setHash("home", new URLSearchParams());
}

window.addEventListener("hashchange", route);
route();

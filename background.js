"use strict";

/**
 * Background page.
 *
 * Owns the OAuth handshake (so the popup can be closed mid-flow), polls Gmail
 * on an alarm, and copies fresh one-time codes. A small history and an
 * "already examined" log keep the API budget at roughly one request per poll
 * plus one per new message.
 */
const POLL_ALARM = "otpgrabber-poll";
const LEGACY_POLL_ALARM = "gmail-otp-poll"; // pre-rename name, cleared on startup
const MANUAL_REDIRECT = "http://localhost:8765/";
const HISTORY_LIMIT = 10;
const EXAMINED_LIMIT = 200;
const EXAMINED_TTL_MS = 48 * 3600_000;
const MAX_MESSAGES_PER_POLL = 25;

const STATUS_DEFAULTS = {
  connected: false,
  email: null,
  authState: "idle", // idle | starting | awaiting-code | connected | error
  message: "",
  lastError: "",
  lastPollAt: 0,
  lastCodeAt: 0,
  polling: false,
  clipboardBlocked: false,
  standbyUntil: 0
};

let settings = null;
let polling = false;
let pendingAuth = null;
let clipboardBlocked = false;
let standbyTimer = null;

// ------------------------------------------------------------------ status

async function setStatus(patch) {
  const stored = await browser.storage.local.get("status");
  const status = Object.assign({}, STATUS_DEFAULTS, stored.status || {}, patch || {});
  status.clipboardBlocked = clipboardBlocked;
  await browser.storage.local.set({ status });
  return status;
}

// --------------------------------------------------------------- clipboard

/**
 * Writes to the clipboard from the background page. `clipboardWrite` normally
 * lets this through without a user gesture; the execCommand path is a fallback
 * for the cases where navigator.clipboard is unavailable.
 */
async function copyToClipboard(text) {
  if (text === undefined || text === null) return false;
  const value = String(text);

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) {
    /* fall through */
  }

  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;width:2px;height:2px;padding:0;border:0;opacity:0;";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

// ----------------------------------------------------------------- history

async function getLastCode() {
  const data = await browser.storage.local.get("lastCode");
  return data.lastCode || null;
}

async function pushHistory(entry) {
  const data = await browser.storage.local.get("history");
  const history = Array.isArray(data.history) ? data.history : [];
  const withoutDuplicate = history.filter((h) => !(h.code === entry.code && Math.abs(h.at - entry.at) < 60_000));
  withoutDuplicate.unshift(entry);
  await browser.storage.local.set({ history: withoutDuplicate.slice(0, HISTORY_LIMIT) });
}

async function clearHistory() {
  await browser.storage.local.set({ history: [] });
}

// ---------------------------------------------------------------- examined

async function examinedIds() {
  const data = await browser.storage.local.get("examined");
  const cutoff = Date.now() - EXAMINED_TTL_MS;
  return (Array.isArray(data.examined) ? data.examined : []).filter((entry) => entry.t > cutoff);
}

async function markExamined(ids) {
  if (!ids.length) return;
  const previous = await examinedIds();
  const known = new Set(previous.map((entry) => entry.id));
  const now = Date.now();
  const added = ids.filter((id) => !known.has(id)).map((id) => ({ id, t: now }));
  await browser.storage.local.set({ examined: added.concat(previous).slice(0, EXAMINED_LIMIT) });
}

// ------------------------------------------------------------------- query

function buildQuery(lookbackHours) {
  const since = Math.floor((Date.now() - lookbackHours * 3600_000) / 1000);
  const terms = ["in:anywhere", `after:${since}`, "-in:spam", "-in:trash"];
  if (!settings.includeAllCategories) terms.push("-category:promotions", "-category:social");
  if (settings.senderFilter) terms.push(settings.senderFilter);
  return terms.join(" ");
}

function detectionOptions() {
  return {
    allowedLengths: settings.allowedLengths,
    allowAlphanumeric: settings.allowAlphanumeric,
    minScore: settings.minScore
  };
}

// ---------------------------------------------------------------- delivery

function notificationClock(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (e) {
    return "";
  }
}

async function notify(entry) {
  if (!settings.notify) return;
  const sender = String(entry.from || "Gmail").replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
  const at = notificationClock(entry.receivedAt || entry.at);
  try {
    await browser.notifications.create("otp-" + entry.at, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon-96.png"),
      title: `Code: ${entry.code}`,
      message: `${sender}${at ? " · received " + at : ""} — copied to your clipboard`,
      priority: 2
    });
  } catch (e) {
    /* notifications are a convenience, never a requirement */
  }
}

async function deliver(candidate, meta, force) {
  const previous = await getLastCode();
  const isNew = !previous || previous.code !== candidate.code || previous.messageId !== meta.messageId;

  const entry = {
    code: candidate.code,
    at: Date.now(), // when the extension captured it (used for freshness/autofill)
    receivedAt: meta.receivedAt || Date.now(), // when the message reached Gmail
    from: meta.from,
    subject: meta.subject,
    messageId: meta.messageId,
    score: candidate.score,
    copied: false
  };

  if (settings.autoCopy && (isNew || force)) {
    entry.copied = await copyToClipboard(entry.code);
    clipboardBlocked = !entry.copied;
  }

  await browser.storage.local.set({ lastCode: entry });
  await pushHistory(entry);
  await setStatus({ lastCodeAt: entry.at });
  if (entry.copied) await notify(entry);

  return entry;
}

// -------------------------------------------------------------------- poll

async function poll(options) {
  const opts = options || {};
  if (polling) return { skipped: "already-running" };

  settings = settings || (await Settings.get());

  if (!(await Gmail.connected())) {
    await setStatus({ connected: false });
    return { skipped: "not-connected" };
  }

  polling = true;
  await setStatus({ polling: true, connected: true, lastError: "" });

  try {
    const ids = await Gmail.search({
      query: buildQuery(settings.lookbackHours),
      maxResults: MAX_MESSAGES_PER_POLL
    });

    let known = null;
    if (!opts.ignoreExamined) {
      known = new Set((await examinedIds()).map((entry) => entry.id));
    }
    const targets = known ? ids.filter((id) => !known.has(id)) : ids.slice();

    const findings = [];
    for (const id of targets) {
      let message;
      try {
        message = await Gmail.getMessage(id);
      } catch (e) {
        continue; // one unreadable message must not abort the poll
      }
      const parsed = Gmail.messageText(message);
      const candidate = OTP.best(parsed.text, detectionOptions());
      if (candidate) {
        findings.push({
          candidate,
          meta: {
            messageId: message.id,
            from: parsed.from,
            subject: parsed.subject,
            receivedAt: parsed.receivedAt
          }
        });
      }
    }

    // Gmail lists the newest message first, so the first hit is the freshest code.
    const winner = findings.length ? findings[0] : null;

    await markExamined(ids);

    const entry = winner ? await deliver(winner.candidate, winner.meta, Boolean(opts.force)) : null;

    await setStatus({ lastPollAt: Date.now(), lastError: "" });
    return { delivered: entry ? entry.code : null, examined: targets.length, found: findings.length };
  } catch (err) {
    const message = String((err && err.message) || err);
    // A single rejected request must not flip the whole extension to
    // "disconnected" — the refresh token may still be perfectly valid. Trust
    // the token store, not the error text.
    const stillConnected = await Gmail.connected();
    await setStatus({ lastError: message, connected: stillConnected });
    return { error: message };
  } finally {
    polling = false;
    await setStatus({ polling: false });
  }
}

// ------------------------------------------------------------------ alarms

async function ensureAlarm() {
  const period = settings.pollMinutes;
  await browser.alarms.clear(LEGACY_POLL_ALARM); // drop the pre-rename alarm, if any
  const existing = await browser.alarms.get(POLL_ALARM);
  if (existing && Math.abs(existing.periodInMinutes - period) < 0.01) return;
  await browser.alarms.clear(POLL_ALARM);
  await browser.alarms.create(POLL_ALARM, { periodInMinutes: period, delayInMinutes: 0.2 });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  poll({}).catch(() => {});
  // The event page may have been unloaded while standby was running; restart
  // its fast timer if it is still meant to be active.
  resumeStandbyIfActive();
});

// ----------------------------------------------------------------- standby
//
// "Standby" is a temporary boost the user switches on while they are waiting
// for a code: the extension polls every few seconds instead of once a minute,
// then turns itself off after the configured duration.

async function standbyState() {
  const stored = await browser.storage.local.get("standby");
  const until = stored.standby && Number(stored.standby.until);
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return { until };
}

function clearStandbyTimer() {
  if (standbyTimer) {
    clearTimeout(standbyTimer);
    standbyTimer = null;
  }
}

async function startStandby(minutes) {
  settings = settings || (await Settings.get());
  const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : settings.standbyMinutes;
  const until = Date.now() + Math.round(mins * 60_000);
  await browser.storage.local.set({ standby: { until } });
  await setStatus({ standbyUntil: until });
  await scheduleStandby();
  poll({}).catch(() => {});
  return { ok: true, until };
}

async function stopStandby() {
  clearStandbyTimer();
  await browser.storage.local.remove("standby");
  await setStatus({ standbyUntil: 0 });
  return { ok: true };
}

async function scheduleStandby() {
  clearStandbyTimer();
  const state = await standbyState();
  if (!state) {
    await stopStandby();
    return;
  }
  const interval = Math.max(5, settings.standbySeconds) * 1000;
  const delay = Math.min(interval, Math.max(250, state.until - Date.now()));
  standbyTimer = setTimeout(async () => {
    standbyTimer = null;
    if (!(await standbyState())) {
      await stopStandby();
      return;
    }
    await poll({}).catch(() => {});
    await scheduleStandby();
  }, delay);
}

async function resumeStandbyIfActive() {
  settings = settings || (await Settings.get());
  const state = await standbyState();
  if (state) {
    await setStatus({ standbyUntil: state.until });
    await scheduleStandby();
  } else if (standbyTimer) {
    clearStandbyTimer();
    await setStatus({ standbyUntil: 0 });
  }
}

// ----------------------------------------------------------------- connect

/** The redirect URI to use for a given mode. */
function redirectUriFor(mode) {
  if (mode === "extension") return Gmail.extensionRedirectUri();
  if (mode === "manual") return MANUAL_REDIRECT;
  return Gmail.loopbackRedirectUri(); // "auto"
}

/** Builds an auth URL for the given redirect, opening Google in a new tab. */
async function startManualFlow() {
  const pkce = await Gmail.createPkce();
  const state = Gmail.randomString(24);
  const redirectUri = MANUAL_REDIRECT;
  const authUrl = Gmail.buildAuthUrl({
    clientId: settings.clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state
  });

  pendingAuth = { pkce, redirectUri, state };
  await openManualAuth(authUrl);
  return { ok: true, pending: true };
}

async function connect() {
  settings = settings || (await Settings.get());

  if (!settings.clientId) {
    await setStatus({ authState: "error", message: "Add your Google OAuth Client ID in Options first." });
    return { ok: false, error: "missing-client-id" };
  }
  if (settings.pastedRefreshToken) {
    return connectWithRefreshToken(settings.pastedRefreshToken);
  }
  if (settings.redirectMode === "manual") {
    return startManualFlow();
  }

  // Automatic flow: launchWebAuthFlow captures the redirect for us, so there is
  // nothing to copy. "auto" uses the loopback redirect (works with a Desktop
  // app client and no domain verification); "extension" uses the published
  // *.extensions.allizom.org redirect.
  const pkce = await Gmail.createPkce();
  const state = Gmail.randomString(24);
  const redirectUri = redirectUriFor(settings.redirectMode);
  const authUrl = Gmail.buildAuthUrl({
    clientId: settings.clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state
  });

  pendingAuth = { pkce, redirectUri, state };
  await setStatus({ authState: "starting", message: "Opening Google's sign-in page…" });

  try {
    const result = await withTimeout(browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true }), 300_000);
    const code = Gmail.codeFromRedirect(result, state);
    await Gmail.exchangeCode({ code, codeVerifier: pkce.verifier, redirectUri });
    return await finishConnect();
  } catch (err) {
    if (settings.redirectMode === "extension") {
      pendingAuth = null;
      await setStatus({
        authState: "error",
        message:
          "The browser redirect did not come back. Unless this build is published on addons.mozilla.org, switch the redirect mode to “Automatic (loopback)” or “Manual paste” in Options."
      });
      return { ok: false, error: String((err && err.message) || err) };
    }
    // "auto": the loopback flow failed, so fall back to pasting the code back.
    return startManualFlow();
  }
}

async function openManualAuth(authUrl) {
  await browser.tabs.create({ url: authUrl });
  await setStatus({
    authState: "awaiting-code",
    message: "Approve access, then paste the code (or the whole redirect URL) below."
  });
}

async function submitAuthorizationCode(value) {
  if (!pendingAuth) {
    await setStatus({ authState: "error", message: "Start the connection again." });
    return { ok: false, error: "no-pending-auth" };
  }
  const input = String(value || "").trim();
  if (!input) return { ok: false, error: "empty" };

  try {
    const looksLikeUrl = /^[^\s?#]+(\?|#)/.test(input) || input.includes("=");
    const code = looksLikeUrl ? Gmail.codeFromRedirect(input, pendingAuth.state) : input;
    await Gmail.exchangeCode({
      code,
      codeVerifier: pendingAuth.pkce.verifier,
      redirectUri: pendingAuth.redirectUri
    });
    pendingAuth = null;
    return await finishConnect();
  } catch (err) {
    const message = String((err && err.message) || err);
    await setStatus({ authState: "awaiting-code", message });
    return { ok: false, error: message };
  }
}

async function connectWithRefreshToken(token) {
  try {
    await setStatus({ authState: "starting", message: "Exchanging your refresh token…" });
    await Gmail.useRefreshToken(token.trim());
    return await finishConnect();
  } catch (err) {
    const message = String((err && err.message) || err);
    await setStatus({ authState: "error", message: "That refresh token was rejected: " + message });
    return { ok: false, error: message };
  }
}

async function finishConnect() {
  try {
    const profile = await Gmail.getProfile();
    await setStatus({ connected: true, email: profile.emailAddress || null, authState: "connected", message: "", lastError: "" });
    poll({}).catch(() => {}); // prove it works straight away
    return { ok: true, email: profile.emailAddress };
  } catch (err) {
    const message = String((err && err.message) || err);
    // The tokens are already in hand, so a failed profile lookup means
    // "connected but the API hiccuped", not "disconnected".
    if (await Gmail.connected()) {
      await setStatus({ connected: true, authState: "connected", message: "", lastError: message });
      poll({}).catch(() => {});
      return { ok: true };
    }
    await setStatus({ connected: false, authState: "error", message: "Connected, but Gmail rejected the API call: " + message });
    return { ok: false, error: message };
  }
}

async function disconnect() {
  await Gmail.revoke();
  pendingAuth = null;
  await browser.storage.local.remove(["lastCode", "examined"]);
  await clearHistory();
  // Forget a pasted token too, or init() would silently reconnect on restart.
  await saveSettings({ pastedRefreshToken: "" });
  await setStatus({ connected: false, email: null, authState: "idle", message: "", lastError: "" });
  return { ok: true };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the sign-in redirect.")), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ---------------------------------------------------------------- messages

async function getState() {
  const stored = await browser.storage.local.get(["status", "lastCode", "history", "settings"]);
  const status = Object.assign({}, STATUS_DEFAULTS, stored.status || {});
  const standby = await standbyState();
  status.standbyUntil = standby ? standby.until : 0; // never report a stale standby
  return {
    status,
    lastCode: stored.lastCode || null,
    history: Array.isArray(stored.history) ? stored.history : [],
    settings: stored.settings || settings || (await Settings.get())
  };
}

async function copyCode(code) {
  if (code === undefined || code === null) return { ok: false };
  // An empty string is the "clear the clipboard" action, so it must go through.
  clipboardBlocked = !(await copyToClipboard(String(code)));
  await setStatus({});
  return { ok: !clipboardBlocked };
}

async function saveSettings(patch) {
  settings = await Settings.set(patch);
  await ensureAlarm();
  if (await standbyState()) await scheduleStandby();
  return { ok: true, settings };
}

async function handleMessage(message) {
  switch (message && message.type) {
    case "getState":
      return getState();
    case "connect":
      return connect();
    case "submitCode":
      return submitAuthorizationCode(message.value);
    case "cancelConnect":
      pendingAuth = null;
      await setStatus({ authState: "idle", message: "" });
      return { ok: true };
    case "disconnect":
      return disconnect();
    case "pollNow":
      return poll({});
    case "scanNow":
      return poll({ ignoreExamined: true, force: true });
    case "startStandby":
      return startStandby(message.minutes);
    case "stopStandby":
      return stopStandby();
    case "copyCode":
      return copyCode(message.code);
    case "clearClipboard":
      return copyCode("");
    case "clearHistory":
      await clearHistory();
      return { ok: true };
    case "saveSettings":
      return saveSettings(message.patch);
    default:
      return { ok: false, error: "unknown message" };
  }
}

browser.runtime.onMessage.addListener((message) =>
  handleMessage(message).catch((err) => {
    const error = String((err && err.message) || err);
    setStatus({ lastError: error }).catch(() => {});
    return { ok: false, error };
  })
);

// --------------------------------------------------------------- lifecycle

async function init() {
  settings = await Settings.get();
  await ensureAlarm();
  await resumeStandbyIfActive();

  const connected = await Gmail.connected();
  await setStatus({ connected });

  if (connected) {
    Gmail.getProfile()
      .then((profile) => setStatus({ email: profile.emailAddress || null, authState: "connected" }))
      .catch((err) => setStatus({ lastError: String((err && err.message) || err) }));
    poll({}).catch(() => {});
  } else if (settings.pastedRefreshToken) {
    connectWithRefreshToken(settings.pastedRefreshToken);
  }
}

browser.runtime.onInstalled.addListener(() => {
  init();
});
browser.runtime.onStartup.addListener(() => {
  init();
});

init();

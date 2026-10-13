"use strict";

/**
 * Validated settings store shared by the background page, the popup and the
 * options page.
 *
 * Everything that leaves this module is guaranteed to be typed and clamped, so
 * the rest of the extension never has to re-check a value that came out of
 * storage (which the user can edit by hand from about:debugging).
 */
(function (global) {
  const DEFAULTS = Object.freeze({
    // Gmail connection
    clientId: "",
    clientSecret: "", // Google requires this on the token exchange, even with PKCE
    redirectMode: "auto", // "auto" | "extension" | "manual"
    pastedRefreshToken: "",

    // Polling
    pollMinutes: 1, // normal cadence, in minutes
    standbySeconds: 20, // faster cadence while standby mode is on
    standbyMinutes: 10, // how long standby mode lasts before it turns itself off
    lookbackHours: 24,
    senderFilter: "",
    includeAllCategories: false,

    // Detection
    allowedLengths: Object.freeze([4, 5, 6, 7, 8]),
    allowAlphanumeric: false,
    minScore: 30,

    // Behaviour
    autoCopy: true,
    notify: true,
    autoFill: false
  });

  const BOOLEAN_KEYS = ["includeAllCategories", "allowAlphanumeric", "autoCopy", "notify", "autoFill"];
  const TEXT_KEYS = ["clientId", "clientSecret", "redirectMode", "pastedRefreshToken", "senderFilter"];
  const NUMBER_KEYS = {
    pollMinutes: [0.5, 60],
    standbySeconds: [5, 600],
    standbyMinutes: [1, 240],
    lookbackHours: [1, 336],
    minScore: [0, 100]
  };
  const REDIRECT_MODES = ["auto", "extension", "manual"];
  const MIN_CODE_LENGTH = 4;
  const MAX_CODE_LENGTH = 10;

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function cleanLengths(value) {
    const lengths = (Array.isArray(value) ? value : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= MIN_CODE_LENGTH && n <= MAX_CODE_LENGTH);
    if (!lengths.length) return DEFAULTS.allowedLengths.slice();
    return Array.from(new Set(lengths)).sort((a, b) => a - b);
  }

  /** Coerces anything into a complete, valid settings object. */
  function normalize(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const out = Object.assign({}, DEFAULTS);

    for (const key of BOOLEAN_KEYS) out[key] = source[key] === true;

    for (const key of TEXT_KEYS) {
      out[key] = typeof source[key] === "string" ? source[key].trim() : "";
    }

    for (const [key, [low, high]] of Object.entries(NUMBER_KEYS)) {
      const n = Number(source[key]);
      out[key] = Number.isFinite(n) ? clamp(n, low, high) : DEFAULTS[key];
    }

    if (!REDIRECT_MODES.includes(out.redirectMode)) out.redirectMode = DEFAULTS.redirectMode;

    out.allowedLengths = cleanLengths(source.allowedLengths);

    // The sender filter is interpolated into a Gmail search query.
    out.senderFilter = out.senderFilter.replace(/["{}]/g, "");

    return out;
  }

  let cached = null;

  async function get() {
    if (!cached) {
      const stored = await browser.storage.local.get("settings");
      cached = normalize(stored.settings);
    }
    return cached;
  }

  async function set(patch) {
    const next = normalize(Object.assign({}, await get(), patch || {}));
    cached = next;
    await browser.storage.local.set({ settings: next });
    return next;
  }

  function invalidate() {
    cached = null;
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) invalidate();
  });

  global.Settings = { DEFAULTS, normalize, get, set, invalidate };
})(typeof globalThis !== "undefined" ? globalThis : self);

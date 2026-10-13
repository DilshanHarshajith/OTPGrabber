"use strict";

/**
 * Optional convenience: put the newest captured code into a one-time-code
 * field. Dormant unless the user enables auto-fill AND grants site access, so
 * in the default configuration this script does nothing at all.
 */
(function () {
  const CODE_MAX_AGE_MS = 5 * 60_000;
  const AUTOFILL_WINDOW_MS = 90_000;
  const IDLE_RESCAN_MS = 500;

  // Field hints that mean "one-time code". Deliberately narrow: filling the
  // wrong box (a discount code, a search box) is worse than not filling one.
  const NAME_HINT_RE =
    /(one[\s_-]?time|otp|otc|2fa|two[\s_-]?factor|mfa|auth\w*[\s_-]?code|security[\s_-]?code|verification[\s_-]?code|verify[\s_-]?code|confirmation?[\s_-]?code|login[\s_-]?code|access[\s_-]?code|passcode|pass[\s_-]?code|sms[\s_-]?code|backup[\s_-]?code|recovery[\s_-]?code|licen[cs]e[\s_-]?key|token)/i;
  const BARE_NAME_RE = /^(code|otp|pin|passcode|token|securitycode|verificationcode|confirmcode|authcode|logincode)$/i;
  const NEVER_AUTOCOMPLETE = ["email", "username", "current-password", "new-password", "cc-number", "tel-national"];
  const SKIP_TYPES = ["checkbox", "radio", "file", "submit", "button", "reset", "range", "color", "date", "search", "hidden"];

  let enabled = false;
  let lastCode = null;
  let lastScanAt = 0;

  function isOneTimeField(element) {
    if (!element || element.tagName !== "INPUT" || !("value" in element)) return false;
    if (element.disabled || element.readOnly) return false;

    const type = String(element.type || "text").toLowerCase();
    if (SKIP_TYPES.includes(type) || type === "number" || type === "password") return false;

    const autocomplete = String(element.getAttribute("autocomplete") || "").toLowerCase();
    if (autocomplete === "one-time-code") return true;
    if (NEVER_AUTOCOMPLETE.includes(autocomplete)) return false;

    const maxLength = parseInt(element.getAttribute("maxlength") || "", 10);
    if (Number.isFinite(maxLength) && maxLength > 12) return false;

    const hint = [element.id, element.name, element.getAttribute("aria-label"), element.placeholder, element.title]
      .filter(Boolean)
      .join(" ");
    if (!hint) return false;
    if (NAME_HINT_RE.test(hint)) return true;
    return BARE_NAME_RE.test(hint.trim()) && (maxLength <= 8 || type === "tel" || type === "text");
  }

  /** Bypasses framework value trackers (React and friends). */
  function setNativeValue(element, value) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function tryFill(element) {
    if (!enabled || !lastCode) return false;
    if (element.value) return false;
    if (element.dataset.otpGrabberFilled === lastCode.code) return false;
    if (element.getAttribute("autocomplete") === "off" && element.dataset.otpGrabberTouched === "1") return false;

    setNativeValue(element, lastCode.code);
    element.dataset.otpGrabberFilled = lastCode.code;
    element.title = "Filled by OTPGrabber";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function loadState() {
    const data = await browser.storage.local.get(["lastCode", "settings"]);
    enabled = Boolean(data.settings && data.settings.autoFill);

    const entry = data.lastCode;
    const fresh = entry && entry.code && Date.now() - entry.at <= CODE_MAX_AGE_MS;
    lastCode = fresh ? entry : null;
  }

  function isFreshEnough() {
    return Boolean(enabled && lastCode && Date.now() - lastCode.at <= AUTOFILL_WINDOW_MS);
  }

  function onFocusIn(event) {
    const element = event.target;
    if (!isOneTimeField(element) || !isFreshEnough()) return;
    tryFill(element);
  }

  function scan(root) {
    if (!isFreshEnough()) return;
    const elements = root.querySelectorAll ? root.querySelectorAll("input") : [];
    for (const element of elements) {
      if (!element.value && isOneTimeField(element) && tryFill(element)) return;
    }
  }

  function boot() {
    loadState().then(() => scan(document));

    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener(
      "input",
      (event) => {
        if (event.target && event.target.dataset) event.target.dataset.otpGrabberTouched = "1";
      },
      true
    );

    // Single-page apps mount their forms late and often after a redirect.
    const observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastScanAt < IDLE_RESCAN_MS) return;
      lastScanAt = now;
      loadState().then(() => scan(document));
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.lastCode || changes.settings)) loadState();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();

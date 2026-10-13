"use strict";

/** Toolbar popup: connection state, the last code, and a short history. */

const $ = (id) => document.getElementById(id);
const send = (message) => browser.runtime.sendMessage(message);

const DEFAULT_STATUS = { connected: false, authState: "idle", clipboardBlocked: false };
let view = { status: DEFAULT_STATUS, lastCode: null, history: [], settings: null };

function plural(value, unit) {
  const rounded = Math.round(value);
  return rounded === 1 ? `1 ${unit}` : `${rounded} ${unit}s`;
}

function timeAgo(timestamp) {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return plural(seconds / 60, "min") + " ago";
  if (seconds < 86400) return plural(seconds / 3600, "hour") + " ago";
  return plural(seconds / 86400, "day") + " ago";
}

/** Absolute clock time plus a relative hint, e.g. "14:32:07 · 3 mins ago". */
function timestamp(timestamp) {
  if (!timestamp) return "";
  const at = new Date(timestamp);
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  const clock = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const label = sameDay
    ? clock
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + clock;
  return label + " · " + timeAgo(timestamp);
}

function fullTimestamp(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : "";
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function senderName(from) {
  return String(from || "").replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
}

function setError(message) {
  const box = $("error");
  box.textContent = message || "";
  box.hidden = !message;
}

function setDot(status) {
  const state = status.polling ? "busy" : status.connected ? "on" : "off";
  $("dot").className = "dot " + state;
}

function renderHistory(history) {
  const list = $("history");
  list.textContent = "";
  for (const entry of history) {
    const row = document.createElement("li");

    const code = document.createElement("span");
    code.className = "hc";
    code.textContent = entry.code;

    const meta = document.createElement("span");
    meta.className = "hm";
    const who = senderName(entry.from);
    meta.textContent = timestamp(entry.receivedAt || entry.at) + (who ? " · " + who : "");
    meta.title = [fullTimestamp(entry.receivedAt || entry.at), entry.subject || who].filter(Boolean).join("\n");

    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      const result = await send({ type: "copyCode", code: entry.code });
      copy.textContent = result && result.ok ? "Copied" : "Failed";
      setTimeout(() => {
        copy.textContent = "Copy";
      }, 1200);
    });

    row.append(code, meta, copy);
    list.append(row);
  }
}

function render() {
  const status = view.status || DEFAULT_STATUS;
  const authState = status.authState || "idle";
  const connected = Boolean(status.connected);

  $("disconnected").hidden = connected || authState === "awaiting-code" || authState === "starting";
  $("awaiting").hidden = authState !== "awaiting-code";
  $("connected").hidden = !connected;

  setDot(status);

  if ($("awaiting").hidden === false) {
    $("awaitingText").textContent = status.message || "Approve access in the Google tab, then paste the code here.";
  }

  if (connected) {
    const last = view.lastCode;
    $("account").textContent = status.email ? "Watching " + status.email : "Watching Gmail";
    $("code").textContent = last ? last.code : "—";
    $("code").classList.toggle("stale", !last);
    $("codeMeta").textContent = last
      ? [
          last.copied ? "Copied" : "Not copied",
          "Received " + timestamp(last.receivedAt || last.at),
          last.from ? senderName(last.from) : ""
        ]
          .filter(Boolean)
          .join(" · ")
      : "No code captured yet";
    $("codeMeta").title = last
      ? [fullTimestamp(last.receivedAt || last.at), last.subject || ""].filter(Boolean).join("\n")
      : "";
    $("copyLast").disabled = !last;
    $("clipboardWarn").hidden = !(status.clipboardBlocked && last);
    $("autoCopy").checked = Boolean(view.settings && view.settings.autoCopy);
    $("notify").checked = Boolean(view.settings && view.settings.notify);
    renderHistory(view.history || []);

    const standbyUntil = Number(status.standbyUntil) || 0;
    const standbyActive = standbyUntil > Date.now();
    $("standby").hidden = standbyActive;
    $("stopStandby").hidden = !standbyActive;
    $("standbyStatus").hidden = !standbyActive;
    $("standbyStatus").textContent = standbyActive
      ? "Standby: every " + (view.settings ? view.settings.standbySeconds : "?") + "s · " +
        formatRemaining(standbyUntil - Date.now()) + " left"
      : "";
  }

  setError(status.lastError || "");

  const parts = [status.lastPollAt ? "Checked " + timeAgo(status.lastPollAt) : "Waiting for the first check"];
  if (view.settings) parts.push("every " + view.settings.pollMinutes + " min", "last " + view.settings.lookbackHours + " h");
  $("statusLine").textContent = parts.join(" · ");
}

async function refresh() {
  const state = await send({ type: "getState" });
  view = {
    status: Object.assign({}, DEFAULT_STATUS, state.status || {}),
    lastCode: state.lastCode || null,
    history: state.history || [],
    settings: state.settings || null
  };
  if (view.settings && !$("clientId").value) $("clientId").value = view.settings.clientId;
  if (view.settings && !$("clientSecret").value) $("clientSecret").value = view.settings.clientSecret;
  render();
}

/** Runs a message that starts server-side work, with a busy label on the button. */
async function run(button, message, busyLabel) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  setError("");
  const result = await send(message);
  button.disabled = false;
  button.textContent = label;
  await refresh();
  if (result && result.error) {
    setError(result.error);
  } else if (message.type === "scanNow" && result && !result.delivered) {
    setError("No one-time code found in the last " + (view.settings ? view.settings.lookbackHours : 24) + " hours.");
  }
  return result;
}

function flashLabel(button, text, original) {
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// ---- wiring --------------------------------------------------------------

$("openOptions").addEventListener("click", () => browser.runtime.openOptionsPage());
$("openOptions2").addEventListener("click", () => browser.runtime.openOptionsPage());

$("connect").addEventListener("click", async () => {
  const clientId = $("clientId").value.trim();
  const clientSecret = $("clientSecret").value.trim();
  setError("");
  if (clientId || clientSecret) await send({ type: "saveSettings", patch: { clientId, clientSecret } });
  $("connect").disabled = true;
  const result = await send({ type: "connect" });
  $("connect").disabled = false;
  if (result && result.error && result.error !== "missing-client-id") setError(result.error);
  refresh();
});

$("submitCode").addEventListener("click", async () => {
  setError("");
  const result = await send({ type: "submitCode", value: $("manualCode").value });
  if (result && !result.ok) setError(result.error || "Could not finish the connection.");
  else $("manualCode").value = "";
  refresh();
});

$("manualCode").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("submitCode").click();
});

$("cancelConnect").addEventListener("click", async () => {
  await send({ type: "cancelConnect" });
  refresh();
});

$("copyLast").addEventListener("click", async () => {
  if (!view.lastCode) return;
  const result = await send({ type: "copyCode", code: view.lastCode.code });
  flashLabel($("copyLast"), result && result.ok ? "Copied" : "Copy failed", "Copy to clipboard");
});

$("pollNow").addEventListener("click", (event) => run(event.target, { type: "pollNow" }, "Checking…"));
$("scanNow").addEventListener("click", (event) => run(event.target, { type: "scanNow" }, "Scanning…"));

$("standby").addEventListener("click", async () => {
  await send({ type: "startStandby" });
  refresh();
});

$("stopStandby").addEventListener("click", async () => {
  await send({ type: "stopStandby" });
  refresh();
});

$("autoCopy").addEventListener("change", (event) => send({ type: "saveSettings", patch: { autoCopy: event.target.checked } }));
$("notify").addEventListener("change", (event) => send({ type: "saveSettings", patch: { notify: event.target.checked } }));

$("clearHistory").addEventListener("click", async () => {
  await send({ type: "clearHistory" });
  refresh();
});

$("disconnect").addEventListener("click", async () => {
  await send({ type: "disconnect" });
  refresh();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.status || changes.lastCode || changes.history || changes.settings) refresh();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
window.addEventListener("focus", refresh);

setInterval(() => {
  if (!$("connected").hidden) render();
}, 1000);

refresh();

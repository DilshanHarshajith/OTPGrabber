"use strict";

/** Options page: Google credentials, polling, detection and behaviour. */

const $ = (id) => document.getElementById(id);
const send = (message) => browser.runtime.sendMessage(message);

const LENGTH_CHOICES = [4, 5, 6, 7, 8, 9, 10];
const REDIRECT_NOTES = {
  auto: "Fully automatic: the browser closes Google's window and hands the code straight back to the extension. Uses the loopback redirect below — Google accepts it on a Desktop app client with no domain verification. Falls back to manual paste only if Google cannot reach the loopback.",
  extension: "Uses the published *.extensions.allizom.org redirect. Only works if Google has approved that domain for your OAuth client (it normally cannot be verified), so this is for published builds with prior Google approval.",
  manual: "Sign-in opens in a normal tab; after approving access you paste the code (or the redirect URL) back into the popup. Kept as a last-resort fallback."
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildLengthChoices() {
  const box = $("lengths");
  box.textContent = "";
  for (const length of LENGTH_CHOICES) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(length);
    input.addEventListener("change", scheduleSave);

    const text = document.createElement("span");
    text.textContent = length + " digits";

    label.append(input, text);
    box.append(label);
  }
}

function chosenLengths() {
  const picked = Array.from($("lengths").querySelectorAll("input:checked")).map((input) => Number(input.value));
  return picked.length ? picked : [4, 5, 6, 7, 8];
}

function render(settings) {
  $("clientId").value = settings.clientId;
  $("clientSecret").value = settings.clientSecret;
  $("redirectMode").value = settings.redirectMode;
  $("pastedRefreshToken").value = settings.pastedRefreshToken;
  $("pollMinutes").value = settings.pollMinutes;
  $("standbySeconds").value = settings.standbySeconds;
  $("standbyMinutes").value = settings.standbyMinutes;
  $("lookbackHours").value = settings.lookbackHours;
  $("senderFilter").value = settings.senderFilter;
  $("includeAllCategories").checked = settings.includeAllCategories;
  $("allowAlphanumeric").checked = settings.allowAlphanumeric;
  $("minScore").value = settings.minScore;
  $("minScoreOut").textContent = String(settings.minScore);
  $("autoCopy").checked = settings.autoCopy;
  $("notify").checked = settings.notify;
  $("autoFill").checked = settings.autoFill;
  for (const input of $("lengths").querySelectorAll("input")) {
    input.checked = settings.allowedLengths.includes(Number(input.value));
  }
  $("redirectNote").textContent = REDIRECT_NOTES[$("redirectMode").value] || "";
}

function collect() {
  return {
    clientId: $("clientId").value,
    clientSecret: $("clientSecret").value,
    redirectMode: $("redirectMode").value,
    pastedRefreshToken: $("pastedRefreshToken").value,
    pollMinutes: Number($("pollMinutes").value),
    standbySeconds: Number($("standbySeconds").value),
    standbyMinutes: Number($("standbyMinutes").value),
    lookbackHours: Number($("lookbackHours").value),
    senderFilter: $("senderFilter").value,
    includeAllCategories: $("includeAllCategories").checked,
    allowAlphanumeric: $("allowAlphanumeric").checked,
    minScore: Number($("minScore").value),
    allowedLengths: chosenLengths(),
    autoCopy: $("autoCopy").checked,
    notify: $("notify").checked,
    autoFill: $("autoFill").checked
  };
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await send({ type: "saveSettings", patch: collect() });
  }, 250);
}

async function renderStatus() {
  const state = await send({ type: "getState" });
  const status = state.status || {};
  const statusEl = $("status");
  statusEl.textContent = "";

  const addText = (value) => statusEl.append(document.createTextNode(value));
  const addSpan = (className, value) => {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = value;
    statusEl.append(span);
  };

  if (status.connected) {
    addSpan("ok", "Connected");
    if (status.email) addText(" as " + status.email);
  } else if (status.authState === "awaiting-code") {
    addSpan("bad", "Waiting for an authorization code");
  } else {
    addSpan("bad", "Not connected");
  }
  if (status.standbyUntil && status.standbyUntil > Date.now()) {
    addText(" · ");
    const strong = document.createElement("strong");
    strong.textContent = "standby";
    statusEl.append(strong);
    addText(" (" + formatRemaining(status.standbyUntil - Date.now()) + " left)");
  }
  if (status.lastPollAt) addText(" · last checked " + new Date(status.lastPollAt).toLocaleTimeString());
  if (status.lastError) addText(" · " + status.lastError);

  const standbyActive = Boolean(status.standbyUntil && status.standbyUntil > Date.now());
  $("stopStandbyOptions").disabled = !standbyActive;
  $("standbyNote").textContent = standbyActive
    ? "Standby is active — checking every " + (state.settings ? state.settings.standbySeconds : "?") + "s, " +
      formatRemaining(status.standbyUntil - Date.now()) + " left."
    : "Standby is off. Turn it on from the popup when you are expecting a code.";

  // Only repaint the form when the user is not interacting with it.
  if (state.settings && document.activeElement === document.body) render(state.settings);
  await renderSiteAccess(state.settings);
}

async function siteAccessGranted() {
  return browser.permissions.contains({ origins: ["<all_urls>"] });
}

async function renderSiteAccess(settings) {
  const granted = await siteAccessGranted();
  $("grantSites").disabled = granted;
  $("revokeSites").disabled = !granted;

  const wants = settings ? settings.autoFill : $("autoFill").checked;
  if (!granted) {
    $("autoFillNote").textContent =
      'Off by default. Turning it on asks for site access, then the newest code is dropped into any autocomplete="one-time-code" field you focus.';
  } else if (wants) {
    $("autoFillNote").textContent = "Site access granted — one-time-code fields you focus will be filled with the newest code.";
  } else {
    $("autoFillNote").textContent = "Site access is granted but auto-fill is switched off, so the content script does nothing.";
  }
}

// ---- wiring --------------------------------------------------------------

buildLengthChoices();

for (const id of [
  "clientId", "clientSecret", "redirectMode", "pastedRefreshToken", "pollMinutes", "standbySeconds",
  "standbyMinutes", "lookbackHours", "senderFilter", "includeAllCategories", "allowAlphanumeric",
  "autoCopy", "notify"
]) {
  $(id).addEventListener("change", scheduleSave);
  $(id).addEventListener("input", scheduleSave);
}

$("redirectMode").addEventListener("change", () => {
  $("redirectNote").textContent = REDIRECT_NOTES[$("redirectMode").value] || "";
});

$("minScore").addEventListener("input", () => {
  $("minScoreOut").textContent = $("minScore").value;
  scheduleSave();
});

$("connect").addEventListener("click", async () => {
  const box = $("connectStatus");
  box.textContent = "Opening Google sign-in…";
  $("connect").disabled = true;

  await send({ type: "saveSettings", patch: collect() });
  const result = await send({ type: "connect" });
  $("connect").disabled = false;

  if (result && result.ok && !result.pending) {
    box.textContent = "Connected as " + (result.email || "your account") + ".";
  } else if (result && result.pending) {
    box.textContent = "A sign-in tab is open. Approve access, then paste the code into the extension popup.";
  } else {
    box.textContent = (result && result.error) || "Could not start the connection.";
  }
  renderStatus();
});

$("disconnect").addEventListener("click", async () => {
  await send({ type: "disconnect" });
  $("connectStatus").textContent = "Disconnected.";
  renderStatus();
});

$("grantSites").addEventListener("click", async () => {
  const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
  if (granted) {
    await send({ type: "saveSettings", patch: { autoFill: true } });
    $("autoFill").checked = true;
  }
  renderSiteAccess({ autoFill: $("autoFill").checked });
});

$("revokeSites").addEventListener("click", async () => {
  await browser.permissions.remove({ origins: ["<all_urls>"] });
  await send({ type: "saveSettings", patch: { autoFill: false } });
  $("autoFill").checked = false;
  renderSiteAccess({ autoFill: false });
});

$("autoFill").addEventListener("change", async () => {
  if ($("autoFill").checked && !(await siteAccessGranted())) {
    const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
    if (!granted) $("autoFill").checked = false;
  }
  scheduleSave();
  renderSiteAccess({ autoFill: $("autoFill").checked });
});

$("clearHistory").addEventListener("click", () => send({ type: "clearHistory" }));
$("clearClipboard").addEventListener("click", () => send({ type: "clearClipboard" }));

$("stopStandbyOptions").addEventListener("click", async () => {
  await send({ type: "stopStandby" });
  renderStatus();
});

function formatRemaining(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

// ---- redirect URIs -------------------------------------------------------

function extensionRedirectUri() {
  try {
    return browser.identity.getRedirectURL();
  } catch (e) {
    return "";
  }
}

function loopbackRedirectUri() {
  try {
    const host = new URL(extensionRedirectUri()).hostname;
    return "http://127.0.0.1/mozoauth2/" + host.split(".")[0];
  } catch (e) {
    return "";
  }
}

async function copyField(input, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = "Copied";
  } catch (e) {
    input.select();
    document.execCommand("copy");
    button.textContent = "Copied";
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function renderRedirectUris() {
  $("loopbackRedirect").value = loopbackRedirectUri();
  $("extensionRedirect").value = extensionRedirectUri();
  $("copyLoopback").addEventListener("click", () => copyField($("loopbackRedirect"), $("copyLoopback")));
  $("copyExtension").addEventListener("click", () => copyField($("extensionRedirect"), $("copyExtension")));
  $("helpLoopbackRedirect").value = loopbackRedirectUri();
  $("helpCopyLoopback").addEventListener("click", () => copyField($("helpLoopbackRedirect"), $("helpCopyLoopback")));
}

// ---- tabs & help ---------------------------------------------------------

const TABS = ["settings", "help", "readme"];

function showTab(which) {
  for (const name of TABS) {
    const active = name === which;
    const suffix = name.charAt(0).toUpperCase() + name.slice(1);
    $("tab" + suffix).hidden = !active;
    $("tabBtn" + suffix).classList.toggle("active", active);
  }
}

/** Minimal Markdown for the bundled README (headings, lists, tables, code…). */
function inlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return out;
}

function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const splitRow = (line) =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      html.push("<pre><code>" + escapeHtml(buf.join("\n")) + "</code></pre>");
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
      i++;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      html.push(
        "<table><thead><tr>" +
          header.map((cell) => "<th>" + inlineMarkdown(cell) + "</th>").join("") +
          "</tr></thead><tbody>" +
          rows.map((row) => "<tr>" + row.map((cell) => "<td>" + inlineMarkdown(cell) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>"
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      html.push("<blockquote>" + inlineMarkdown(buf.join(" ")) + "</blockquote>");
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(inlineMarkdown(lines[i++].replace(/^\s*[-*]\s+/, "")));
      html.push("<ul>" + items.map((item) => "<li>" + item + "</li>").join("") + "</ul>");
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(inlineMarkdown(lines[i++].replace(/^\s*\d+\.\s+/, "")));
      html.push("<ol>" + items.map((item) => "<li>" + item + "</li>").join("") + "</ol>");
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const paragraph = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1]))
    ) {
      paragraph.push(lines[i++]);
    }
    html.push("<p>" + inlineMarkdown(paragraph.join(" ")) + "</p>");
  }

  return html.join("\n");
}

async function loadReadme() {
  const box = $("readme");
  try {
    const response = await fetch(browser.runtime.getURL("README.md"));
    if (!response.ok) throw new Error("HTTP " + response.status);
    // Parse the generated markup instead of assigning innerHTML, which the
    // add-on linter flags. The source is our own bundled, escaped README.
    const parsed = new DOMParser().parseFromString(renderMarkdown(await response.text()), "text/html");
    box.replaceChildren(...parsed.body.childNodes);
  } catch (err) {
    box.textContent = "Could not load README.md (" + String((err && err.message) || err) + ").";
  }
}

$("tabBtnSettings").addEventListener("click", () => showTab("settings"));
$("tabBtnHelp").addEventListener("click", () => showTab("help"));
$("tabBtnReadme").addEventListener("click", () => showTab("readme"));
$("helpToSettings").addEventListener("click", (event) => {
  event.preventDefault();
  showTab("settings");
  $("clientId").focus();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.status) renderStatus();
});

(async function init() {
  renderRedirectUris();
  loadReadme();
  const state = await send({ type: "getState" });
  if (state.settings) render(state.settings);
  await renderStatus();
  setInterval(renderStatus, 5000);
})();

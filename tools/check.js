"use strict";

/**
 * Project checks that need no browser and no dependencies.
 *
 * 1. every script parses (a light stand-in for a linter)
 * 2. every getElementById lookup in a page script has a matching id in its HTML
 * 3. every file the manifest references actually exists
 *
 * Run with `npm test`.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
let failures = 0;

function pass(message) {
  console.log("  ok   " + message);
}

function fail(message) {
  failures++;
  console.log("  FAIL " + message);
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function exists(relative) {
  return fs.existsSync(path.join(root, relative));
}

// 1. syntax ---------------------------------------------------------------

console.log("syntax");
const scripts = [
  "lib/settings.js",
  "lib/otp.js",
  "lib/gmail.js",
  "background.js",
  "popup/popup.js",
  "options/options.js",
  "content/autofill.js"
];
for (const script of scripts) {
  try {
    new vm.Script(read(script), { filename: script });
    pass(script);
  } catch (err) {
    fail(script + " — " + err.message);
  }
}

// 2. DOM ids --------------------------------------------------------------

console.log("HTML ids");
const pages = [
  { script: "popup/popup.js", html: "popup/popup.html" },
  { script: "options/options.js", html: "options/options.html" }
];
for (const page of pages) {
  const html = read(page.html);
  const ids = new Set(
    Array.from(html.matchAll(/id="([^"]+)"/g), (m) => m[1])
  );
  const used = new Set(
    Array.from(read(page.script).matchAll(/\$\("([^"]+)"\)/g), (m) => m[1])
  );
  const missing = [...used].filter((id) => !ids.has(id)).sort();
  if (missing.length) fail(`${page.script} references missing ids: ${missing.join(", ")}`);
  else pass(`${page.script} → ${used.size} ids all present in ${page.html}`);
}

// 3. manifest -------------------------------------------------------------

console.log("manifest");
let manifest;
try {
  manifest = JSON.parse(read("manifest.json"));
  pass("manifest.json parses");
} catch (err) {
  fail("manifest.json — " + err.message);
}

if (manifest) {
  const referenced = new Set();
  for (const script of manifest.background.scripts) referenced.add(script);
  referenced.add(manifest.action.default_popup);
  referenced.add(manifest.options_ui.page);
  for (const entry of manifest.content_scripts) {
    for (const script of entry.js) referenced.add(script);
  }
  for (const size of Object.values(manifest.icons)) referenced.add(size);
  for (const size of Object.values(manifest.action.default_icon)) referenced.add(size);

  const missing = [...referenced].filter((file) => !exists(file)).sort();
  if (missing.length) fail("manifest references missing files: " + missing.join(", "));
  else pass(`all ${referenced.size} manifest-referenced files exist`);

  const order = manifest.background.scripts;
  const expected = ["lib/settings.js", "lib/otp.js", "lib/gmail.js", "background.js"];
  if (JSON.stringify(order) !== JSON.stringify(expected)) {
    fail("background script order changed: " + order.join(", "));
  } else {
    pass("background scripts load in dependency order");
  }
}

console.log("");
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");

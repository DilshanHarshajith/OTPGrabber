"use strict";

/**
 * Gmail access: OAuth 2.0 (PKCE, no client secret), the token store, the REST
 * calls we need, and the MIME flattening that feeds the extractor.
 *
 * The refresh token lives in storage.local and never leaves the browser.
 */
(function (global) {
  const API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
  const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
  const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
  const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

  const SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "email",
    "profile"
  ];

  const TOKEN_KEY = "tokens";
  const MANUAL_REDIRECT = "http://localhost:8765/";
  const REFRESH_MARGIN_MS = 60_000;

  // Only ask for the payload fields we read; message bodies get large. Built
  // recursively so the nesting can never come out unbalanced.
  const LEAF_FIELDS = "headers,mimeType,filename,body(size,data)";
  function payloadFields(depth) {
    return depth <= 0 ? LEAF_FIELDS : LEAF_FIELDS + ",parts(" + payloadFields(depth - 1) + ")";
  }
  const MESSAGE_FIELDS = "id,threadId,internalDate,labelIds,snippet,payload(" + payloadFields(3) + ")";

  class HttpError extends Error {
    constructor(status, detail) {
      super(HttpError.messageFor(status, detail));
      this.name = "HttpError";
      this.status = status;
      this.detail = detail;
    }

    static messageFor(status, detail) {
      if (status === 401) return "Gmail rejected the access token. Reconnect the account from the popup.";
      if (status === 403) return "Gmail refused the request. The granted scopes may be missing — reconnect the account.";
      return `Gmail API error ${status}: ${detail}`;
    }
  }

  // ---- token store ------------------------------------------------------

  let tokenCache = null;
  let pendingRefresh = null;

  async function tokens() {
    if (!tokenCache) {
      const stored = await browser.storage.local.get(TOKEN_KEY);
      tokenCache = stored[TOKEN_KEY] || {};
    }
    return tokenCache;
  }

  async function saveTokens(patch) {
    tokenCache = Object.assign({}, tokenCache || {}, patch);
    await browser.storage.local.set({ [TOKEN_KEY]: tokenCache });
    return tokenCache;
  }

  async function clearTokens() {
    tokenCache = {};
    await browser.storage.local.remove(TOKEN_KEY);
  }

  async function connected() {
    const store = await tokens();
    return Boolean(store.refreshToken || store.accessToken);
  }

  // ---- pkce -------------------------------------------------------------

  function base64url(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }

  async function sha256Base64url(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return base64url(new Uint8Array(digest));
  }

  async function createPkce() {
    const verifier = randomString(64);
    return { verifier, challenge: await sha256Base64url(verifier), method: "S256" };
  }

  // ---- authorization ----------------------------------------------------

  function extensionRedirectUri() {
    try {
      return browser.identity.getRedirectURL();
    } catch (e) {
      return browser.runtime.getURL("/");
    }
  }

  /**
   * The loopback form of the extension's redirect URL:
   * `http://127.0.0.1/mozoauth2/<subdomain of getRedirectURL()>`.
   *
   * Firefox (86+) treats this as one of the extension's own redirect URLs, so
   * identity.launchWebAuthFlow() captures the result automatically — no server
   * and no copy/paste. Crucially, Google accepts loopback redirects on
   * "Desktop app" clients without needing to verify ownership of a domain,
   * which is impossible for the default `*.extensions.allizom.org` URL.
   */
  function loopbackRedirectUri() {
    try {
      const host = new URL(extensionRedirectUri()).hostname; // <sub>.extensions.allizom.org
      const sub = host.split(".")[0];
      return "http://127.0.0.1/mozoauth2/" + sub;
    } catch (e) {
      return MANUAL_REDIRECT;
    }
  }

  function buildAuthUrl(opts) {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", opts.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", opts.redirectUri);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("code_challenge", opts.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", opts.state);
    return url.toString();
  }

  /** Pulls the authorization code out of the final redirect URL. */
  function codeFromRedirect(redirectUrl, expectedState) {
    let parsed;
    try {
      parsed = new URL(redirectUrl);
    } catch (e) {
      throw new Error("That does not look like a redirect URL.");
    }
    if (expectedState && parsed.searchParams.get("state") !== expectedState) {
      throw new Error("State mismatch — that sign-in response did not match this request. Start the connection again.");
    }
    const error = parsed.searchParams.get("error");
    if (error) throw new Error(parsed.searchParams.get("error_description") || error);
    const code = parsed.searchParams.get("code");
    if (!code) throw new Error("No authorization code found in that URL.");
    return code;
  }

  async function postForm(url, params) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString()
    });
    const text = await response.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (e) {
      /* Google can answer with an HTML error page */
    }
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `HTTP ${response.status} from Google`);
    }
    return data;
  }

  async function storeTokenResponse(data, refreshToken) {
    const patch = {
      accessToken: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
      scope: data.scope || SCOPES.join(" "),
      obtainedAt: Date.now()
    };
    if (refreshToken) patch.refreshToken = refreshToken;
    else if (data.refresh_token) patch.refreshToken = data.refresh_token;
    return saveTokens(patch);
  }

  async function clientCredentials() {
    const settings = await Settings.get();
    return { clientId: settings.clientId, clientSecret: settings.clientSecret };
  }

  async function exchangeCode(opts) {
    const { clientId, clientSecret } = await clientCredentials();
    const params = {
      client_id: clientId,
      code: opts.code,
      code_verifier: opts.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: opts.redirectUri
    };
    // Google enforces client_secret on the token endpoint even for PKCE clients.
    if (clientSecret) params.client_secret = clientSecret;

    const data = await postForm(TOKEN_ENDPOINT, params);
    const store = await storeTokenResponse(data);
    if (!store.refreshToken) {
      throw new Error(
        "Google did not return a refresh token. Revoke the app at https://myaccount.google.com/permissions and try again."
      );
    }
    return store;
  }

  async function refresh(refreshToken) {
    const { clientId, clientSecret } = await clientCredentials();
    const params = {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    };
    if (clientSecret) params.client_secret = clientSecret;

    const data = await postForm(TOKEN_ENDPOINT, params);
    return storeTokenResponse(data, refreshToken);
  }

  async function useRefreshToken(refreshToken) {
    return refresh(refreshToken);
  }

  /** Returns a usable access token, refreshing first when it is about to die. */
  async function accessToken(force) {
    const store = await tokens();
    if (!force && store.accessToken && store.expiresAt && Date.now() < store.expiresAt - REFRESH_MARGIN_MS) {
      return store.accessToken;
    }
    if (!store.refreshToken) {
      if (store.accessToken) return store.accessToken;
      throw new Error("Not connected to Gmail yet.");
    }
    if (!pendingRefresh) {
      pendingRefresh = refresh(store.refreshToken).finally(() => {
        pendingRefresh = null;
      });
    }
    return (await pendingRefresh).accessToken;
  }

  // ---- rest -------------------------------------------------------------

  function requestUrl(path, params) {
    const url = new URL(API_ROOT + path);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
    return url;
  }

  async function api(path, params) {
    const url = requestUrl(path, params);
    const send = (token) => fetch(url, { headers: { Authorization: "Bearer " + token } });

    let response = await send(await accessToken());
    if (response.status === 401) {
      response = await send(await accessToken(true)); // one retry with a fresh token
    }
    if (!response.ok) {
      throw new HttpError(response.status, (await response.text()).slice(0, 300));
    }
    return response.json();
  }

  async function getProfile() {
    return api("", {});
  }

  async function search(opts) {
    const data = await api("/messages", {
      q: opts.query,
      maxResults: String(opts.maxResults || 25),
      includeSpamInThreads: "false"
    });
    return (data.messages || []).map((message) => message.id);
  }

  async function getMessage(id) {
    const path = "/messages/" + encodeURIComponent(id);
    try {
      return await api(path, { format: "full", fields: MESSAGE_FIELDS });
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        return api(path, { format: "full" }); // a field-selector rejection must not cost a poll
      }
      throw err;
    }
  }

  async function revoke() {
    const store = await tokens();
    const value = store.refreshToken || store.accessToken;
    await clearTokens();
    if (!value) return;
    try {
      await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: value }).toString()
      });
    } catch (e) {
      /* best effort — the local tokens are gone either way */
    }
  }

  // ---- mime -------------------------------------------------------------

  function decodeBase64Url(data) {
    if (!data) return "";
    try {
      const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      return atob(padded);
    } catch (e) {
      return "";
    }
  }

  function header(message, name) {
    const headers = (message && message.payload && message.payload.headers) || [];
    const found = headers.find((h) => String(h.name).toLowerCase() === name);
    return found ? found.value : "";
  }

  /**
   * When the message actually reached Gmail, in epoch milliseconds. Gmail's
   * `internalDate` is the authoritative arrival timestamp; the sender's `Date`
   * header is only a fallback (it can be spoofed or in a different clock).
   */
  function receivedAt(message) {
    const internal = Number(message && message.internalDate);
    if (Number.isFinite(internal) && internal > 0) return internal;
    const stamped = Date.parse(header(message, "date"));
    return Number.isFinite(stamped) ? stamped : Date.now();
  }

  function flatten(part, out) {
    if (!part) return out;
    out.push(part);
    for (const child of part.parts || []) flatten(child, out);
    return out;
  }

  function bodyText(parts, mimeType) {
    const part = parts.find((p) => p.mimeType === mimeType && !p.filename && p.body && p.body.data);
    return part ? decodeBase64Url(part.body.data) : "";
  }

  /**
   * Flattens a message into the text we scan. The subject is prepended because
   * "Your verification code" in the subject line is a strong signal.
   */
  function messageText(message) {
    const parts = flatten(message && message.payload, []);
    const plain = bodyText(parts, "text/plain");
    const html = bodyText(parts, "text/html");
    const snippet = message.snippet || "";

    // A long text/plain part is more reliable than the HTML rendering; short
    // ones are often just "View this email in your browser".
    const body = plain.trim().length > 40 ? plain : toText(html || plain || snippet);

    const subject = header(message, "subject");
    const from = header(message, "from");

    return {
      subject,
      from,
      date: header(message, "date"),
      receivedAt: receivedAt(message),
      snippet,
      attachments: parts.filter((p) => p.filename).map((p) => p.filename),
      text: subject ? subject + "\n" + body : body
    };
  }

  function toText(input) {
    return OTP.toText(input);
  }

  global.Gmail = {
    SCOPES,
    MANUAL_REDIRECT,
    HttpError,
    tokens,
    saveTokens,
    clearTokens,
    connected,
    randomString,
    createPkce,
    extensionRedirectUri,
    loopbackRedirectUri,
    buildAuthUrl,
    codeFromRedirect,
    exchangeCode,
    useRefreshToken,
    accessToken,
    getProfile,
    search,
    getMessage,
    revoke,
    messageText,
    decodeBase64Url
  };
})(typeof globalThis !== "undefined" ? globalThis : self);

"use strict";

/**
 * One-time-code extraction.
 *
 * The job is discrimination, not matching: "123456" is everywhere in email
 * (order numbers, totals, dates, phone numbers). A candidate therefore only
 * counts when it is either (a) close to passcode-ish wording, or (b) alone on
 * a line, which is how most transactional mail renders the code.
 */
(function (global) {
  // ---- vocabulary -------------------------------------------------------

  const STRONG_WORDS = [
    "verification code", "verify code", "verifying code", "security code",
    "confirmation code", "confirm code", "one-time code", "one time code",
    "one-time password", "one time password", "one-time pin", "one time pin",
    "authentication code", "authenticator code", "auth code", "temporary code",
    "login code", "log-in code", "log in code", "sign-in code", "sign in code",
    "access code", "backup code", "recovery code", "security token",
    "passcode", "pass code", "your code", "use code", "enter code", "code is",
    "code below", "pin code", "pin number", "2fa", "mfa code", "captcha", "otp"
  ];
  const WEAK_WORDS = ["code", "pin"];

  const WEIGHT = new Map();
  for (const word of STRONG_WORDS) WEIGHT.set(word, 3);
  for (const word of WEAK_WORDS) WEIGHT.set(word, 1);

  const WORD_RE = new RegExp(
    "\\b(?:" +
      Array.from(WEIGHT.keys())
        .sort((a, b) => b.length - a.length) // longest alternative wins
        .map(escapeRe)
        .join("|") +
      ")\\b",
    "gi"
  );

  // ---- tuning -----------------------------------------------------------

  const OWN_LINE_SCORE = 95; // a number alone on its line
  const MAX_GAP = 240; // weighted characters; beyond this a keyword is too far
  const DECAY = 0.6; // score lost per weighted character of distance
  const WEAK_FACTOR = 0.6; // multiplier at weight 0...
  const WEIGHT_STEP = 0.133; // ...rising to ~1.0 at weight 3
  const GROUP_PENALTY = 0.85; // "123 456" style grouping
  const SHORT_GROUP_PENALTY = 0.8; // "12-3456" style grouping
  const ALNUM_PENALTY = 0.9;
  const NOISE = {
    year: 0.35,
    unit: 0.3,
    context: 0.55,
    phone: 0.5,
    dateEdge: 0.5,
    dateInside: 0.85,
    repeated: 0.5
  };

  const DEFAULT_LENGTHS = [4, 5, 6, 7, 8];
  const CODE_RE = /\b(\d{4,10})\b/g;
  const GROUP_RE = /\b(\d{3,4})[ \t\u00a0.\-\u2010-\u2015_](\d{3,4})\b/g;
  const SHORT_GROUP_RE = /\b(\d{2})[ \t\u00a0.\-\u2010-\u2015_](\d{3,4})\b/g;
  const ALNUM_RE = /\b([A-Za-z0-9]{3,8}(?:[-\u2013\u2014][A-Za-z0-9]{3,8})?)\b/g;

  const NOISE_CONTEXT_RE = /\b(phone|tel|mobile|order|invoice|zip|postal|account|iban|card|ip|mac)\b/;
  const NOISE_UNIT_RE = /\b(px|mb|gb|kb|ms|usd|eur|gbp|%|kg|lb|kb\/s|mib|items?|orders?|points?)\b\s*$/;
  const DATE_INLINE_RE = /\d{1,2}[:/.]\d{1,2}[:/.]\d{2,4}/;

  function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\/\-]/g, "\\$&");
  }

  // ---- html -------------------------------------------------------------

  function htmlToText(html) {
    if (typeof html !== "string") return "";
    return html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
      .replace(/<td[^>]*>/gi, " \t")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;|&#x0*27;/gi, "'")
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ *\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function toText(input) {
    if (typeof input !== "string") return "";
    return /<[a-z!/][\s\S]*>/i.test(input) ? htmlToText(input) : input;
  }

  // ---- context analysis -------------------------------------------------

  function findKeywords(text) {
    const found = [];
    WORD_RE.lastIndex = 0;
    let match;
    while ((match = WORD_RE.exec(text)) !== null) {
      found.push({
        start: match.index,
        end: match.index + match[0].length,
        weight: WEIGHT.get(match[0].toLowerCase()) || 1
      });
      if (match.index === WORD_RE.lastIndex) WORD_RE.lastIndex++; // zero-length guard
    }
    return found;
  }

  /** Distance from the candidate to the closest keyword, scaled by its weight. */
  function keywordDistance(keywords, start, end) {
    let gap = Infinity;
    let weight = 0;
    for (const keyword of keywords) {
      let chars;
      if (keyword.end <= start) chars = start - keyword.end;
      else if (keyword.start >= end) chars = keyword.start - end;
      else chars = 0; // overlapping
      const weighted = chars / keyword.weight;
      if (weighted < gap) {
        gap = weighted;
        weight = keyword.weight;
      }
    }
    return { gap, weight };
  }

  function isOwnLine(text, start, end) {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    if (text.slice(lineStart, start).trim() !== "") return false;
    const lineEnd = text.indexOf("\n", end);
    const tail = (lineEnd === -1 ? text.slice(end) : text.slice(end, lineEnd)).trim();
    return tail === "" || tail === "." || tail === ":" || tail === ")";
  }

  /** Multiplier <1 for digits that smell like something other than a code. */
  function noiseFactor(code, start, end, text) {
    let factor = 1;
    const before = text.slice(Math.max(0, start - 40), start);
    const after = text.slice(end, end + 16);
    const around = (before + "\n" + after).toLowerCase();

    if (code.length === 4 && /^(19|20)\d{2}$/.test(code)) factor *= NOISE.year;
    if (NOISE_UNIT_RE.test(after.toLowerCase())) factor *= NOISE.unit;
    if (NOISE_CONTEXT_RE.test(around)) factor *= NOISE.context;
    if (/\+\s*\d/.test(before) || /(\+|\bx)\s*$/.test(before)) factor *= NOISE.phone;
    if (/[-/:]\s*$/.test(before)) factor *= NOISE.dateEdge;
    if (/^\s*[-/:]/.test(after)) factor *= NOISE.dateEdge;
    if (/\b(?:19|20)\d{2}\b/.test(code) || DATE_INLINE_RE.test(around)) factor *= NOISE.dateInside;
    if (/^(\d)\1+$/.test(code)) factor *= NOISE.repeated;

    return factor;
  }

  // ---- extraction -------------------------------------------------------

  function extract(input, options) {
    const config = Object.assign(
      { allowedLengths: DEFAULT_LENGTHS, allowAlphanumeric: false, minScore: 1 },
      options || {}
    );
    const text = toText(input);
    if (!text) return [];

    const allowed = new Set(config.allowedLengths.map(Number));
    const keywords = findKeywords(text);
    const results = [];
    const seen = new Set();

    /**
     * @param {string} code        value that would be copied
     * @param {number} start       index of the match in `text`
     * @param {number} end         end index of the match in `text`
     * @param {number} [penalty]   grouped-form penalty
     * @param {number} [length]    length used for the allowed-length check
     */
    function consider(code, start, end, penalty, length) {
      const size = length || code.length;
      if (size < 4 || size > 12 || !allowed.has(size)) return;

      const { gap, weight } = keywordDistance(keywords, start, end);
      let score;
      if (isOwnLine(text, start, end)) {
        score = OWN_LINE_SCORE;
      } else if (!Number.isFinite(gap) || gap > MAX_GAP) {
        return; // no keyword anywhere near it
      } else {
        score = Math.max(0, 100 - gap * DECAY) * (WEAK_FACTOR + WEIGHT_STEP * weight);
      }

      score = Math.min(100, score * noiseFactor(code, start, end, text) * (penalty || 1));
      if (score < config.minScore) return;

      const key = code + "@" + start;
      if (seen.has(key)) return;
      seen.add(key);

      results.push({
        code,
        score: Math.round(score * 10) / 10,
        start,
        end,
        context: text
          .slice(Math.max(0, start - 60), Math.min(text.length, end + 40))
          .replace(/\s+/g, " ")
          .trim()
      });
    }

    let match;

    CODE_RE.lastIndex = 0;
    while ((match = CODE_RE.exec(text)) !== null) {
      consider(match[1], match.index, match.index + match[1].length, 1);
    }

    GROUP_RE.lastIndex = 0;
    while ((match = GROUP_RE.exec(text)) !== null) {
      consider(match[1] + match[2], match.index, match.index + match[0].length, GROUP_PENALTY);
    }

    SHORT_GROUP_RE.lastIndex = 0;
    while ((match = SHORT_GROUP_RE.exec(text)) !== null) {
      consider(match[1] + match[2], match.index, match.index + match[0].length, SHORT_GROUP_PENALTY);
    }

    if (config.allowAlphanumeric) {
      ALNUM_RE.lastIndex = 0;
      while ((match = ALNUM_RE.exec(text)) !== null) {
        const raw = match[1];
        const bare = raw.replace(/[-\u2013\u2014]/g, "");
        // Mixed letter/digit only; pure digits are handled by CODE_RE.
        if (bare.length < 5 || !/\d/.test(bare) || !/[A-Za-z]/.test(bare)) continue;
        consider(raw, match.index, match.index + raw.length, ALNUM_PENALTY, bare.length);
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  function best(input, options) {
    const config = Object.assign({ minScore: 30 }, options || {});
    for (const candidate of extract(input, config)) {
      if (candidate.score >= config.minScore) return candidate;
    }
    return null;
  }

  global.OTP = { extract, best, htmlToText, toText };
})(typeof globalThis !== "undefined" ? globalThis : self);

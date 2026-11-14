// Generated from deploy/mcp-task-server/src/privacy-guard.ts.
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  PrivacyError: () => PrivacyError,
  inspectPublicOutput: () => inspectPublicOutput,
  sensitiveText: () => sensitiveText
});
module.exports = __toCommonJS(stdin_exports);
class PrivacyError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PrivacyError";
  }
}
const compiled = /* @__PURE__ */ new WeakMap();
function prepare(rules) {
  const existing = compiled.get(rules);
  if (existing) return existing;
  try {
    if (rules.version !== 1) throw Error();
    const value = { patterns: rules.patterns.map((rule) => new RegExp(rule.pattern, rule.flags)), ignored: new Set(rules.labeled_secret.ignore_values), call: new RegExp("^(?:" + rules.labeled_secret.unquoted_call_pattern + ")$") };
    compiled.set(rules, value);
    return value;
  } catch {
    throw new PrivacyError("PRIVACY_POLICY_UNAVAILABLE", "PCRC privacy policy is unavailable.");
  }
}
function routingValue(key, value) {
  if (key === "lease_token") return /^[A-Za-z0-9_-]{43}$/.test(value);
  if (["task_id", "session_id", "frame_id", "backup_id"].includes(key)) return /^[a-f0-9]{32}$/.test(value);
  if (["search_id", "request_id"].includes(key)) return /^[a-f0-9-]{36}$/.test(value);
  return ["sha256", "expected_sha256", "source_sha256"].includes(key) && /^[a-f0-9]{64}$/.test(value);
}
function plainSensitive(text, rules) {
  const prepared = prepare(rules);
  if (prepared.patterns.some((pattern) => pattern.test(text))) return true;
  const labeled = new RegExp(rules.labeled_secret.pattern, rules.labeled_secret.flags + "g");
  for (const match of text.matchAll(labeled)) {
    const value = match[1];
    const start = match.index + match[0].length - value.length;
    const quoted = text[start - 1] === '"' || text[start - 1] === "'";
    if (!quoted && (prepared.ignored.has(value.toLowerCase()) || prepared.call.test(value))) continue;
    return true;
  }
  for (const match of text.matchAll(new RegExp(rules.card_pattern, "g"))) {
    const digits = match[1].replace(/[^0-9]/g, "");
    if (!rules.card_lengths.includes(digits.length)) continue;
    let total = 0;
    for (let i = digits.length - 1, doubled = false; i >= 0; i--, doubled = !doubled) {
      let digit = Number(digits[i]);
      if (doubled) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      total += digit;
    }
    if (total % 10 === 0) return true;
  }
  return false;
}
function sensitiveLabel(label, rules) {
  return rules.label_probe_values.some((probe) => plainSensitive(label + "=" + probe, rules));
}
function duplicateJsonKeys(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") stack.push(/* @__PURE__ */ new Set());
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") end++;
        end++;
      }
      let next = end + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      const object = stack.at(-1);
      if (object && text[next] === ":") {
        const key = JSON.parse(text.slice(i, end + 1));
        if (object.has(key)) return true;
        object.add(key);
      }
      i = end;
    }
  }
  return false;
}
function pythonLiteral(text) {
  let at = 0, nodes = 0;
  const skip = () => {
    while (at < text.length && /\s/.test(text[at])) at++;
  };
  const invalid = () => {
    throw new SyntaxError();
  };
  const read = (depth = 0) => {
    if (++nodes > 4096 || depth > 12) throw new PrivacyError("OUTPUT_LIMIT_EXCEEDED", "Output exceeded privacy inspection limits. Request a smaller result.");
    skip();
    const char = text[at];
    if (char === "'" || char === '"') {
      at++;
      let value = "";
      while (at < text.length) {
        const next = text[at++];
        if (next === char) return value;
        if (next !== "\\") {
          value += next;
          continue;
        }
        const escape = text[at++];
        const replacements = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", a: "\x07", v: "\v", "\\": "\\", "'": "'", '"': '"' };
        if (Object.hasOwn(replacements, escape)) value += replacements[escape];
        else if (escape === "x" || escape === "u" || escape === "U") {
          const length = escape === "x" ? 2 : escape === "u" ? 4 : 8, digits = text.slice(at, at + length);
          if (digits.length !== length || !/^[a-f0-9]+$/i.test(digits) || Number.parseInt(digits, 16) > 1114111) return invalid();
          value += String.fromCodePoint(Number.parseInt(digits, 16));
          at += length;
        } else return invalid();
      }
      return invalid();
    }
    if (char === "{") {
      at++;
      skip();
      const result = /* @__PURE__ */ Object.create(null);
      while (text[at] !== "}") {
        const key = read(depth + 1);
        skip();
        if (typeof key !== "string" || text[at++] !== ":") return invalid();
        if (Object.hasOwn(result, key)) throw new PrivacyError("OUTPUT_UNSAFE_STRUCTURE", "Output contains duplicate literal fields. Request an unambiguous result.");
        result[key] = read(depth + 1);
        skip();
        if (text[at] !== ",") break;
        at++;
        skip();
      }
      if (text[at++] !== "}") return invalid();
      return result;
    }
    if (char === "[" || char === "(") {
      const close = char === "[" ? "]" : ")";
      at++;
      skip();
      const result = [];
      while (text[at] !== close) {
        result.push(read(depth + 1));
        skip();
        if (text[at] !== ",") break;
        at++;
        skip();
      }
      if (text[at++] !== close) return invalid();
      return result;
    }
    for (const [word, value] of [["None", null], ["True", true], ["False", false]]) if (text.startsWith(word, at)) {
      at += word.length;
      return value;
    }
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (number && Number.isFinite(Number(number[0]))) {
      at += number[0].length;
      return Number(number[0]);
    }
    return invalid();
  };
  try {
    const value = read();
    skip();
    return at === text.length ? { parsed: true, value } : { parsed: false };
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    return { parsed: false };
  }
}
function inspectPublicOutput(values, rules) {
  const prepared = prepare(rules);
  let nodes = 0, characters = 0;
  const walk = (value, labels = [], depth = 0) => {
    if (++nodes > 1e4 || depth > 12) throw new PrivacyError("OUTPUT_LIMIT_EXCEEDED", "Output exceeded privacy inspection limits. Request a smaller result.");
    const contexts = [labels.join(" "), ...labels].filter(Boolean);
    if (typeof value === "string") {
      characters += value.length;
      if (characters > 2 * 1024 * 1024) throw new PrivacyError("OUTPUT_LIMIT_EXCEEDED", "Output exceeded privacy inspection limits. Request a smaller result.");
      if (/^\s*[\[({"']/.test(value)) {
        if (value.length > 262144) throw new PrivacyError("OUTPUT_LIMIT_EXCEEDED", "Output exceeded privacy inspection limits. Request a smaller result.");
        let parsed, valid = false;
        try {
          parsed = JSON.parse(value);
          valid = true;
        } catch {
        }
        if (valid) {
          if (duplicateJsonKeys(value)) throw new PrivacyError("OUTPUT_UNSAFE_STRUCTURE", "Output contains duplicate JSON fields. Request an unambiguous result.");
          walk(parsed, labels, depth + 1);
          return;
        }
        const literal = pythonLiteral(value);
        if (literal.parsed) {
          walk(literal.value, labels, depth + 1);
          return;
        }
      }
      const routed = routingValue(labels.at(-1) ?? "", value);
      const inherited = labels.slice(0, -1);
      const inheritedContexts = [inherited.join(" "), ...inherited].filter(Boolean);
      const checkContexts = routed ? inheritedContexts : contexts;
      if ((!routed || inheritedContexts.some((label) => sensitiveLabel(label, rules))) && (plainSensitive(value, rules) || checkContexts.some((label) => plainSensitive(label + '="' + value + '"', rules)))) throw new PrivacyError("SENSITIVE_CONTENT_BLOCKED", rules.error);
    } else if (typeof value === "number") {
      const text = String(value);
      if (plainSensitive(text, rules) || contexts.some((label) => plainSensitive(label + "=" + text, rules))) throw new PrivacyError("SENSITIVE_CONTENT_BLOCKED", rules.error);
    } else if (Array.isArray(value)) for (const item of value) walk(item, labels, depth + 1);
    else if (value !== null && typeof value === "object") for (const [name, item] of Object.entries(value)) {
      if (plainSensitive(name, rules)) throw new PrivacyError("SENSITIVE_CONTENT_BLOCKED", rules.error);
      if (name === "type" && typeof item === "string" && prepared.ignored.has(item)) continue;
      walk(item, [...labels, name], depth + 1);
    }
  };
  values.forEach((value) => walk(value));
}
function sensitiveText(text, rules) {
  try {
    inspectPublicOutput([text], rules);
    return false;
  } catch (error) {
    if (error instanceof PrivacyError && error.code !== "PRIVACY_POLICY_UNAVAILABLE") return true;
    throw error;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PrivacyError,
  inspectPublicOutput,
  sensitiveText
});

/** Shared, dependency-free plaintext guard. Detection rules have one packaged JSON authority. */
export type PrivacyRules = {
  version: number; patterns: Array<{ pattern: string; flags: string }>;
  labeled_secret: { pattern: string; flags: string; ignore_values: string[]; unquoted_call_pattern: string };
  card_pattern: string; card_lengths: number[]; error: string; label_probe_values: string[];
};
export class PrivacyError extends Error {
  readonly code:string;
  constructor(code: string, message: string) { super(message); this.code=code;this.name = 'PrivacyError'; }
}
type PreparedRules = { patterns: RegExp[]; ignored: Set<string>; call: RegExp };
const compiled = new WeakMap<PrivacyRules, PreparedRules>();
function prepare(rules: PrivacyRules): PreparedRules {
  const existing = compiled.get(rules);
  if (existing) return existing;
  try {
    if (rules.version !== 1) throw Error();
    const value = { patterns: rules.patterns.map(rule => new RegExp(rule.pattern, rule.flags)), ignored: new Set(rules.labeled_secret.ignore_values), call: new RegExp('^(?:' + rules.labeled_secret.unquoted_call_pattern + ')$') };
    compiled.set(rules, value);
    return value;
  } catch { throw new PrivacyError('PRIVACY_POLICY_UNAVAILABLE', 'PCRC privacy policy is unavailable.'); }
}
function routingValue(key: string, value: string): boolean {
  if (key === 'lease_token') return /^[A-Za-z0-9_-]{43}$/.test(value);
  if (['task_id', 'session_id', 'frame_id', 'backup_id'].includes(key)) return /^[a-f0-9]{32}$/.test(value);
  if (['search_id', 'request_id'].includes(key)) return /^[a-f0-9-]{36}$/.test(value);
  return ['sha256', 'expected_sha256', 'source_sha256'].includes(key) && /^[a-f0-9]{64}$/.test(value);
}
function plainSensitive(text: string, rules: PrivacyRules): boolean {
  const prepared = prepare(rules);
  if (prepared.patterns.some(pattern => pattern.test(text))) return true;
  const labeled = new RegExp(rules.labeled_secret.pattern, rules.labeled_secret.flags + 'g');
  for (const match of text.matchAll(labeled)) {
    const value = match[1]!;
    const start = match.index + match[0].length - value.length;
    const quoted = text[start - 1] === '"' || text[start - 1] === "'";
    if (!quoted && (prepared.ignored.has(value.toLowerCase()) || prepared.call.test(value))) continue;
    return true;
  }
  for (const match of text.matchAll(new RegExp(rules.card_pattern, 'g'))) {
    const digits = match[1]!.replace(/[^0-9]/g, '');
    if (!rules.card_lengths.includes(digits.length)) continue;
    let total = 0;
    for (let i = digits.length - 1, doubled = false; i >= 0; i--, doubled = !doubled) {
      let digit = Number(digits[i]);
      if (doubled) { digit *= 2; if (digit > 9) digit -= 9; }
      total += digit;
    }
    if (total % 10 === 0) return true;
  }
  return false;
}
function sensitiveLabel(label: string, rules: PrivacyRules): boolean {
  return rules.label_probe_values.some(probe => plainSensitive(label + '=' + probe, rules));
}
function duplicateJsonKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '\"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '\"') { if (text[end] === '\\') end++; end++; }
      let next = end + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      const object = stack.at(-1);
      if (object && text[next] === ':') {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (object.has(key)) return true;
        object.add(key);
      }
      i = end;
    }
  }
  return false;
}
// Literal-only Python repr support: never evaluate a name, call, attribute or operator.
function pythonLiteral(text: string): { parsed: boolean; value?: unknown } {
  let at = 0, nodes = 0;
  const skip = () => { while (at < text.length && /\s/.test(text[at]!)) at++; };
  const invalid = (): never => { throw new SyntaxError(); };
  const read = (depth = 0): unknown => {
    if (++nodes > 4096 || depth > 12) throw new PrivacyError('OUTPUT_LIMIT_EXCEEDED', 'Output exceeded privacy inspection limits. Request a smaller result.');
    skip(); const char = text[at];
    if (char === "'" || char === '"') {
      at++; let value = '';
      while (at < text.length) {
        const next = text[at++]!;
        if (next === char) return value;
        if (next !== '\\') { value += next; continue; }
        const escape = text[at++]!;
        const replacements: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', a: '\x07', v: '\x0b', '\\': '\\', "'": "'", '"': '"' };
        if (Object.hasOwn(replacements, escape)) value += replacements[escape];
        else if (escape === 'x' || escape === 'u' || escape === 'U') {
          const length = escape === 'x' ? 2 : escape === 'u' ? 4 : 8, digits = text.slice(at, at + length);
          if (digits.length !== length || !/^[a-f0-9]+$/i.test(digits) || Number.parseInt(digits, 16) > 0x10ffff) return invalid();
          value += String.fromCodePoint(Number.parseInt(digits, 16)); at += length;
        } else return invalid();
      }
      return invalid();
    }
    if (char === '{') {
      at++; skip(); const result: Record<string, unknown> = Object.create(null);
      while (text[at] !== '}') {
        const key = read(depth + 1); skip();
        if (typeof key !== 'string' || text[at++] !== ':') return invalid();
        if (Object.hasOwn(result, key)) throw new PrivacyError('OUTPUT_UNSAFE_STRUCTURE', 'Output contains duplicate literal fields. Request an unambiguous result.');
        result[key] = read(depth + 1); skip();
        if (text[at] !== ',') break;
        at++; skip();
      }
      if (text[at++] !== '}') return invalid();
      return result;
    }
    if (char === '[' || char === '(') {
      const close = char === '[' ? ']' : ')'; at++; skip(); const result: unknown[] = [];
      while (text[at] !== close) {
        result.push(read(depth + 1)); skip();
        if (text[at] !== ',') break;
        at++; skip();
      }
      if (text[at++] !== close) return invalid();
      return result;
    }
    for (const [word, value] of [['None', null], ['True', true], ['False', false]] as const) if (text.startsWith(word, at)) { at += word.length; return value; }
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (number && Number.isFinite(Number(number[0]))) { at += number[0].length; return Number(number[0]); }
    return invalid();
  };
  try { const value = read(); skip(); return at === text.length ? { parsed: true, value } : { parsed: false }; }
  catch (error) { if (error instanceof PrivacyError) throw error; return { parsed: false }; }
}
export function inspectPublicOutput(values: unknown[], rules: PrivacyRules): void {
  const prepared = prepare(rules);
  let nodes = 0, characters = 0;
  const walk = (value: unknown, labels: string[] = [], depth = 0): void => {
    if (++nodes > 10000 || depth > 12) throw new PrivacyError('OUTPUT_LIMIT_EXCEEDED', 'Output exceeded privacy inspection limits. Request a smaller result.');
    const contexts = [labels.join(' '), ...labels].filter(Boolean);
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > 2 * 1024 * 1024) throw new PrivacyError('OUTPUT_LIMIT_EXCEEDED', 'Output exceeded privacy inspection limits. Request a smaller result.');
      if (/^\s*[\[({"']/.test(value)) {
        if (value.length > 262144) throw new PrivacyError('OUTPUT_LIMIT_EXCEEDED', 'Output exceeded privacy inspection limits. Request a smaller result.');
        let parsed: unknown, valid = false;
        try { parsed = JSON.parse(value) as unknown; valid = true; } catch { /* Try bounded literal syntax, never executable code. */ }
        if (valid) {
          if (duplicateJsonKeys(value)) throw new PrivacyError('OUTPUT_UNSAFE_STRUCTURE', 'Output contains duplicate JSON fields. Request an unambiguous result.');
          walk(parsed, labels, depth + 1); return;
        }
        const literal = pythonLiteral(value);
        if (literal.parsed) { walk(literal.value, labels, depth + 1); return; }
      }
      const routed = routingValue(labels.at(-1) ?? '', value);
      const inherited = labels.slice(0, -1);
      const inheritedContexts = [inherited.join(' '), ...inherited].filter(Boolean);
      const checkContexts = routed ? inheritedContexts : contexts;
      if ((!routed || inheritedContexts.some(label => sensitiveLabel(label, rules))) &&
          (plainSensitive(value, rules) || checkContexts.some(label => plainSensitive(label + '=\"' + value + '\"', rules)))) throw new PrivacyError('SENSITIVE_CONTENT_BLOCKED', rules.error);
    } else if (typeof value === 'number') {
      const text = String(value);
      if (plainSensitive(text, rules) || contexts.some(label => plainSensitive(label + '=' + text, rules))) throw new PrivacyError('SENSITIVE_CONTENT_BLOCKED', rules.error);
    } else if (Array.isArray(value)) for (const item of value) walk(item, labels, depth + 1);
    else if (value !== null && typeof value === 'object') for (const [name, item] of Object.entries(value)) {
      if (plainSensitive(name, rules)) throw new PrivacyError('SENSITIVE_CONTENT_BLOCKED', rules.error);
      if (name === 'type' && typeof item === 'string' && prepared.ignored.has(item)) continue;
      walk(item, [...labels, name], depth + 1);
    }
  };
  values.forEach(value => walk(value));
}
export function sensitiveText(text: string, rules: PrivacyRules): boolean {
  try { inspectPublicOutput([text], rules); return false; }
  catch (error) { if (error instanceof PrivacyError && error.code !== 'PRIVACY_POLICY_UNAVAILABLE') return true; throw error; }
}

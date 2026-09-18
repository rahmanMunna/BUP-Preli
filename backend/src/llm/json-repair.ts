/**
 * Best-effort recovery of JSON from an LLM response.
 *
 * Even in JSON mode a model occasionally wraps output in ```json fences, adds
 * a sentence of prose, leaves a trailing comma, or emits Python literals. None
 * of that should cost us a whole optimization request, so we repair it here
 * before giving up and retrying the call.
 */

export class JsonRepairError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'JsonRepairError';
  }
}

/** Removes markdown code fences and any prose around them. */
export function stripCodeFences(text: string): string {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Scans for the first syntactically balanced `{...}` or `[...]`, ignoring
 * braces that appear inside string literals.
 */
export function extractFirstJsonValue(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (opener !== '{' && opener !== '[') continue;

    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === opener) depth += 1;
      else if (char === closer) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Drops commas that sit directly before a closing brace or bracket. */
export function removeTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/** Replaces literals no JSON parser accepts with their JSON equivalents. */
function normalizeLiterals(text: string): string {
  return text
    .replace(/\bNaN\b/g, 'null')
    .replace(/\b-?Infinity\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

/**
 * Parses `text` as JSON, applying escalating repairs. Throws `JsonRepairError`
 * only when nothing parseable can be salvaged.
 */
export function parseJsonLoose<T = unknown>(text: string): T {
  const raw = (text ?? '').trim();
  if (!raw) throw new JsonRepairError('LLM returned an empty response', raw);

  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  push(raw);
  const unfenced = stripCodeFences(raw);
  push(unfenced);
  push(extractFirstJsonValue(unfenced));
  push(removeTrailingCommas(unfenced));
  push(normalizeLiterals(removeTrailingCommas(unfenced)));

  const extracted = extractFirstJsonValue(normalizeLiterals(unfenced));
  push(extracted);
  push(extracted ? removeTrailingCommas(extracted) : null);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next, more aggressively repaired candidate
    }
  }

  throw new JsonRepairError(
    'LLM response could not be parsed as JSON after repair',
    raw.slice(0, 500),
  );
}

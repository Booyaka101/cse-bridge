/**
 * The small regex scanner shared by the pagemap head reader (HTML) and
 * `cse-bridge import` (Google's PSE XML). Neither needs a parser: both read
 * flat, mostly machine-written markup, and the package has no dependencies.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/**
 * The inside of one tag with quoted values respected, so `content="a > b"` does
 * not end the tag early and lose the whole meta. The three branches begin with
 * different characters, which keeps matching linear on malformed markup.
 */
export const TAG_BODY = String.raw`(?:"[^"]*"|'[^']*'|[^>"'])*`;

/** Attribute name (lowercased) -> decoded value, for the inside of one tag. */
export function attributesOf(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTRIBUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTRIBUTE_RE.exec(tagBody)) !== null) {
    const name = m[1]!.toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

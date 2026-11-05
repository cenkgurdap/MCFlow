/** Minimal class-name joiner. Falsy entries are dropped. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out = out ? `${out} ${p}` : p;
  }
  return out;
}

// Service Dark: one way to filter lists, so every list matches the same way.
// A row matches when every word typed appears somewhere in its text, in any order, ignoring case:
// "west reg" matches a row whose key is "Region" and value "us-west-2".

/**
 * @param {string} query what was typed
 * @param {...(string | number | null | undefined)} texts the row's searchable text
 */
export function matches(query, ...texts) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = texts.filter((t) => t != null).join(" ").toLowerCase();
  return words.every((w) => haystack.includes(w));
}

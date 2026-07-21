/**
 * Parse a stored method's polymorphic `MethodData.mthds` source into bundle
 * file contents. The string is either raw `.mthds` source or a JSON-serialized
 * `[{ name, content }, …]` file array (the webapp editor format).
 *
 * Mirrors the platform's canonical implementation — `_method_source_to_contents`
 * plus its caller's blank-source guard in `_resolve_method_contents`, both in
 * pipelex-platform's `routers/v1/execution.py` — keep the two in sync. A JSON
 * `[]` is "no source", not a bundle; a JSON array of `{ name, content }`
 * objects yields the non-blank contents; anything else (raw source, non-array
 * JSON, unparseable) is one plain bundle string, itself dropped when blank.
 * An empty result means the stored method has no MTHDS source.
 *
 * One deliberate divergence: the platform's blank-source guard is a falsy
 * check (`if method.mthds`), so a whitespace-only raw source would pass there
 * and fail downstream at parse; here it trims to "no source" — a clearer
 * verdict for the same degenerate input.
 */
export function methodSourceToContents(mthds: string): string[] {
  // The API types `mthds` as string, but mirror the platform's falsy guard so
  // a contract-violating null/undefined reads as "no source", not a crash.
  if (!mthds) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(mthds);
  } catch {
    return rawBundle(mthds);
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return [];
    }
    if (parsed.every(isFileEntry)) {
      return parsed
        .map((entry) => entry.content)
        .filter(
          (content): content is string => typeof content === "string" && content.trim() !== "",
        );
    }
  }

  return rawBundle(mthds);
}

function rawBundle(mthds: string): string[] {
  return mthds.trim() === "" ? [] : [mthds];
}

function isFileEntry(entry: unknown): entry is { name: unknown; content: unknown } {
  return typeof entry === "object" && entry !== null && "name" in entry && "content" in entry;
}

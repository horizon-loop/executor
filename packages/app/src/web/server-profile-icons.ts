import { Option, Schema } from "effect";

// ---------------------------------------------------------------------------
// horizon-loop fork: an emoji per server profile, shown in the profile
// selector. Kept beside (not inside) upstream's profile store, keyed by the
// profile's connection key, so upstream's persisted profile format is untouched.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "executor.serverProfileIcons.v1";

const decodeIcons = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

export type ServerProfileIcons = Readonly<Record<string, string>>;

export const readServerProfileIcons = (): ServerProfileIcons => {
  const raw = globalThis.window?.localStorage.getItem(STORAGE_KEY);
  return raw ? Option.getOrElse(decodeIcons(raw), () => ({})) : {};
};

/** Set (or, with an empty icon, clear) one profile's emoji; returns the new map. */
export const writeServerProfileIcon = (key: string, icon: string): ServerProfileIcons => {
  const { [key]: _previous, ...rest } = readServerProfileIcons();
  const next = icon ? { ...rest, [key]: icon } : rest;
  globalThis.window?.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
};

/** The first user-perceived character of `text` (one emoji, flags and ZWJ
 *  sequences included), or "" when empty. */
export const firstGrapheme = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  return first?.segment ?? "";
};

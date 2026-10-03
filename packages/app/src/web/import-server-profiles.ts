import { Encoding, Option, Result, Schema } from "effect";
import {
  readExecutorServerProfiles,
  upsertExecutorServerProfile,
  writeExecutorServerProfiles,
} from "@executor-js/react/api/server-profiles";

// ---------------------------------------------------------------------------
// horizon-loop fork: one-time import of Executor server profiles from the URL
// fragment, so `scripts/profiles.sh open` can register every per-client daemon
// in the server switcher in one click.
//
//   /#servers=<base64url(JSON [{ name, origin, token }])>
//
// The fragment never reaches a server. It is merged into the saved profiles
// (existing entries for the same origin are replaced, the active one is kept)
// and stripped from the address bar before the app mounts.
// ---------------------------------------------------------------------------

const FRAGMENT_KEY = "servers";

const ImportedServers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      origin: Schema.String,
      token: Schema.String,
    }),
  ),
);
const decodeImportedServers = Schema.decodeUnknownOption(ImportedServers);

export const importServerProfilesFromFragment = (): void => {
  const location = globalThis.window?.location;
  if (!location?.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const encoded = params.get(FRAGMENT_KEY);
  if (encoded === null) return;

  params.delete(FRAGMENT_KEY);
  const rest = params.toString();
  globalThis.window.history.replaceState(
    null,
    "",
    location.pathname + location.search + (rest ? `#${rest}` : ""),
  );

  const json = Encoding.decodeBase64UrlString(encoded);
  if (Result.isFailure(json)) return;
  const servers = decodeImportedServers(json.success);
  if (Option.isNone(servers)) return;

  const storage = globalThis.window.localStorage;
  let snapshot = readExecutorServerProfiles(storage);
  for (const server of servers.value) {
    // A name edited in the web UI wins over the profile name from the script;
    // the "host:port" fallback the switcher saves by default does not count.
    const existing = snapshot.profiles.find((profile) => profile.origin === server.origin);
    const keptName =
      existing?.displayName && existing.displayName !== server.origin.replace(/^https?:\/\//, "")
        ? existing.displayName
        : server.name;
    snapshot =
      upsertExecutorServerProfile(
        snapshot,
        {
          kind: "http",
          origin: server.origin,
          displayName: keptName,
          auth: { kind: "bearer", token: server.token },
        },
        { makeActive: false },
      ) ?? snapshot;
  }
  writeExecutorServerProfiles(storage, snapshot);
};

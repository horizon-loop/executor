import { useCallback, useEffect, useRef, useState } from "react";
import { PencilIcon, ServerIcon } from "lucide-react";
import {
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  useExecutorServerConnection,
  useSetExecutorServerConnection,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "@executor-js/react/api/server-connection";
import {
  EXECUTOR_SERVER_PROFILES_STORAGE_KEY,
  getActiveExecutorServerProfile,
  normalizeExecutorServerProfilesSnapshot,
  parseExecutorServerProfilesSnapshot,
  readExecutorServerProfiles,
  removeExecutorServerProfile,
  selectExecutorServerProfile,
  serializeExecutorServerProfilesSnapshot,
  upsertExecutorServerProfile,
  writeExecutorServerProfiles,
  type ExecutorServerProfilesSnapshot,
} from "@executor-js/react/api/server-profiles";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { NativeSelect, NativeSelectOption } from "@executor-js/react/components/native-select";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@executor-js/react/components/popover";
import { cn } from "@executor-js/react/lib/utils";
import {
  firstGrapheme,
  readServerProfileIcons,
  writeServerProfileIcon,
  type ServerProfileIcons,
} from "./server-profile-icons";

const SUGGESTED_ICONS = ["🏠", "💼", "🌱", "⚡", "🚀", "🧪", "🛠️", "🔒", "🌍", "🎯", "🧠", "📦"];

interface ProfileEdit {
  readonly key: string;
  readonly name: string;
  readonly icon: string;
}

type AuthMode = "none" | "bearer" | "basic";

interface DraftProfile {
  readonly origin: string;
  readonly displayName: string;
  readonly authMode: AuthMode;
  readonly username: string;
  readonly secret: string;
}

const emptyDraft: DraftProfile = {
  origin: "",
  displayName: "",
  authMode: "none",
  username: "executor",
  secret: "",
};

interface DesktopProfileStorageBridge {
  readonly getServerProfiles: () => Promise<string | null>;
  readonly setServerProfiles: (value: string) => Promise<void>;
}

const browserStorage = () => globalThis.window?.localStorage ?? null;

const desktopProfileStorageBridge = (): DesktopProfileStorageBridge | null => {
  const bridge = globalThis.window?.executor;
  if (
    !bridge ||
    typeof bridge.getServerProfiles !== "function" ||
    typeof bridge.setServerProfiles !== "function"
  ) {
    return null;
  }
  return {
    getServerProfiles: bridge.getServerProfiles,
    setServerProfiles: bridge.setServerProfiles,
  };
};

const hasDesktopServerConnectionBridge = (): boolean =>
  Boolean(desktopProfileStorageBridge()) ||
  typeof globalThis.window?.executor?.getServerConnection === "function";

const readDesktopServerConnection = (): Promise<ExecutorServerConnectionInput | null> | null => {
  const bridge = globalThis.window?.executor;
  if (!bridge || typeof bridge.getServerConnection !== "function") return null;
  return bridge.getServerConnection();
};

const readBrowserProfiles = (): ExecutorServerProfilesSnapshot =>
  readExecutorServerProfiles(browserStorage());

const clearBrowserProfiles = (): void => {
  browserStorage()?.removeItem(EXECUTOR_SERVER_PROFILES_STORAGE_KEY);
};

const readStoredProfiles = (): Promise<ExecutorServerProfilesSnapshot> => {
  const bridge = desktopProfileStorageBridge();
  const browserProfiles = readBrowserProfiles();
  if (!bridge) return Promise.resolve(browserProfiles);

  return bridge.getServerProfiles().then(
    (raw) => {
      const desktopProfiles = parseExecutorServerProfilesSnapshot(raw);
      if (desktopProfiles.profiles.length > 0) {
        if (browserProfiles.profiles.length > 0) {
          const mergedProfiles = normalizeExecutorServerProfilesSnapshot({
            activeKey: desktopProfiles.activeKey ?? browserProfiles.activeKey,
            profiles: [...browserProfiles.profiles, ...desktopProfiles.profiles],
          });
          void bridge
            .setServerProfiles(serializeExecutorServerProfilesSnapshot(mergedProfiles))
            .then(clearBrowserProfiles, () => undefined);
          return mergedProfiles;
        }
        clearBrowserProfiles();
        return desktopProfiles;
      }
      if (browserProfiles.profiles.length > 0) {
        void bridge
          .setServerProfiles(serializeExecutorServerProfilesSnapshot(browserProfiles))
          .then(clearBrowserProfiles, () => undefined);
        return browserProfiles;
      }
      return desktopProfiles;
    },
    () => browserProfiles,
  );
};

const writeStoredProfiles = (snapshot: ExecutorServerProfilesSnapshot): void => {
  const bridge = desktopProfileStorageBridge();
  if (!bridge) {
    writeExecutorServerProfiles(browserStorage(), snapshot);
    return;
  }

  void bridge
    .setServerProfiles(serializeExecutorServerProfilesSnapshot(snapshot))
    .then(clearBrowserProfiles, () => undefined);
};

const serverLabel = (connection: ExecutorServerConnection): string =>
  connection.displayName || connection.origin.replace(/^https?:\/\//, "");

const serverDescription = (connection: ExecutorServerConnection): string =>
  connection.origin.replace(/^https?:\/\//, "");

const serverKindLabel = (connection: ExecutorServerConnection): string => {
  if (connection.kind === "desktop-sidecar") return "Local";
  const hostname = new URL(connection.origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    ? "Local"
    : "Remote";
};

const authLabel = (connection: ExecutorServerConnection): string => {
  const authorization = getExecutorServerAuthorizationHeader(connection);
  if (!authorization) return "No auth";
  if (authorization.startsWith("Bearer ")) return "Bearer";
  if (authorization.startsWith("Basic ")) return "Basic";
  return "Auth";
};

const isLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";

const isLoopbackConnection = (connection: ExecutorServerConnection): boolean => {
  const url = new URL(connection.origin);
  return isLoopbackHost(url.hostname);
};

const sameLoopbackServer = (a: ExecutorServerConnection, b: ExecutorServerConnection): boolean => {
  const left = new URL(a.origin);
  const right = new URL(b.origin);
  return (
    left.protocol === right.protocol &&
    isLoopbackHost(left.hostname) &&
    isLoopbackHost(right.hostname) &&
    (left.port || (left.protocol === "https:" ? "443" : "80")) ===
      (right.port || (right.protocol === "https:" ? "443" : "80"))
  );
};

const hasBearerAuth = (connection: ExecutorServerConnection): boolean =>
  connection.auth?.kind === "bearer" && connection.auth.token.length > 0;

// The live connection is rebuilt from the page origin on every load, so its
// name is the "host:port" default; re-saving it must keep the name the user
// gave the profile.
const snapshotWithCurrent = (
  snapshot: ExecutorServerProfilesSnapshot,
  connection: ExecutorServerConnection,
  makeActive: boolean,
): ExecutorServerProfilesSnapshot => {
  const storedName = snapshot.profiles.find(
    (profile) => profile.key === connection.key,
  )?.displayName;
  const named =
    connection.displayName === serverDescription(connection) && storedName
      ? { ...connection, displayName: storedName }
      : connection;
  return upsertExecutorServerProfile(snapshot, named, { makeActive }) ?? snapshot;
};

const withoutLoopbackProfiles = (
  snapshot: ExecutorServerProfilesSnapshot,
): ExecutorServerProfilesSnapshot =>
  normalizeExecutorServerProfilesSnapshot({
    activeKey: snapshot.activeKey,
    profiles: snapshot.profiles.filter((profile) => !isLoopbackConnection(profile)),
  });

const draftAuth = (draft: DraftProfile): ExecutorServerAuth | undefined => {
  const secret = draft.secret.trim();
  if (draft.authMode === "bearer" && secret) {
    return { kind: "bearer", token: secret };
  }
  if (draft.authMode === "basic" && secret) {
    return {
      kind: "basic",
      username: draft.username.trim() || undefined,
      password: secret,
    };
  }
  return undefined;
};

interface ServerConnectionMenuProps {
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  readonly variant?: "default" | "header";
}

export function ServerConnectionMenu(props: ServerConnectionMenuProps = {}) {
  const connection = useExecutorServerConnection();
  const setServerConnection = useSetExecutorServerConnection();
  const hydratedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const [snapshot, setSnapshot] = useState<ExecutorServerProfilesSnapshot>(() => ({
    activeKey: connection.key,
    profiles: [connection],
  }));
  const [draft, setDraft] = useState<DraftProfile>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [showCustomServer, setShowCustomServer] = useState(false);
  const [icons, setIcons] = useState<ServerProfileIcons>(readServerProfileIcons);
  const [edit, setEdit] = useState<ProfileEdit | null>(null);
  // The live connection has no name of its own; show the saved profile's.
  const activeProfile =
    snapshot.profiles.find((profile) => profile.key === connection.key) ?? connection;

  const persistSnapshot = useCallback((next: ExecutorServerProfilesSnapshot) => {
    setSnapshot(next);
    writeStoredProfiles(next);
  }, []);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    let cancelled = false;
    void readStoredProfiles().then((stored) => {
      void (async () => {
        if (cancelled) return;
        const desktopBridge = hasDesktopServerConnectionBridge();
        const desktopConnection =
          (await readDesktopServerConnection()?.then(
            (value) => value,
            () => null,
          )) ?? null;
        const storedActive = getActiveExecutorServerProfile(stored);
        const current = desktopConnection
          ? normalizeExecutorServerConnection(desktopConnection)
          : connection;
        const baseStored = desktopConnection ? withoutLoopbackProfiles(stored) : stored;
        const shouldKeepCurrent =
          desktopBridge ||
          storedActive === null ||
          (hasBearerAuth(current) &&
            storedActive !== null &&
            sameLoopbackServer(current, storedActive));
        const next = snapshotWithCurrent(baseStored, current, shouldKeepCurrent);
        persistSnapshot(next);
        if (desktopConnection) {
          setServerConnection(desktopConnection);
        } else if (!shouldKeepCurrent && storedActive && storedActive.key !== connection.key) {
          setServerConnection(storedActive);
        }
        setHydrated(true);
      })();
    });

    return () => {
      cancelled = true;
    };
  }, [connection, persistSnapshot, setServerConnection]);

  useEffect(() => {
    if (!hydrated) return;
    setSnapshot((previous) => {
      const base = hasDesktopServerConnectionBridge()
        ? withoutLoopbackProfiles(previous)
        : previous;
      const next = snapshotWithCurrent(base, connection, true);
      writeStoredProfiles(next);
      return next;
    });
  }, [connection, hydrated]);

  const selectProfile = (key: string): void => {
    const next = selectExecutorServerProfile(snapshot, key);
    const active = getActiveExecutorServerProfile(next);
    persistSnapshot(next);
    if (active) setServerConnection(active);
  };

  const removeProfile = (key: string): void => {
    if (snapshot.profiles.length <= 1) return;
    const next = removeExecutorServerProfile(snapshot, key);
    const active = getActiveExecutorServerProfile(next);
    persistSnapshot(next);
    setIcons(writeServerProfileIcon(key, ""));
    if (key === connection.key && active) setServerConnection(active);
  };

  const saveEdit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!edit) return;
    const profile = snapshot.profiles.find((candidate) => candidate.key === edit.key);
    if (!profile) return;
    const displayName = edit.name.trim();
    const renamed = { ...profile, displayName: displayName || undefined };
    const next = upsertExecutorServerProfile(snapshot, renamed, { makeActive: false });
    if (next) persistSnapshot(next);
    if (profile.key === connection.key) setServerConnection(renamed);
    setIcons(writeServerProfileIcon(profile.key, firstGrapheme(edit.icon)));
    setEdit(null);
  };

  const addProfile = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const origin = draft.origin.trim();
    if (!origin) {
      setError("Enter a server origin.");
      return;
    }
    if (draft.authMode !== "none" && !draft.secret.trim()) {
      setError("Enter the credential value.");
      return;
    }

    const auth = draftAuth(draft);
    const input: ExecutorServerConnectionInput = {
      kind: "http",
      origin,
      ...(draft.displayName.trim() ? { displayName: draft.displayName.trim() } : {}),
      ...(auth ? { auth } : {}),
    };
    const next = upsertExecutorServerProfile(snapshot, input);
    const active = next ? getActiveExecutorServerProfile(next) : null;
    if (!next || !active) {
      setError("Enter a valid http or https origin.");
      return;
    }

    setError(null);
    setDraft(emptyDraft);
    setShowCustomServer(false);
    persistSnapshot(next);
    setServerConnection(active);
  };
  const trigger =
    props.variant === "header" ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Select Executor server: ${serverLabel(activeProfile)}`}
        title={`${serverLabel(activeProfile)} (${serverDescription(activeProfile)})`}
        className="size-7 rounded-md text-muted-foreground hover:bg-sidebar-active hover:text-foreground"
      >
        <ServerIcon className="size-3.5" />
      </Button>
    ) : (
      <Button
        type="button"
        variant="ghost"
        aria-label="Select Executor server"
        className="group h-auto min-h-10 w-full justify-start rounded-md px-2.5 py-1.5 text-left hover:bg-sidebar-active"
      >
        <ProfileIcon icon={icons[connection.key]} />
        <span className="ml-2 flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium leading-5 text-foreground">
              {serverLabel(activeProfile)}
            </span>
            <span className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
              {serverKindLabel(connection)}
            </span>
          </span>
          <span className="truncate text-xs font-normal leading-4 text-muted-foreground">
            {serverDescription(connection)}
          </span>
        </span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          className="ml-2 size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
          aria-hidden="true"
        >
          <path
            d="M4.5 6.5 8 10l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Button>
    );

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={props.side ?? "right"}
        align={props.align ?? "start"}
        className="w-96 p-0"
      >
        <PopoverHeader className="border-b border-border px-4 py-3">
          <PopoverTitle>Server profiles</PopoverTitle>
        </PopoverHeader>

        <div className="max-h-96 overflow-y-auto p-2">
          {snapshot.profiles.map((profile) => {
            const active = profile.key === connection.key;
            const profileAuthLabel = authLabel(profile);
            if (edit?.key === profile.key) {
              return (
                <form
                  key={profile.key}
                  onSubmit={saveEdit}
                  className="grid gap-2 rounded-md bg-accent/40 p-2"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Emoji"
                      value={edit.icon}
                      onChange={(event) =>
                        setEdit({ ...edit, icon: firstGrapheme(event.target.value) })
                      }
                      placeholder="🙂"
                      className="h-8 w-12 text-center text-base"
                    />
                    <Input
                      aria-label="Name"
                      value={edit.name}
                      onChange={(event) => setEdit({ ...edit, name: event.target.value })}
                      placeholder={serverDescription(profile)}
                      className="h-8 flex-1 text-sm"
                      autoFocus
                    />
                  </div>
                  <div className="flex flex-wrap gap-0.5">
                    {SUGGESTED_ICONS.map((icon) => (
                      <Button
                        key={icon}
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Use ${icon}`}
                        onClick={() => setEdit({ ...edit, icon })}
                        className={cn("text-base", edit.icon === icon && "bg-accent")}
                      >
                        {icon}
                      </Button>
                    ))}
                  </div>
                  <div className="flex justify-end gap-1">
                    <Button type="button" variant="ghost" size="xs" onClick={() => setEdit(null)}>
                      Cancel
                    </Button>
                    <Button type="submit" size="xs">
                      Save
                    </Button>
                  </div>
                </form>
              );
            }
            return (
              <div
                key={profile.key}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5",
                  active ? "bg-accent/70" : "hover:bg-accent/40",
                )}
              >
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => selectProfile(profile.key)}
                  className="h-auto min-w-0 flex-1 justify-start gap-2 px-0 py-0 text-left hover:bg-transparent"
                >
                  <ProfileIcon icon={icons[profile.key]} />
                  <span className="flex min-w-0 flex-col">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {serverLabel(profile)}
                    </span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {serverDescription(profile)}
                    </span>
                  </span>
                </Button>
                <span className="rounded border border-border/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                  {serverKindLabel(profile)}
                </span>
                {profileAuthLabel !== "No auth" && (
                  <span className="rounded border border-border/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {profileAuthLabel}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit ${serverLabel(profile)}`}
                  onClick={() =>
                    setEdit({
                      key: profile.key,
                      name: profile.displayName ?? "",
                      icon: icons[profile.key] ?? "",
                    })
                  }
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={snapshot.profiles.length <= 1}
                  onClick={() => removeProfile(profile.key)}
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>

        <div className="border-t border-border p-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start px-2"
            onClick={() => {
              setError(null);
              setShowCustomServer((value) => !value);
            }}
          >
            {showCustomServer ? "Hide custom server" : "Custom server"}
          </Button>

          {showCustomServer && (
            <form onSubmit={addProfile} className="mt-3">
              <div className="grid gap-2">
                <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
                  Origin
                  <Input
                    value={draft.origin}
                    onChange={(event) => setDraft({ ...draft, origin: event.target.value })}
                    placeholder="https://executor.example"
                    className="h-8 text-sm"
                  />
                </Label>
                <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
                  Name
                  <Input
                    value={draft.displayName}
                    onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
                    placeholder="Remote executor"
                    className="h-8 text-sm"
                  />
                </Label>
                <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
                  Auth
                  <NativeSelect
                    size="sm"
                    value={draft.authMode}
                    onChange={(event) =>
                      setDraft({ ...draft, authMode: event.target.value as AuthMode })
                    }
                  >
                    <NativeSelectOption value="none">None</NativeSelectOption>
                    <NativeSelectOption value="bearer">Bearer token</NativeSelectOption>
                    <NativeSelectOption value="basic">Basic password</NativeSelectOption>
                  </NativeSelect>
                </Label>
                {draft.authMode === "basic" && (
                  <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
                    Username
                    <Input
                      value={draft.username}
                      onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                      className="h-8 text-sm"
                    />
                  </Label>
                )}
                {draft.authMode !== "none" && (
                  <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
                    {draft.authMode === "bearer" ? "Token" : "Password"}
                    <Input
                      type="password"
                      value={draft.secret}
                      onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                      className="h-8 text-sm"
                    />
                  </Label>
                )}
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button type="submit" size="sm" className="w-full">
                  Add and use
                </Button>
              </div>
            </form>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A profile's emoji, or the neutral dot when it has none. */
function ProfileIcon(props: { readonly icon: string | undefined }) {
  return props.icon ? (
    <span className="flex size-5 shrink-0 items-center justify-center text-base leading-none">
      {props.icon}
    </span>
  ) : (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <span className="size-1.5 rounded-full bg-primary/80" />
    </span>
  );
}

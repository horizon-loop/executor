#!/usr/bin/env bash
# Keep the horizon-loop fork on top of upstream: replay the fork's own commits
# (`git log upstream/main..main`) onto the latest UsefulSoftwareCo/executor main.
#
#   scripts/sync-upstream.sh          # fetch, rebase, install, verify
#   scripts/sync-upstream.sh --push   # ...then force-push (with lease) to origin/main
#
# Generated files (bun.lock, routeTree.gen.ts) are regenerated rather than
# merged. Any other conflict stops the rebase: fix it, `git add`,
# `git rebase --continue`, then rerun this script. Nothing is pushed unless
# verification passes; the pre-sync commit is printed for `git reset --hard`.
set -euo pipefail

# The rebase rewrites this very file; parse the whole script before running it.
{
push=false
[ "${1:-}" = "--push" ] && push=true

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/UsefulSoftwareCo/executor.git
fi
git remote set-url --push upstream DISABLED # never push to upstream by accident

rebasing() { [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; }

# Take the upstream side of a generated file and rebuild it from the merged sources.
resolve_generated() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    case "$file" in
      bun.lock)
        git checkout --ours -- bun.lock
        bun install --lockfile-only >/dev/null
        git add bun.lock
        ;;
      */routeTree.gen.ts)
        git checkout --ours -- "$file"
        (cd "$(echo "$file" | cut -d/ -f1-2)" && bun run routes:gen >/dev/null)
        git add "$file"
        ;;
      *)
        echo "Conflict needs a manual fix: $file" >&2
        return 1
        ;;
    esac
  done < <(git diff --name-only --diff-filter=U)
}

if ! rebasing; then
  [ "$(git branch --show-current)" = main ] || { echo "Run on main." >&2; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo "Working tree is not clean." >&2; exit 1; }
  git fetch --quiet origin
  git fetch --quiet upstream main
  echo "pre-sync: $(git rev-parse --short HEAD)  (undo: git reset --hard $(git rev-parse HEAD))"
  echo "upstream: $(git rev-list --count HEAD..upstream/main) new commit(s)"
  echo "fork:     $(git rev-list --count upstream/main..HEAD) commit(s) replayed on top"
  git rebase upstream/main || true
fi

while rebasing; do
  if [ -z "$(git diff --name-only --diff-filter=U)" ]; then
    echo "Rebase stopped without conflicts; inspect with 'git status'." >&2
    exit 1
  fi
  resolve_generated || { echo "Then: git add <files> && git rebase --continue && $0 ${1:-}" >&2; exit 1; }
  GIT_EDITOR=true git rebase --continue || true
done

bun install
bun run check:routes
bun run lint
bun run typecheck
(cd apps/local && bunx --bun vitest run)
(cd packages/core/execution && bunx --bun vitest run)

if $push; then
  git push --force-with-lease origin main
else
  echo "Verified. Publish with: git push --force-with-lease origin main"
fi
exit
}

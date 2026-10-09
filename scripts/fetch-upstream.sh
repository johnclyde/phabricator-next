#!/bin/sh
# Download reference source only. Never execute the historical PHP application.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
reference="$root/reference"
lock="$root/docs/upstream-lock.tsv"

if [ -L "$reference" ]; then
  printf '%s\n' 'Refusing a symlink at reference/.' >&2
  exit 1
fi
mkdir -p "$reference"

while IFS="$(printf '\t')" read -r name origin commit; do
  case "$name" in ''|'#'*) continue ;; esac
  case "$name" in phabricator|arcanist|libphutil) ;; *) exit 1 ;; esac
  if [ "$origin" != "https://github.com/phacility/$name.git" ]; then
    printf '%s\n' "Unexpected origin for $name in lock file." >&2
    exit 1
  fi
  case "$commit" in *[!0-9a-f]*|'') exit 1 ;; esac
  [ "${#commit}" -eq 40 ] || exit 1
  destination="$reference/$name"

  if [ -L "$destination" ]; then
    printf '%s\n' "Refusing a symlink at $destination." >&2
    exit 1
  fi
  if [ -e "$destination" ]; then
    if [ ! -d "$destination/.git" ]; then
      printf '%s\n' "Refusing to replace non-repository $destination." >&2
      exit 1
    fi
    actual_origin=$(git -C "$destination" remote get-url origin)
    if [ "$actual_origin" != "$origin" ]; then
      printf '%s\n' "Refusing unexpected origin at $destination." >&2
      exit 1
    fi
    if [ -n "$(git -C "$destination" status --porcelain --untracked-files=all)" ]; then
      printf '%s\n' "Reference checkout has changes: $destination. Preserve them before retrying." >&2
      exit 1
    fi
  else
    git -c core.hooksPath=/dev/null clone --filter=blob:none --no-checkout "$origin" "$destination"
  fi

  if ! git -C "$destination" cat-file -e "$commit^{commit}" 2>/dev/null; then
    git -C "$destination" -c core.hooksPath=/dev/null fetch --filter=blob:none origin "$commit"
  fi
  git -C "$destination" -c core.hooksPath=/dev/null checkout --detach "$commit"
  actual_commit=$(git -C "$destination" rev-parse HEAD)
  [ "$actual_commit" = "$commit" ] || exit 1
  printf '%s\n' "$name: $actual_commit"
done < "$lock"

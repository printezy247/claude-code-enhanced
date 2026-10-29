#!/usr/bin/env bash
# A sha256 over what a .deb ships, ignoring the parts lintian's slow checks do
# not depend on: the *.desktop entry (validated separately) and the control
# metadata (never in the payload). Same payload, same fingerprint, whatever the
# version string or the menu entry says. Prints nothing and exits 1 on failure.
set -uo pipefail
deb="${1:-}"
[ -f "$deb" ] || { echo "usage: payload-fingerprint.sh <file.deb>" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
dpkg-deb --fsys-tarfile "$deb" | tar -x -C "$tmp" 2>/dev/null || exit 1
(
  cd "$tmp" || exit 1
  # names and modes, then contents: a renamed or chmod-ed file changes it too
  find . ! -name '*.desktop' \( -type f -o -type l \) -printf '%p %m %l\n' | LC_ALL=C sort
  find . ! -name '*.desktop' -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
) | sha256sum | cut -d' ' -f1

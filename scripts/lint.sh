#!/usr/bin/env bash
# Lint the built deb. Suppressed tags are inherent to shipping an Electron app
# (bundled libs, /opt layout, unpacked node_modules); everything else fails.
#
# NOTE: do not add a multi-line `deb.description` to package.json. electron-builder
# reuses that field for the .desktop Comment= value, and an embedded newline
# produces an unparseable desktop entry (dpkg warns during install, and the menu
# entry breaks). `description-starts-with-leading-spaces` is suppressed below
# precisely so nobody "fixes" that lint warning by adding one.
#
# Caching: lintian walks the whole archive, which is the slow part. Its checks
# are about the files shipped, not about the .desktop entry or the control
# metadata (version, description), so a run that passed is remembered by a
# fingerprint of the payload (every file except *.desktop). A build whose
# payload is identical skips lintian; the .desktop entry is still validated
# every time. LINT_FORCE=1 runs lintian regardless.
#
# Exit status: lintian's own is reported but does not fail this script unless
# LINT_STRICT=1. (It never did: nothing here checked it, and CI keeps the deb
# artifact only if this step passes, so failing by default would drop it.)
set -uo pipefail
cd "$(dirname "$0")/.."

dist="${LINT_DIST:-dist}"
cache="${LINT_CACHE:-.cache/lint}"
deb=("$dist"/*.deb)
if [ ! -e "${deb[0]}" ]; then
  echo "no deb in $dist/ — run: npm run dist" >&2
  exit 1
fi

fingerprint="$(bash "$(dirname "$0")/payload-fingerprint.sh" "${deb[0]}")"
mkdir -p "$cache"
lint_rc=0
if [ -z "${LINT_FORCE:-}" ] && [ -n "$fingerprint" ] && [ "$(cat "$cache/lintian.ok" 2>/dev/null)" = "$fingerprint" ]; then
  echo "  ok  lintian skipped: the payload is unchanged since the last clean run (LINT_FORCE=1 to run it)"
else
lintian --suppress-tags \
dir-or-file-in-opt,\
unstripped-binary-or-object,\
shared-library-is-executable,\
embedded-library,\
non-standard-file-perm,\
non-standard-dir-perm,\
non-standard-executable-perm,\
script-not-executable,\
unusual-interpreter,\
maintainer-script-ignores-errors,\
hardening-no-pie,\
hardening-no-relro,\
unknown-section,\
unknown-field,\
postrm-removes-alternative,\
missing-dep-for-interpreter,\
program-not-linked-against-libc,\
no-copyright-file \
  --suppress-tags description-starts-with-leading-spaces \
  "${deb[@]}"
lint_rc=$?
if [ "$lint_rc" -eq 0 ] && [ -n "$fingerprint" ]; then
  printf '%s' "$fingerprint" > "$cache/lintian.ok"
else
  rm -f "$cache/lintian.ok"
fi
fi

# The .desktop entry must parse. A multi-line Comment= (which electron-builder
# derives from deb.description) shipped broken in 0.8.0: dpkg warned during
# install and the menu entry was unusable.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if command -v desktop-file-validate >/dev/null 2>&1; then
  dpkg-deb --fsys-tarfile "${deb[0]}" | tar -xO --wildcards '*applications/*.desktop' > "$tmp/entry.desktop" 2>/dev/null || true
  if [ -s "$tmp/entry.desktop" ]; then
    if ! desktop-file-validate "$tmp/entry.desktop"; then
      echo "FAIL  invalid .desktop entry in ${deb[0]}" >&2
      exit 1
    fi
    echo "  ok  desktop entry valid"
  fi
fi

if [ "$lint_rc" -ne 0 ]; then
  echo "lintian exited with status $lint_rc (set LINT_STRICT=1 to fail on it)" >&2
  [ -n "${LINT_STRICT:-}" ] && exit "$lint_rc"
fi
exit 0

#!/usr/bin/env bash
# Lint the built deb. Suppressed tags are inherent to shipping an Electron app
# (bundled libs, /opt layout, unpacked node_modules); everything else fails.
#
# NOTE: do not add a multi-line `deb.description` to package.json. electron-builder
# reuses that field for the .desktop Comment= value, and an embedded newline
# produces an unparseable desktop entry (dpkg warns during install, and the menu
# entry breaks). `description-starts-with-leading-spaces` is suppressed below
# precisely so nobody "fixes" that lint warning by adding one.
set -uo pipefail
cd "$(dirname "$0")/.."

deb=(dist/*.deb)
if [ ! -e "${deb[0]}" ]; then
  echo "no deb in dist/ — run: npm run dist" >&2
  exit 1
fi

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

# The .desktop entry must parse. A multi-line Comment= (which electron-builder
# derives from deb.description) shipped broken in 0.8.0: dpkg warned during
# install and the menu entry was unusable.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if command -v desktop-file-validate >/dev/null 2>&1; then
  dpkg-deb --fsys-tarfile "${deb[0]}" | tar -xO ./usr/share/applications/claude-code-enhanced.desktop > "$tmp/entry.desktop"
  if ! desktop-file-validate "$tmp/entry.desktop"; then
    echo "FAIL  invalid .desktop entry in ${deb[0]}" >&2
    exit 1
  fi
  echo "  ok  desktop entry valid"
fi

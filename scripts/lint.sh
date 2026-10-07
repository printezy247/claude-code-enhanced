#!/usr/bin/env bash
# Lint the built deb. Suppressed tags are inherent to shipping an Electron app
# (bundled libs, /opt layout, unpacked node_modules); everything else fails.
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
  "${deb[@]}"

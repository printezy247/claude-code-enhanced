# Working rules for this repo

## Downloads: ask, don't fetch
- Never download anything to refine, upgrade or test (npm/npx installs of new
  packages, `npx --yes <tool>`, Electron headers, browsers, binaries, curl/wget)
  without asking first. Give the user the exact command(s) to run on their
  machine instead, say why it is needed, and wait.
- Don't resume blindly after an interruption: say what was about to run and why.
- Verification the user can do on their machine (e.g. inspecting the installed
  package) is preferred over fetching tools into the sandbox.

## Install commands for the user
- Checkout: `/home/jack/Documents/Default Project/claude-code-enhanced`
- `pkill -f claude-code-enhanced`, then `git pull && npm ci && npm run dist`,
  then `sudo dpkg -i dist/claude-code-enhanced-<version>-amd64.deb`, or the
  `claude-code-enhanced-deb` CI artifact.

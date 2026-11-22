# Running Portalstone as a service

The agent was written to be run by hand (`npm run mvp`). This is the other mode: a release build
that runs on plain Node, installed as a Windows service so it is always there when you log out of
the game and open a browser.

Two pieces of tooling, both in this repo:

- `scripts/build-release.mjs` — bundles the agent into `dist/portalstone/` (esbuild, one ES module
  plus the static files it serves). No `tsx`, no `typescript`, no `node_modules` at run time.
- `scripts/install-service.mjs` — copies that build to `Program Files` and registers it with
  [serv](https://github.com/TillmanBuildsTech/serv), the cross-platform NSSM successor: restart
  backoff, log rotation, graceful stop escalation, one YAML file.

## Build

    npm run build

    dist/portalstone/
      portalstone.mjs        the whole agent (bundled core + agent, sourcemap beside it)
      assets/                dashboard builder, grid skin, vendored gridstack
      portalstone.cmd        console launcher: portalstone.cmd --open

Requires Node 24 or newer to run — the store is `node:sqlite`, so there is no native module to
compile and nothing to install on the host.

## Run it without installing

    node dist/portalstone/portalstone.mjs --open
    node dist/portalstone/portalstone.mjs --once --db "D:/tmp/scratch.db"

Same flags as the dev entry point: `--open`, `--once`, `--rebuild`, `--port`, `--db`,
`--install "<wow dir>"`.

## Install as a service

Needs an administrator shell. `scripts\install-service.cmd` re-launches itself through UAC:

    scripts\install-service.cmd
    npm run service:install                 # equivalent, from an admin terminal

It then:

1. copies `dist/portalstone/` to `%ProgramFiles%\Portalstone\`,
2. writes `%ProgramData%\serv\portalstone\config.yaml` (and a copy next to the install),
3. installs and starts the service, and waits until `http://127.0.0.1:48120/` answers.

Re-running it is safe: an existing `portalstone` service is stopped and removed first, since serv
only rewrites a definition from its own flags.

    npm run service:install -- --print       # show the config and where things would go, change nothing
    npm run service:install -- --port 48121 --db "C:/ProgramData/Portalstone/portalstone.db"

Defaults, and why:

| | |
|---|---|
| account | `LocalSystem` — it must read the game folder and SavedVariables without holding anyone's password; the UI binds to `127.0.0.1` only |
| database | the existing per-user `%LOCALAPPDATA%\Portalstone\portalstone.db` when there is one, so history carries over; otherwise `%PROGRAMDATA%\Portalstone\portalstone.db` |
| logs | `%PROGRAMDATA%\Portalstone\logs\portalstone.log`, rotated at 5 MB / 7 days, timestamped |
| restart | backoff from 5s to 2m on any non-zero exit; exit 0 means "asked to stop", no restart |
| start type | `auto` (starts at boot) |

## Lifecycle

    serv status portalstone
    serv stop portalstone
    serv start portalstone
    serv remove portalstone        # uninstall; add `rmdir /s "C:\Program Files\Portalstone"` to clean up

Use `serv stop` then `serv start` rather than `serv restart`: on the serv release installed here
(0.1.7) `restart` stops the service and then fails to start it again with "service is already
running", leaving it stopped. `npm run service:install` does the stop/settle/install/start dance
itself, so re-running it is also a valid way to restart on a fresh build.

The service log is the app's own stdout/stderr, line-buffered by serv:

    Get-Content "C:\ProgramData\Portalstone\logs\portalstone.log" -Tail 40 -Wait

## Things worth knowing

- Stop the service before running `npm run mvp`: both want port 48120. The second one to start
  checks the port before it scans and exits with a message saying so. Sharing the database is fine:
  a write that meets the other process's lock waits up to 5s for it, so `--once` beside the
  service works.
- A rebuild of the working tree is not live in the installed copy. `npm run build` then
  `npm run service:install` again to push a change into the service.
- `node.exe` is referenced by absolute path from `process.execPath` at install time. A Node upgrade
  that moves the install means re-running `npm run service:install`.
- Exit code 1 (no World of Warcraft install found) is treated as retryable, so a host where the game
  lives on a drive that appears late ends up serving once it does.

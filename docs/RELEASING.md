# Releasing PortalStone

How a build gets a version, reaches GitHub, and then reaches the services already running on
people's machines. Three moving parts: a stamped version, a CI-published release, and the in-app
updater.

## Versioning

The **git tag is the source of truth**. `scripts/build-release.mjs` resolves the version from
`PORTALSTONE_VERSION` (CI sets this from the tag) → the nearest tag → `package.json` → `0.0.0-dev`,
and bakes it into the bundle through an esbuild `define`. At run time `packages/core/src/version.ts`
reads that constant, falling back to `0.0.0-dev` for a `tsx` dev run (which the updater treats as
"running from source — never offer an update").

Versions are [semver](https://semver.org). **Betas are prereleases**: a tag with a hyphen,
`v0.1.0-beta.1`, is published as a GitHub prerelease; a plain `v0.1.0` is a full release.
`compareSemver` in `version.ts` orders them correctly (`0.1.0-beta.2` < `0.1.0`).

## Cutting a release

    npm run release -- 0.1.0-beta.1      # bump package.json, commit, tag v0.1.0-beta.1, push
    npm run release -- 0.1.0-beta.1 --dry-run   # show what it would do

Pushing the `v*` tag triggers `.github/workflows/release.yml` on GitHub Actions, which:

1. runs `npm run typecheck` and `npm test` as a gate,
2. builds with `PORTALSTONE_VERSION` set from the tag,
3. zips the contents of `dist/portalstone/` into `portalstone-<version>.zip` (+ a `.sha256`),
4. publishes the GitHub Release — marked **prerelease** when the tag has a hyphen — with those two
   assets attached and auto-generated notes.

You can also tag by hand (`git tag v0.1.0 && git push --follow-tags`); the helper just keeps
`package.json` in step and refuses a dirty tree. CI is the only thing that builds the artifact.

## How updates reach users

A running service checks the public releases API
(`https://api.github.com/repos/TillmanBuildsTech/PortalStone/releases`) at startup and every six
hours — anonymous, no identity attached. When a newer release exists on the user's **channel**, a
banner appears under the header:

- **beta** (default): offers prereleases *and* stable — a beta tester still gets a newer stable.
- **stable**: offers full releases only.

The channel is remembered in the database (`meta` key `update.channel`) and switched from the
**diagnostics** page, which also shows the installed version and a "check now" button.

### One-click apply

"Update & restart" works only for an installed service (the installer writes `install.json` beside
the bundle; its absence means a dev run, which the banner tells you to update via the installer). On
click the service, as LocalSystem:

1. downloads `portalstone-<version>.zip` to `%ProgramData%\PortalStone\staging\<version>\`,
2. verifies it against the published `.sha256`,
3. extracts it with the bundled Windows `tar`,
4. launches `updater.mjs` **detached from the staging copy** and returns the HTTP response.

`scripts/updater.mjs` then `serv stop`s the service, moves the install folder aside to `.bak`,
copies the new build in (carrying `service.yaml` and `install.json` forward), and `serv start`s it.
On any failure it restores the `.bak` and restarts the old build, so a bad swap can't leave the
machine with no service. The banner polls `/api/update` throughout and reloads when the new build
answers. Updater activity is logged to `%ProgramData%\PortalStone\logs\updater.log`.

## Non-Windows

The apply path is Windows/`serv`-specific, matching the installer. Other platforms still get the
check and the banner but update the way they were installed (there is no `install.json`, so apply is
refused).

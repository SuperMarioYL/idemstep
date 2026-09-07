/**
 * The single source of truth for the package version.
 *
 * Every version surface is expected to stay in lockstep with this constant:
 *   - `package.json` `"version"`
 *   - the `idemstep --version` / `-v` CLI output
 *   - `web/site.json` `"content_version"`
 *   - the `## [<version>]` head entry of `CHANGELOG.md`
 *
 * `test/version.test.ts` asserts all five are equal, so a bump that misses a
 * surface fails the suite instead of shipping silently drifted. This guard
 * exists because the shipped v0.10.0 tag had no CLI version surface at all
 * (`--version` fell through to the USAGE banner), a `web/site.json`
 * `content_version` stale at `v0.9.0` (one release behind `package.json`
 * `0.10.0`), and a `CHANGELOG.md` head three releases behind (`[0.7.0]`) —
 * drift the lockstep test now prevents from silently recurring.
 *
 * Bump this constant together with `package.json` when cutting a release.
 */
export const VERSION = "0.11.0";

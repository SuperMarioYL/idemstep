import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The repo root (this file lives in test/) and the tsx CLI the project itself
// uses for `npm run dev` / `npm run proxy`. Spawning it is the most robust way
// to assert the CLI `--version` output without depending on the dist build.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const SRC_INDEX_TS = join(REPO_ROOT, "src", "index.ts");

// The single source of truth (src/version.ts), re-exported from src/index.ts.
// Importing it lets the test compare the constant to every other surface
// without re-hardcoding the version string.
import { VERSION } from "../src/index.js";

// ---------------------------------------------------------------------------
// v0.11.0 version-surface lockstep (fix-version-surface-single-source-of-truth
// + fix-changelog-version-drift). The shipped v0.10.0 tag had no CLI version
// surface at all (`idemstep --version` printed the USAGE banner), a stale
// `web/site.json` `content_version` of `v0.9.0` (one release behind
// `package.json` `0.10.0`), and a `CHANGELOG.md` head of `[0.7.0]` (three
// releases behind). These tests pin ALL version surfaces to the single
// source of truth so the drift cannot silently recur.
// ---------------------------------------------------------------------------

function readPkgVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.version as string;
}

function readSiteContentVersion(): string {
  const site = JSON.parse(readFileSync(join(REPO_ROOT, "web", "site.json"), "utf8"));
  return site.content_version as string;
}

function readChangelogHeadVersion(): string {
  const md = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const m = md.match(/^## \[([0-9]+\.[0-9]+\.[0-9]+)\]/m);
  if (!m) throw new Error("no CHANGELOG head version entry found");
  return m[1];
}

describe("v0.11.0: version surfaces are in lockstep", () => {
  it("src/version.ts VERSION == package.json version", () => {
    expect(VERSION).toBe(readPkgVersion());
  });

  it("idemstep --version prints 'idemstep <VERSION>'", () => {
    const out = execFileSync(TSX, [SRC_INDEX_TS, "--version"], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
    });
    expect(out.trim()).toBe(`idemstep ${VERSION}`);
  });

  it("-v is an alias for --version", () => {
    const out = execFileSync(TSX, [SRC_INDEX_TS, "-v"], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
    });
    expect(out.trim()).toBe(`idemstep ${VERSION}`);
  });

  it("web/site.json content_version == VERSION (v-prefix tolerated)", () => {
    // The established site pattern stamps content_version with a leading `v`
    // (e.g. `v0.11.0`); package.json and VERSION use bare semver. The site
    // builder renders the string as-is, so the prefix is tolerated rather
    // than dropped (changing the format risks the external web-factory
    // builder that has rendered prefixed versions for 9 releases).
    expect(readSiteContentVersion().replace(/^v/, "")).toBe(VERSION);
  });

  it("CHANGELOG head version == VERSION", () => {
    expect(readChangelogHeadVersion()).toBe(VERSION);
  });
});

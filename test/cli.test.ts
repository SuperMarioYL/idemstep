import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The repo root (this file lives in test/) and the tsx CLI the project itself
// uses for `npm run dev` / `npm run proxy`. Spawning it is the most robust way
// to run a .ts fixture from a temp dir: tsx resolves its own internals by its
// own location, so the fixture's directory (and any package.json there) cannot
// break loader resolution.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");

// Absolute import spec for the source entry (tsx / Bundler resolution maps the
// `.js` form to `index.ts`). Used by the import fixtures.
const SRC_INDEX_JS_SPEC = join(REPO_ROOT, "src", "index.js");
// Absolute path to the source entry verbatim, used for the direct-run case
// (mirrors `npm run proxy` = `tsx src/index.ts`).
const SRC_INDEX_TS = join(REPO_ROOT, "src", "index.ts");

// First line of the USAGE banner main() prints when invoked with no command.
const BANNER_MARKER = "idemstep — exactly-once";

// Run a fixture entry under the tsx CLI and return its stdout.
function runFixture(
  filename: string,
  body: string,
  extraFiles: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "idem-cli-"));
  try {
    for (const [name, content] of Object.entries(extraFiles)) {
      writeFileSync(join(dir, name), content, "utf8");
    }
    const entry = join(dir, filename);
    writeFileSync(entry, body, "utf8");
    return execFileSync(TSX, [entry], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// v0.4.0 fix-cli-runs-on-import-index-js: importing idemstep from a consumer
// entry named index.js/ts must NOT fire main() / print the USAGE banner. The
// dropped `endsWith("index.js")` / `endsWith("index.ts")` fallbacks were the
// false positives; the primary check + the `endsWith("idemstep")` bin-symlink
// fallback remain, so direct invocation (`idemstep proxy`, `tsx src/index.ts`)
// still runs main().
// ---------------------------------------------------------------------------
describe("v0.4.0: CLI is side-effect-free on import", () => {
  it("does not print the banner when imported by an entry named index.ts", () => {
    const out = runFixture(
      "index.ts",
      `import { idemStep } from ${JSON.stringify(SRC_INDEX_JS_SPEC)};\n` +
        `console.log("IMPORTED_OK", typeof idemStep);\n`,
    );
    expect(out).toContain("IMPORTED_OK function");
    expect(out).not.toContain(BANNER_MARKER);
  });

  it("does not print the banner when imported by an entry named index.js", () => {
    // The `.js` variant covers the dropped `endsWith("index.js")` fallback — the
    // more common consumer shape (a shipped index.js entry). A neighbouring
    // package.json marks the dir ESM so the `.js` entry parses as a module.
    const out = runFixture(
      "index.js",
      `import { idemStep } from ${JSON.stringify(SRC_INDEX_JS_SPEC)};\n` +
        `console.log("IMPORTED_OK", typeof idemStep);\n`,
      { "package.json": JSON.stringify({ type: "module" }) },
    );
    expect(out).toContain("IMPORTED_OK function");
    expect(out).not.toContain(BANNER_MARKER);
  });

  it("still runs main() when invoked directly (idemstep --help prints the banner)", () => {
    // Direct execution must still fire main(): the primary check matches because
    // argv[1] is this module's own `.ts` path (the `npm run proxy` shape).
    const out = execFileSync(TSX, [SRC_INDEX_TS, "--help"], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
    });
    expect(out).toContain(BANNER_MARKER);
  });
});

// ---------------------------------------------------------------------------
// v0.5.0 fix-cli-invoked-directly-path-fragility: invokedDirectly compared
// import.meta.url to the string-concat `file://${process.argv[1]}`. Because
// import.meta.url is URL-encoded and symlink-realpath-resolved while the concat
// form is neither, they mismatched whenever argv[1] contained a space (literal
// space vs %20) or crossed a symlink (e.g. /tmp → /private/tmp on macOS) —
// main() silently no-op'd and `idemstep proxy`/`hosted` printed nothing. The
// fix uses pathToFileURL(realpathSync(argv[1])).href so the comparison handles
// spaces, symlinks, relative paths, and Windows drive letters.
// ---------------------------------------------------------------------------
describe("v0.5.0: CLI runs main() from an entry path containing a space", () => {
  it("prints the banner when run from a temp dir whose path contains a space", () => {
    // A temp dir whose NAME contains a space — reproduces both the literal-space
    // (vs %20) and the macOS /var→/private/var realpath mismatch in one shot.
    // The entry is a SYMLINK to the real src/index.ts: tsx follows it to the
    // real file (so `import "express"` resolves from the repo's node_modules),
    // while process.argv[1] stays the spaced symlink path — exactly the shape
    // that broke the string-concat invokedDirectly check.
    const dir = mkdtempSync(join(tmpdir(), "idem cli space-"));
    try {
      const entry = join(dir, "index.ts");
      symlinkSync(SRC_INDEX_TS, entry);
      const out = execFileSync(TSX, [entry, "--help"], {
        encoding: "utf8",
        cwd: process.cwd(),
        env: process.env,
      });
      // Before the fix: the string-concat check mismatched on the space + the
      // /var realpath, invokedDirectly was false, and the banner never printed.
      expect(out).toContain(BANNER_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

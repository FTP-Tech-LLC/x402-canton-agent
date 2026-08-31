/**
 * Every name the docs tell a payer to import from this package must actually be
 * exported by it.
 *
 * The npm landing page for `@ftptech/x402-canton-client` — and four other docs
 * — told payers to `import { makeCip56KeyfileSigner }`. That symbol had been
 * deleted; there was no `Cip56KeyfileSigner` anywhere in the tree. The first
 * thing a new integrator copied could not resolve, and nothing in the repo
 * noticed, because a README is not compiled.
 *
 * The sibling `docs-snippet.test.ts` pins one snippet's SIGNATURE by compiling
 * it. This pins the far cheaper and more general property across every doc at
 * once: the identifier exists. It is a directory walk plus a regex, so a doc
 * that names a symbol we do not export fails the suite rather than shipping to
 * the registry.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as clientModule from "./index.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(srcDir, "..", "..", "..");
const PKG = "@ftptech/x402-canton-client";

/** Markdown anywhere in the repo, minus build output and dependencies. */
function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (["node_modules", "dist", "build", "coverage"].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) markdownFiles(full, acc);
    else if (e.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

/**
 * What this package exports. Runtime exports come from the module itself;
 * interfaces and type aliases are erased at runtime, so those are read off the
 * `export` declarations in source. Over-inclusive by design — the point is to
 * catch a name that exists NOWHERE, not to police type-vs-value.
 */
function exportedNames(): Set<string> {
  const names = new Set(Object.keys(clientModule));
  const decl =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(srcDir, f), "utf8");
    for (const m of src.matchAll(decl)) names.add(m[1]!);
  }
  return names;
}

/** The named bindings of every `import { … } from "<PKG>"` in a markdown file. */
function importedNames(md: string): string[] {
  const out: string[] = [];
  const imp = new RegExp(
    String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']` +
      PKG.replace(/[/@]/g, (c) => "\\" + c) +
      String.raw`["']`,
    "g"
  );
  for (const m of md.matchAll(imp)) {
    for (const raw of m[1]!.split(",")) {
      // Strip trailing `// …` annotations, `type` prefixes and `as` aliases.
      const name = raw
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name) out.push(name);
    }
  }
  return out;
}

describe("docs must not name an export this package does not have", () => {
  const exported = exportedNames();
  const files = markdownFiles(repoRoot);

  it("finds the markdown to check (the walk itself must not silently no-op)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith(join("packages", "client", "README.md")))).toBe(true);
  });

  it("resolves every documented import against the real export surface", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const f of files) {
      if (!statSync(f).isFile()) continue;
      for (const name of importedNames(readFileSync(f, "utf8"))) {
        checked++;
        if (!exported.has(name)) missing.push(`${relative(repoRoot, f)}: ${name}`);
      }
    }
    // A guard that checked nothing would pass forever.
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("would catch a name that does not exist (the check has teeth)", () => {
    const fake = `import { makeCip56KeyfileSigner } from "${PKG}";`;
    expect(importedNames(fake)).toEqual(["makeCip56KeyfileSigner"]);
    expect(exported.has("makeCip56KeyfileSigner")).toBe(false);
  });

  it("reads real names through `type` prefixes, aliases and trailing comments", () => {
    const src = `import {
      wrapFetchWithCantonPayment,   // the wrapper
      type CantonSigner,
      readPaymentResponseHeader as readHeader,
    } from "${PKG}";`;
    const names = importedNames(src);
    expect(names).toEqual([
      "wrapFetchWithCantonPayment",
      "CantonSigner",
      "readPaymentResponseHeader",
    ]);
    for (const n of names) expect(exported.has(n)).toBe(true);
  });
});

describe("docs must not hand the relay client a URL it will double-prefix", () => {
  // `RelayClient` builds every request as relayUrl + "/v1/wallet/…"
  // (agent-wallet/src/relay-client.ts). A snippet whose relayUrl already ends in
  // that prefix produces .../v1/wallet/v1/wallet/onboard/prepare and 404s on the
  // very first call, with an error that points at the relay rather than at the
  // URL the reader supplied. Two snippets said exactly that — both written in
  // the same sitting as the export fix above, which is precisely why a guard
  // that only checks identifiers was not enough.
  const files = markdownFiles(repoRoot);

  it("no documented relayUrl carries the path the client appends", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const md = readFileSync(f, "utf8");
      for (const m of md.matchAll(/relayUrl\s*:\s*["'`]([^"'`]+)["'`]/g)) {
        const url = m[1]!;
        if (/\/v1\/wallet\/?$/.test(url)) {
          offenders.push(`${relative(repoRoot, f)}: ${url}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the check has teeth", () => {
    expect(/\/v1\/wallet\/?$/.test("https://f.example/v1/wallet")).toBe(true);
    expect(/\/v1\/wallet\/?$/.test("https://f.example")).toBe(false);
  });
});

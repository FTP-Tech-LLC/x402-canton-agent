#!/usr/bin/env node
// Writes src/guide.ts from src/guide.md. get_guide returns the string, so
// nothing is read from disk at runtime (the package ships only dist/). Runs
// before build, typecheck and test; writes only when the content changed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/guide.md", import.meta.url));
const out = fileURLToPath(new URL("../src/guide.ts", import.meta.url));
const next =
  "// GENERATED from guide.md by scripts/gen-guide.mjs. Edit guide.md, not this file.\n" +
  `export const GUIDE = ${JSON.stringify(readFileSync(src, "utf8"))};\n`;
if (!existsSync(out) || readFileSync(out, "utf8") !== next) writeFileSync(out, next);

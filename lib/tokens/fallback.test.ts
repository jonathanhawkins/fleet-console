// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readToken, TOKEN_FALLBACK, type Space } from "./fallback";

/**
 * The fallbacks are copies of app/globals.css, and a copy is only honest while
 * it matches. So the stylesheet is the oracle here: every fallback is checked
 * against the value the token actually resolves to in its space, `var()`
 * chains followed and `color-mix()` evaluated, and a retuned token that
 * nobody carried over fails this file rather than shipping as a stale hex on
 * a canvas.
 */

/**
 * The stylesheet with its own relative `@import`s inlined, comments dropped.
 * globals.css is the entry point whether the tokens sit in it or in a file it
 * pulls in; package imports (tailwind, shadcn) declare no tokens and are left
 * alone.
 */
function stylesheet(path: string, depth = 0): string {
  if (depth > 4) throw new Error(`${path}: @import chain too deep`);
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import\s+"(\.\.?\/[^"]+)";/g, (_, rel: string) =>
      stylesheet(resolvePath(dirname(path), rel), depth + 1),
    );
}

const css = stylesheet(fileURLToPath(new URL("../../app/globals.css", import.meta.url)));

/** Every `--token: value;` declared directly inside a space's rule. */
function declarations(space: Space): Map<string, string> {
  const selector = `[data-space="${space}"] {`;
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`globals.css declares no ${selector} block`);
  let depth = 0;
  let end = -1;
  for (let i = start + selector.length - 1; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`unbalanced ${selector} block`);
  const block = css.slice(start + selector.length, end);
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name!, value!.trim());
  }
  return found;
}

const channel = (hex: string, i: number) =>
  Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/** `color-mix(in srgb, A p%, B)` with the second weight implied — what the tokens use. */
function mix(a: string, weight: number, b: string): string {
  const w = weight / 100;
  const ch = (i: number) => hex2(channel(a, i) * w + channel(b, i) * (1 - w));
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

/** Resolve a token to a hex literal, following `var()` and evaluating `color-mix()`. */
function resolve(name: string, decls: Map<string, string>, depth = 0): string {
  if (depth > 8) throw new Error(`${name}: var() chain too deep`);
  const raw = decls.get(name);
  if (raw === undefined) throw new Error(`${name} is not declared in this space`);
  const value = raw.replace(/var\((--[\w-]+)\)/g, (_, inner: string) =>
    resolve(inner, decls, depth + 1),
  );
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const mixed =
    /^color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+([\d.]+)%,\s*(#[0-9a-f]{6})\)$/i.exec(value);
  if (mixed)
    return mix(mixed[1]!.toLowerCase(), Number(mixed[2]), mixed[3]!.toLowerCase());
  throw new Error(`${name}: cannot resolve "${value}" to a colour`);
}

describe("TOKEN_FALLBACK mirrors app/globals.css", () => {
  for (const space of Object.keys(TOKEN_FALLBACK) as Space[]) {
    const decls = declarations(space);
    describe(space, () => {
      it.each(Object.entries(TOKEN_FALLBACK[space]))("%s → %s", (name, fallback) => {
        expect(resolve(name, decls)).toBe(fallback);
      });
    });
  }

  it("keeps every fallback a six-digit hex — what a canvas or a WebGL layer can hold", () => {
    for (const table of Object.values(TOKEN_FALLBACK)) {
      for (const value of Object.values(table)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("readToken", () => {
  const style = (values: Record<string, string>) =>
    ({ getPropertyValue: (name: string) => values[name] ?? "" }) as CSSStyleDeclaration;

  it("returns the computed variable when the cascade has one, trimmed", () => {
    expect(readToken(style({ "--ink": "  #123456 " }), "--ink", "operator")).toBe(
      "#123456",
    );
  });

  it("falls back to the space's declared value when the variable is absent", () => {
    expect(readToken(style({}), "--ink", "operator")).toBe(
      TOKEN_FALLBACK.operator["--ink"],
    );
    expect(readToken(style({}), "--ink", "machine")).toBe(
      TOKEN_FALLBACK.machine["--ink"],
    );
  });

  it("passes an unresolved expression through — the fallback is for absence, not for shape", () => {
    const expr = "color-mix(in srgb, #3bff6f 68%, #060606)";
    expect(readToken(style({ "--ink-soft": expr }), "--ink-soft", "machine")).toBe(expr);
  });
});

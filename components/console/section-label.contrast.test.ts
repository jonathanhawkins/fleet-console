import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { sectionLabelVariants } from "./section-label";

/**
 * AA contrast pin for SectionLabel.
 *
 * CLAUDE.md non-negotiable #9 states "AA contrast in operator space", and the
 * whole SectionLabel voice is an 11px wide-tracked small-caps label — small
 * text, so the 4.5:1 bar applies, not the 3:1 large-text one. Before this
 * test, `tone="nominal"` was the raw `--nominal` (sage) and measured 4.41:1 on
 * `--bg` and 3.78:1 on the `--nominal-tint` ground it actually renders on (the
 * settled cohort card); `tone="warn"` was worse at 3.10:1 / 2.73:1.
 *
 * The fix was to read the `-ink` slots — the same hues pulled toward the
 * charcoal for exactly this purpose — and this test is what keeps it fixed.
 * It fails if someone re-points a tone at a raw status token, retunes a
 * `color-mix` percentage past the bar, or darkens a tinted ground far enough
 * to eat the margin.
 *
 * Why it parses the stylesheet rather than reading a browser: these tokens are
 * `color-mix()` expressions, so the source hex is not the rendered colour, and
 * jsdom does not resolve them. The resolver below implements the one CSS
 * feature the token layer uses — `color-mix(in srgb, A p%, B)`, a plain
 * gamma-space weighted average — and its output was verified channel-for-
 * channel against Chrome's own computed values (`--nominal-ink` #4A6047,
 * `--warn-ink` #7B5C25, `--alert-ink` #A24136, `--nominal-tint` #E6EAE4,
 * `--warn-tint` #F1EBDF, `--alert-tint` #F2E5E2, `--press` #DBD9D4).
 */

const CSS = readFileSync(
  join(resolve(__dirname, "..", ".."), "app", "styles", "tokens.css"),
  "utf8",
);

/** The custom properties declared in one `[data-space="…"]` rule. */
function tokensFor(space: "operator" | "machine"): Map<string, string> {
  const start = CSS.indexOf(`[data-space="${space}"] {`);
  expect(start, `[data-space="${space}"] block not found`).toBeGreaterThan(-1);

  // Walk braces from the rule's opening `{` to its match, so nested at-rules
  // inside the block cannot end the scan early.
  let depth = 0;
  let end = start;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }

  const body = CSS.slice(start, end);
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
}

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** Resolve a token value to sRGB, following `var()` and `color-mix(in srgb…)`. */
function resolveColor(expr: string, tokens: Map<string, string>, seen = 0): Rgb {
  const value = expr.trim();
  expect(seen, `token indirection too deep: ${expr}`).toBeLessThan(20);

  if (value.startsWith("#")) return parseHex(value);

  const varName = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)?.[1];
  if (varName) {
    const next = tokens.get(varName);
    if (next === undefined) throw new Error(`unknown token ${varName}`);
    return resolveColor(next, tokens, seen + 1);
  }

  const inner = /^color-mix\(\s*in\s+srgb\s*,\s*(.+)\)$/s.exec(value)?.[1];
  if (inner !== undefined) {
    // Split the two colour stops on the top-level comma only — either stop can
    // itself be a `var()` or a nested mix.
    const parts: string[] = [];
    let depth = 0;
    let head = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(inner.slice(head, i));
        head = i + 1;
      }
    }
    parts.push(inner.slice(head));
    const [first, second] = parts;
    if (parts.length !== 2 || first === undefined || second === undefined) {
      throw new Error(`unsupported color-mix arity: ${value}`);
    }

    const stop = (part: string): { color: Rgb; pct: number | null } => {
      const withPct = /^(.*?)\s+([\d.]+)%$/s.exec(part.trim());
      const colour = withPct?.[1];
      const pct = withPct?.[2];
      if (colour !== undefined && pct !== undefined) {
        return { color: resolveColor(colour, tokens, seen + 1), pct: Number(pct) / 100 };
      }
      return { color: resolveColor(part.trim(), tokens, seen + 1), pct: null };
    };

    const a = stop(first);
    const b = stop(second);
    // CSS normalises the pair; the token layer always states exactly one.
    const wa = a.pct ?? (b.pct === null ? 0.5 : 1 - b.pct);
    const wb = b.pct ?? 1 - wa;
    // `in srgb` mixes gamma-encoded channels — a plain weighted average.
    return [
      a.color[0] * wa + b.color[0] * wb,
      a.color[1] * wa + b.color[1] * wb,
      a.color[2] * wa + b.color[2] * wb,
    ];
  }

  throw new Error(`unsupported colour expression: ${value}`);
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every ground a SectionLabel can be rendered on in operator space: the page,
 * the two card surfaces, and the three status tints (the settled cohort card
 * is `bg-nominal-tint` with a `tone="nominal"` label on it, and the unsettled
 * one is `bg-warn-tint` with `tone="warn"` — the two worst pairings, and the
 * reason a `--bg`-only check was not enough).
 *
 * `--press` is deliberately absent: it grounds only `[data-slot="unit-card"]`
 * and `[data-slot="alert-row"]` on `:active`, and neither carries a
 * status-toned label — both use the default `muted` tone, which is checked
 * here and clears the bar on every ground including that one.
 */
const OPERATOR_GROUNDS = [
  "--bg",
  "--surface",
  "--surface-2",
  "--nominal-tint",
  "--warn-tint",
  "--alert-tint",
] as const;

/**
 * The Tailwind text utility each tone emits -> the token it reads.
 *
 * The raw status hues are listed alongside the `-ink` slots on purpose: a
 * regression that re-points a tone at `text-warn` should fail with the ratio it
 * actually measures ("2.73:1 on --warn-tint"), not with "unknown utility".
 */
const TONE_TOKEN: Record<string, string> = {
  "text-ink": "--ink",
  "text-ink-soft": "--ink-soft",
  "text-ink-muted": "--muted",
  "text-nominal-ink": "--nominal-ink",
  "text-warn-ink": "--warn-ink",
  "text-alert-ink": "--alert-ink",
  "text-nominal": "--nominal",
  "text-warn": "--warn",
  "text-alert": "--alert",
};

const TONES = ["muted", "ink", "nominal", "warn", "alert"] as const;

/**
 * `text-*` also spells the type scale (`text-label`, `text-small`…), so the
 * colour classes are the ones left after removing it. Parsed from the @theme
 * block rather than listed here, so a new size cannot be mistaken for a colour.
 */
const TYPE_SCALE = new Set(
  [...CSS.matchAll(/--text-([\w-]+?):/g)].flatMap(([, name]) =>
    name ? [`text-${name}`] : [],
  ),
);

/** The operator-space colour a tone actually paints, straight from the cva. */
function toneToken(tone: (typeof TONES)[number]): string {
  const classes = sectionLabelVariants({ tone }).split(/\s+/);
  // `machine:`-prefixed classes are the dark-space override, not this one.
  const operator = classes.filter(
    (c) => c.startsWith("text-") && !c.includes(":") && !TYPE_SCALE.has(c),
  );
  expect(
    operator,
    `tone "${tone}" should paint exactly one operator colour`,
  ).toHaveLength(1);
  const utility = operator[0] as string;
  const token = TONE_TOKEN[utility];
  expect(
    token,
    `tone "${tone}" paints ${utility}, which this test does not know how to ` +
      `resolve — add it to TONE_TOKEN (and check it clears AA before you do)`,
  ).toBeDefined();
  return token as string;
}

describe("SectionLabel contrast (operator space, AA small text)", () => {
  const tokens = tokensFor("operator");

  it.each(TONES)("tone=%s clears 4.5:1 on every ground it can render on", (tone) => {
    const fg = resolveColor(`var(${toneToken(tone)})`, tokens);
    for (const ground of OPERATOR_GROUNDS) {
      const ratio = contrast(fg, resolveColor(`var(${ground})`, tokens));
      expect(
        Number(ratio.toFixed(2)),
        `tone="${tone}" on ${ground} is ${ratio.toFixed(2)}:1, under the 4.5:1 AA bar ` +
          `for 11px text (CLAUDE.md non-negotiable #9)`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reads the -ink slots for status tones, not the raw palette hues", () => {
    // The regression this pins: `--nominal` is 4.41:1 on --bg and 3.78:1 on
    // --nominal-tint. It is a ring/dial/tint colour, not a text colour.
    expect(toneToken("nominal")).toBe("--nominal-ink");
    expect(toneToken("warn")).toBe("--warn-ink");
    expect(toneToken("alert")).toBe("--alert-ink");
  });

  // The same defect, one component over: ConsoleButton's `danger` variant paints
  // button text, which is text, and it was reading the raw hue too. Pinned here
  // rather than in a second file because the rule is the palette's, not the
  // component's — a status hue is a mark colour, and any surface that sets it as
  // `color` has made the same mistake.
  it("keeps ConsoleButton's danger label off the raw alert hue", () => {
    const source = readFileSync(join(__dirname, "console-button.tsx"), "utf8");
    const danger = /danger:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
    expect(danger, "danger variant not found in console-button.tsx").not.toBe("");
    expect(danger).toContain("text-alert-ink");
    expect(danger).not.toMatch(/text-alert(?!-ink)/);

    const ratio = contrast(
      resolveColor("var(--alert-ink)", tokens),
      resolveColor("var(--alert-tint)", tokens),
    );
    expect(
      Number(ratio.toFixed(2)),
      `danger label on --alert-tint is ${ratio.toFixed(2)}:1 (was 4.33:1 on --alert)`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves the raw status palette free to stay at its PRD hex", () => {
    // The counterpart of the rule above: the fix must not have "corrected" the
    // palette itself, which is spent on non-text marks where 3:1 is the bar.
    expect(resolveColor("var(--nominal)", tokens)).toEqual(parseHex("#5e7d5a"));
    expect(resolveColor("var(--warn)", tokens)).toEqual(parseHex("#b8862f"));
    expect(resolveColor("var(--alert)", tokens)).toEqual(parseHex("#b5473a"));
  });
});

describe("SectionLabel contrast (machine space)", () => {
  const tokens = tokensFor("machine");

  it("is undisturbed by the operator fix: -ink slots alias the status tokens", () => {
    // Machine space has its own luminance ladder and is out of scope for the
    // operator AA rule. This is what makes the swap free there: the tone
    // classes now read `--nominal-ink` etc., which in this space resolve to
    // the very same phosphor/amber/red they did before.
    for (const pair of [
      ["--nominal-ink", "--nominal"],
      ["--warn-ink", "--warn"],
      ["--alert-ink", "--alert"],
    ] as const) {
      expect(
        resolveColor(`var(${pair[0]})`, tokens),
        `${pair[0]} must stay an alias of ${pair[1]} in machine space`,
      ).toEqual(resolveColor(`var(${pair[1]})`, tokens));
    }
  });
});

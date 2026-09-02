import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import prettier from "eslint-config-prettier";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * Boundary rule (PRD §3, CLAUDE.md non-negotiable #2):
 * app code never imports shadcn primitives directly — it imports the wrapped,
 * themed library at `@/components/console`. Only the console layer (and shadcn's
 * own generated files) may reach into `@/components/ui`.
 */
const shadcnBoundary = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: ["@/components/ui", "@/components/ui/*", "**/components/ui/*"],
          message:
            "Import from @/components/console instead. shadcn primitives are internal; only components/console may wrap them.",
        },
      ],
    },
  ],
};

/**
 * The direction of dependency between the two component layers.
 *
 * `components/console` is the library: props in, markup out, usable in any
 * composition. `components/fleet` is this app's store-wired regions, built out
 * of it. The library may therefore never reach into the stores or into the
 * regions — a console primitive that subscribed to `lib/stores` would stop
 * being a primitive, and the split would be a folder rename.
 */
const consoleBoundary = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: ["@/lib/stores", "@/lib/stores/*", "**/lib/stores", "**/lib/stores/*"],
          message:
            "components/console is store-free. A component that needs the stores is a fleet region: put it in components/fleet.",
        },
        {
          group: [
            "@/components/fleet",
            "@/components/fleet/*",
            "**/components/fleet/*",
            "../fleet",
            "../fleet/*",
            "../../fleet/*",
          ],
          message:
            "components/console must not depend on components/fleet; the dependency runs the other way.",
        },
      ],
    },
  ],
};

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      // parallel-agent git worktrees (full repo copies incl. node_modules/.next)
      ".claude/**",
      ".next/**",
      "out/**",
      // the e2e cohort lane's parked artifact (playwright.config.ts)
      ".e2e-cohort/**",
      "build/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  prettier,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "sim/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    rules: shadcnBoundary,
  },
  {
    files: ["components/machine/**/*.{ts,tsx}", "components/fleet/**/*.{ts,tsx}"],
    rules: shadcnBoundary,
  },
  {
    files: ["components/console/**/*.{ts,tsx}"],
    rules: consoleBoundary,
  },
  {
    // shadcn's generated primitives are vendored code: held to the type bar,
    // not to our formatting or boundary opinions.
    files: ["components/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];

export default eslintConfig;

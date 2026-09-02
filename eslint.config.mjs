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
    files: ["components/machine/**/*.{ts,tsx}"],
    rules: shadcnBoundary,
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

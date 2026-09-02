import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    // **-anchored so parallel-agent worktrees under .claude/ (which carry
    // their own node_modules and .next) are never crawled.
    exclude: ["**/node_modules/**", "**/.next/**", "**/.claude/**", "e2e/**", "out/**"],
    css: false,
  },
});

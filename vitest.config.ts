import { defineConfig } from "vitest/config";

export default defineConfig({
  // Some sandboxes have no `localhost` entry; bind the Vite server to 127.0.0.1
  // so the suite runs offline.
  server: { host: "127.0.0.1" },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "test/fixtures/**", "dist/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    api: false,
    reporters: ["default"],
  },
});

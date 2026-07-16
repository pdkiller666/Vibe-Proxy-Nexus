import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use a low scrypt N in the test environment to avoid hitting the sandbox's
    // memory limit. Production uses N=65536 (see src/lib/password.ts).
    env: {
      SCRYPT_N_OVERRIDE: "1024",
    },
  },
});

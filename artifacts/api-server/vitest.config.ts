import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share the development database. Run test files in
    // sequence so a fixture in one file cannot change global dashboard
    // counters while another file is comparing its API responses.
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The remote DB proxy adds multi-second variance per query — generous
    // timeouts keep slow-network runs from flaking on healthy code
    testTimeout: 30000,
    hookTimeout: 30000,
    // The test DB is remote (Railway proxy) with a tight connection cap —
    // parallel test files each open their own pg pool and the connection
    // storm causes random 15s timeouts. Serial files are slower but stable.
    fileParallelism: false,
  },
});

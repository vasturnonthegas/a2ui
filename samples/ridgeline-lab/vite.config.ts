import {fileURLToPath} from 'node:url';

import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// The API server (src/server.ts) owns the port and mounts Vite as middleware in dev, so
// this config only describes the client bundle.
export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});

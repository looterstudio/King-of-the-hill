import { defineConfig } from 'vite';

// dev: vite serves the client on :5173 and forwards the socket and API to the game server
export default defineConfig({
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': 'http://localhost:8787',
    },
  },
});

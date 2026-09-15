import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      // In sviluppo locale le funzioni serverless girano su un'altra porta
      // (`vercel dev`). In produzione frontend e API stanno sulla stessa origine.
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});

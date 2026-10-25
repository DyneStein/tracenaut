import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tracenaut from '@tracenaut/vite-plugin';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [tracenaut(), react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? 3001}`,
    },
  },
});

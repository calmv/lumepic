import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const port = process.env.PORT || loadEnv(mode, process.cwd(), '').PORT || '3000';
  const proxy = { target: `http://127.0.0.1:${port}`, changeOrigin: false };
  return {
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '^/(?:api|i|g)(?:/|$)': proxy,
        '^/random(?:[?]|$)': proxy,
      },
    },
  };
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: 'localhost',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (
            normalized.includes('/node_modules/react-dom/') ||
            normalized.includes('/node_modules/react/') ||
            normalized.includes('/node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          if (
            normalized.includes('/node_modules/react-markdown/') ||
            normalized.includes('/node_modules/remark-') ||
            normalized.includes('/node_modules/unified/') ||
            normalized.includes('/node_modules/micromark') ||
            normalized.includes('/node_modules/mdast-') ||
            normalized.includes('/node_modules/hast-') ||
            normalized.includes('/node_modules/vfile') ||
            normalized.includes('/node_modules/unist-')
          ) {
            return 'vendor-markdown';
          }
          if (normalized.includes('/node_modules/lucide-react/')) {
            return 'vendor-icons';
          }
          if (normalized.includes('/node_modules/zod/')) {
            return 'vendor-zod';
          }
          if (normalized.includes('/packages/voice/')) {
            return 'mj-voice';
          }
          if (normalized.includes('/packages/shared/')) {
            return 'mj-shared';
          }
          if (normalized.includes('/packages/ui/')) {
            return 'mj-ui';
          }
          return undefined;
        },
      },
    },
  },
});

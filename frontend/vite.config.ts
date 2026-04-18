import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  ...(command === 'serve' ? {
    server: {
      proxy: {
        '/api': 'http://localhost:3001',
      },
    },
  } : {}),
}));

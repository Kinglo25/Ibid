import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), basicSsl()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        taskpane: resolve(__dirname, 'taskpane.html')
      }
    }
  },
  server: {
    https: true,
    port: 3000
  }
});
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const apiPort = Number(process.env.IBID_API_PORT ?? 4000);

/**
 * Word loads the task pane in an embedded browser that checks the certificate against the
 * *operating system's* trust store — WebView2 uses Windows', WKWebView uses the Mac's. The
 * self-signed certificate basic-ssl generates is in neither, so desktop Word silently
 * refuses the pane where a normal browser would offer a warning to click past. That
 * certificate also claims Code Signing and Certificate Sign, far more authority than a
 * throwaway localhost certificate should hold, so trusting it to work around this would be
 * the wrong fix.
 *
 * `npx office-addin-dev-certs install` issues a TLS-only localhost certificate from a local
 * CA instead. Where those files exist we serve them, so a developer who has trusted that CA
 * once gets a pane that loads in desktop Word. Where they do not, basic-ssl still covers
 * Word on the web and `npm run dev` keeps working with no setup at all.
 */
const devCertDir = join(homedir(), '.office-addin-dev-certs');
const certFile = join(devCertDir, 'localhost.crt');
const keyFile = join(devCertDir, 'localhost.key');
const useDevCerts = existsSync(certFile) && existsSync(keyFile);

export default defineConfig({
  plugins: [react(), ...(useDevCerts ? [] : [basicSsl()])],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        taskpane: resolve(__dirname, 'taskpane.html'),
        commands: resolve(__dirname, 'commands.html')
      }
    }
  },
  server: {
    https: useDevCerts ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : true,
    port: 3000,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
});

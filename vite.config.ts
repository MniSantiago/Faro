import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3200',
        // El API solo acepta su propio Host/Origin: el proxy de desarrollo se presenta como 127.0.0.1:3200.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            const origin = req.getHeader('origin');
            if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173') req.setHeader('origin', 'http://127.0.0.1:3200');
          });
        },
      },
    },
  },
});

import { defineConfig } from 'vite';
const target = 'http://127.0.0.1:5180';
const proxy = { target, changeOrigin: true, configure(server: any) {
  server.on('proxyReq', (request: any) => { request.setHeader('origin', target); });
} };
export default defineConfig({
  plugins: [{ name: 'local-preview-origin', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.headers.origin && !['http://127.0.0.1:5181','http://localhost:5181'].includes(req.headers.origin)) { res.statusCode = 403; res.end('origin_not_allowed'); return; }
      next();
    });
  } }],
  server: { host: '127.0.0.1', port: 5181, strictPort: true,
    proxy: { '/api': proxy, '/assets': proxy } },
  build: { rollupOptions: { input: { index: 'index.html', player: 'player.html' } } }
});

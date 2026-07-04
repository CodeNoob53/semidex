import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/admin/ui-src',
  base: '/',
  build: {
    outDir: '../ui',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) return 'app.css';
          return 'assets/[name][extname]';
        },
      },
    },
  },
});

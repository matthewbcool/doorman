import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Doorman',
        short_name: 'Doorman',
        description: 'A privacy-first AI concierge for the front door.',
        theme_color: '#101714',
        background_color: '#f3f1e8',
        display: 'standalone',
        start_url: '/',
      },
    }),
  ],
  build: {
    outDir: 'dist',
  },
});


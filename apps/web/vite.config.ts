import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // main.tsx 가 http(s) 일 때만 등록 (Electron file:// 제외)
      manifest: {
        name: 'viewed', short_name: 'viewed', display: 'standalone', start_url: '.',
        theme_color: '#111111', background_color: '#111111',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
    }),
  ],
});

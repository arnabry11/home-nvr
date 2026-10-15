import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '');
  // The dev compose override publishes go2rtc, MediaMTX and the live service on localhost.
  const go2rtcTarget = environment.VITE_GO2RTC_URL || 'http://localhost:1984';
  const playbackTarget = environment.VITE_PLAYBACK_URL || 'http://localhost:9996';
  const liveTarget = environment.VITE_LIVE_URL || 'http://localhost:8082';

  return {
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          // Never let the service worker answer API or media requests.
          navigateFallbackDenylist: [/^\/api\//],
        },
        manifest: {
          name: 'Home NVR',
          short_name: 'NVR',
          description: 'Live view and playback for the home cameras.',
          theme_color: '#08111d',
          background_color: '#08111d',
          display: 'standalone',
        },
      }),
    ],
    server: {
      proxy: {
        '/api/go2rtc': {
          target: go2rtcTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/go2rtc/, ''),
        },
        '/api/mediamtx': {
          target: playbackTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/mediamtx/, ''),
        },
        '/api/live': {
          target: liveTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});

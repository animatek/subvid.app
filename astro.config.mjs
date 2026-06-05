// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Production URL — required for absolute canonical/hreflang/OG URLs and the
  // sitemap. Update this if the site is served from a different domain.
  site: 'https://subvid.app',
  output: 'server',
  // Use Node in local dev so /api/transcode-mp4 can call the system ffmpeg.
  // Production builds keep the original Cloudflare Workers adapter.
  adapter: process.env.npm_lifecycle_event === 'dev' ? node({ mode: 'standalone' }) : cloudflare(),
  i18n: {
    locales: ['en', 'es'],
    defaultLocale: 'en',
    routing: {
      prefixDefaultLocale: false
    }
  },
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en', es: 'es' }
      }
    })
  ],
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ['mediabunny']
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    worker: {
      format: 'es'
    }
  }
});
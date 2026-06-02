// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  // The site stays fully static (pages are prerendered by default). The
  // Cloudflare adapter is wired in so the build targets the Workers runtime and
  // future on-demand routes (set `export const prerender = false`) work without
  // extra setup.
  adapter: cloudflare(),
  vite: {
    plugins: [tailwindcss()],
    worker: {
      format: 'es'
    }
  }
});
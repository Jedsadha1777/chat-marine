export default defineNuxtConfig({
  compatibilityDate: '2026-03-16',

  srcDir: 'app/',

  routeRules: {
    '/**': { ssr: false },
  },

  app: {
    head: {
      title: 'Compatibility Matrix Demo',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Thai:wght@300;400;500;600&display=swap',
        },
      ],
    },
  },
})

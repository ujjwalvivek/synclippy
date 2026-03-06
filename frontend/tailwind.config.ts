import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,svelte}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Mono"', 'Menlo', 'monospace'],
        sans: ['"JetBrains Mono"', '"Fira Mono"', 'Menlo', 'monospace'],
      },
      colors: {
        background: '#0a0a0a',
        foreground: '#f5f5f5',
        muted: '#8f8f8f',
        border: '#27272a',
        accent: '#3f3f46',
        'accent-fg': '#fafafa',
      },
    },
  },
  plugins: [],
} satisfies Config

import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        cadre: {
          50: '#f0f4ff',
          100: '#dde5ff',
          200: '#c3cffe',
          300: '#9aadfd',
          400: '#6c84fa',
          500: '#4a5cf6',
          600: '#3640eb',
          700: '#2d32d0',
          800: '#292ca8',
          900: '#272d84',
          950: '#181a4e',
        },
      },
    },
  },
  plugins: [],
}
export default config

/** @type {import('tailwindcss').Config} */

// Every color the app uses resolves to a CSS variable (see src/index.css), so the light and dark
// themes are two sets of values rather than two sets of class names. Components keep writing
// bg-gray-900 / text-brand-400; the theme decides what those mean.
const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const scale = name => Object.fromEntries(STOPS.map(s => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]))

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        gray: scale('gray'),
        brand: scale('brand'),
        green: scale('green'),
        red: scale('red'),
        amber: scale('amber'),
        yellow: scale('yellow'),
        orange: scale('orange'),
        blue: scale('blue'),
        purple: scale('purple'),
        // "white" is the strongest text color: ink in the light theme, white in the dark one.
        white: 'rgb(var(--ink) / <alpha-value>)',
        // Text on solid accent fills (buttons, badges), and true white where it must stay white.
        onaccent: '#ffffff',
        paper: '#ffffff',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

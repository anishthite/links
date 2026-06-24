/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'monospace'],
      },
      colors: {
        // Stone palette pinned here for clarity — Swiss neutrals.
        // Tailwind already has these but we want explicit refs in code.
        swiss: {
          red: '#C8102E',
          bg: '#fafaf9',   // stone-50
          paper: '#f5f5f4', // stone-100
          ink: '#1c1917',  // stone-900
        },
      },
    },
  },
  plugins: [],
};

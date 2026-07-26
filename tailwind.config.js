/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        paper: '#f8fafc',
        accent: '#0e7490',
        positive: '#047857',
        negative: '#b91c1c',
        warn: '#b45309',
      },
    },
  },
  plugins: [],
};

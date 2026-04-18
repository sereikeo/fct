/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#f3efe6',
        'paper-2': '#ebe5d6',
        'paper-3': '#e2dac6',
        ink: '#131211',
        'ink-2': '#3a342b',
        mute: '#8a8275',
        accent: '#c7442b',
        green: '#2e6a3a',
        cc: '#5b3b8a',
        maple: '#6b3fa0',
        personal: '#1f4f7a',
      },
      borderRadius: {
        DEFAULT: '14px',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        serif: ['Instrument Serif', 'serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};

import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "rgb(var(--site-accent) / <alpha-value>)",
          hover: "rgb(var(--site-soft) / <alpha-value>)",
          light: "rgb(var(--site-soft) / <alpha-value>)",
          deep: "rgb(var(--site-accent) / <alpha-value>)"
        },
        ink: "rgb(var(--site-ink) / <alpha-value>)",
        "ink-2": "rgb(var(--site-ink) / <alpha-value>)",
        muted: "rgb(var(--site-muted) / <alpha-value>)",
        faint: "rgb(var(--site-muted) / <alpha-value>)",
        edge: "rgb(var(--site-edge) / <alpha-value>)",
        "edge-strong": "rgb(var(--site-edge) / <alpha-value>)",
        "bg-gray": "rgb(var(--site-bg) / <alpha-value>)",
        up: "#e23d3d",
        down: "#0fa07b",
        "up-bg": "#fdeeee",
        "down-bg": "#e8f8f3"
      },
      borderRadius: {
        card: "20px"
      },
      boxShadow: {
        card: "0 1px 2px rgba(10,14,25,.04), 0 8px 24px rgba(10,14,25,.05)",
        pop: "0 10px 40px rgba(10,14,25,.14)"
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Helvetica Neue"',
          "Arial",
          "sans-serif"
        ],
        logo: [
          '"AWS Diatype Rounded Semi Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace"
        ]
      }
    }
  },
  plugins: []
};

export default config;

import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#6b7280",
          hover: "#e9ebee",
          light: "#f1f3f5",
          deep: "#3f4652"
        },
        ink: "#0a0e19",
        "ink-2": "#404754",
        muted: "#6b7280",
        faint: "#9aa1ab",
        edge: "#dfe2e8",
        "edge-strong": "#c9ced8",
        "bg-gray": "#f7f8fa",
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

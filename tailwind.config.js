/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "var(--color-background-primary)",
          2: "var(--color-background-secondary)",
          3: "var(--color-background-tertiary)",
          info: "var(--color-background-info)",
          success: "var(--color-background-success)",
          warning: "var(--color-background-warning)",
          danger: "var(--color-background-danger)",
        },
        line: {
          DEFAULT: "var(--color-border-tertiary)",
          strong: "var(--color-border-secondary)",
          success: "var(--color-border-success)",
          danger: "var(--color-border-danger)",
        },
        ink: {
          DEFAULT: "var(--color-text-primary)",
          2: "var(--color-text-secondary)",
          3: "var(--color-text-tertiary)",
          info: "var(--color-text-info)",
          success: "var(--color-text-success)",
          warning: "var(--color-text-warning)",
          danger: "var(--color-text-danger)",
        },
        accent: "var(--color-accent)",
      },
      borderRadius: {
        lg: "10px",
        md: "6px",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        base: ["13px", "1.4"],
      },
    },
  },
  plugins: [],
};

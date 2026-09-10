import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: "#0A0724",
          gold: "#E2D243",
          lightGrey: "#F2F2F2",
          white: "#FFFFFF",
          black: "#000000",
        },
        // Webflow CSS variables mapped
        section: {
          bg1: "#090822",
          bg2: "#04030e",
          bg3: "#050411",
        },
        card: {
          dark: "#12122b",
          black: "#010101",
        },
        accent: {
          gold: "#ffe627",
          goldDark: "#968929",
          goldLight: "#d1b933",
          goldMuted: "#665f20",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "14px",
      },
      backgroundImage: {
        "gradient-gold": "linear-gradient(to right, #5e5521, #d1b933)",
        "gradient-section": "linear-gradient(to bottom, #090822, #04030e)",
        "gradient-card": "linear-gradient(140deg, #0a0923, #4c47a4)",
      },
      boxShadow: {
        glow: "0 0 175px 45px rgba(216, 196, 64, 0.5)",
        "glow-sm": "0 0 120px 45px rgba(216, 196, 64, 0.5)",
      },
    },
  },
  plugins: [],
};

export default config;

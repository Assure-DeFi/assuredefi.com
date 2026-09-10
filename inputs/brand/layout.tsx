import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { OrganizationSchema, WebSiteSchema } from "@/components/StructuredData";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://assuredefi.com"),
  title: "KYC Verification For Project Owners | Assure DeFi®",
  description:
    "Build investor trust with the Verification Gold Standard®. Empower your project with Assure DeFi®.",
  icons: {
    icon: "/images/favicon.png",
    apple: "/images/favicon.png",
  },
  openGraph: {
    title: "KYC Verification For Project Owners | Assure DeFi®",
    description:
      "Build investor trust with the Verification Gold Standard®. Empower your project with Assure DeFi®.",
    images: ["/images/Assure-brand.webp"],
    url: "https://assuredefi.com",
    siteName: "Assure DeFi®",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "KYC Verification For Project Owners | Assure DeFi®",
    description:
      "Build investor trust with the Verification Gold Standard®. Empower your project with Assure DeFi®.",
    images: ["/images/Assure-brand.webp"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <OrganizationSchema />
        <WebSiteSchema />
      </head>
      <body className={`${inter.variable} font-sans`}>{children}</body>
    </html>
  );
}

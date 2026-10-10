import type { Metadata } from "next";
import { Geist, Newsreader } from "next/font/google";
import { AuthProvider } from "@/lib/auth";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Gene symbols are set in italic by convention.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["italic"],
  weight: ["500"],
});

export const metadata: Metadata = {
  title: "GeneX — Spatial Gene Expression Prediction",
  description:
    "Predict spatial gene expression from H&E histology sections. MDS19 · mclSTExp · HER2+ breast cancer.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${newsreader.variable} h-full antialiased`}
    >
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

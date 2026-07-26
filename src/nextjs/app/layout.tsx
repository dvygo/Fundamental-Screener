import type { Metadata } from "next";
import { Google_Sans, Google_Sans_Code } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import Sidebar from "@/components/Sidebar";
import BottomNav from "@/components/BottomNav";
import RouteCleanup from "@/components/RouteCleanup";
import "./globals.css";

const googleSans = Google_Sans({
  variable: "--font-google-sans",
  subsets: ["latin"],
});

const googleSansCode = Google_Sans_Code({
  variable: "--font-google-sans-code",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fundamental Screener",
  description: "Layer A market screens over NSE bhavcopy",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${googleSans.variable} ${googleSansCode.variable} h-full antialiased`}
    >
      <body className="h-full">
        <ThemeProvider>
          <RouteCleanup />
          {/* Fixed viewport height (dvh handles mobile browser chrome). Desktop:
              sidebar + main in a row. Mobile: main + bottom bar in a column. Only
              <main> scrolls; the nav stays pinned. */}
          <div className="flex h-[100dvh] flex-col overflow-hidden bg-white text-neutral-900 md:flex-row">
            <Sidebar />
            <main className="min-h-0 flex-1 overflow-auto p-4">{children}</main>
            <BottomNav />
          </div>
          <Toaster position="top-right" duration={1000} />
        </ThemeProvider>
      </body>
    </html>
  );
}

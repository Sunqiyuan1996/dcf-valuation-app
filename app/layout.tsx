import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Valuation Analysis — DCF Fair Value Tool',
  description: "McKinsey-style ROIC/NOPAT discounted cash flow valuation, compared against current market cap.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Quant Platform',
  description: 'AI-powered paper trading research platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          background: '#0f0f13',
          color: '#e2e8f0',
        }}
      >
        {children}
      </body>
    </html>
  );
}

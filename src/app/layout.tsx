import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Minimi",
  description: "A persistent, time-aware AI research assistant.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {clerkConfigured ? (
          <ClerkProvider>
            {children}
          </ClerkProvider>
        ) : (
          <main className="auth-screen">
            <section className="auth-card">
              <span className="brand-mark auth-brand-mark"><span /><span /><span /></span>
              <h1>Connect Clerk to continue</h1>
              <p>Add <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> and <code>CLERK_SECRET_KEY</code> to your local environment, then restart Minimi.</p>
              <p className="auth-help">Use the selected Clerk application. Keep the secret key server-side and never commit it.</p>
            </section>
          </main>
        )}
      </body>
    </html>
  );
}

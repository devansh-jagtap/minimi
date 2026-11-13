"use client";

import { SignInButton, SignUpButton, useAuth } from "@clerk/nextjs";

import ChatWorkspace from "./chat-workspace";

export default function AuthGate() {
  const { isLoaded, userId } = useAuth();

  if (!isLoaded) {
    return <main className="auth-screen"><p>Loading your secure workspace…</p></main>;
  }

  if (!userId) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <span className="brand-mark auth-brand-mark"><span /><span /><span /></span>
          <h1>Your research, kept private</h1>
          <p>Sign in to keep your conversations and research memory attached to your account.</p>
          <div className="auth-actions">
            <SignInButton mode="modal"><button className="auth-primary">Sign in</button></SignInButton>
            <SignUpButton mode="modal"><button className="auth-secondary">Create account</button></SignUpButton>
          </div>
        </section>
      </main>
    );
  }

  return <ChatWorkspace key={userId} userId={userId} />;
}

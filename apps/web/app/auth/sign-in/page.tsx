"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../../../lib/auth-client";
import "../../live-workspace.css";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = sent
        ? await authClient.signIn.emailOtp({ email: email.trim(), otp })
        : await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
      if (result.error) throw new Error(result.error.message ?? "Sign-in failed. Please try again.");
      if (sent) window.location.assign("/dashboard");
      else setSent(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Authentication service unavailable"); }
    finally { setBusy(false); }
  }
  return <main className="login-shell"><div className="login-panel">
    <a className="live-brand" href="/">DS <span>SALESROOM</span></a>
    <p className="eyebrow">Death Of The Salesman</p>
    <h1>Your next move starts here.</h1>
    <p className="muted">Sign in to your private sales and fundraising workspace with a code sent to your owner email.</p>
    <form onSubmit={submit} className="live-form">
      <label htmlFor="email">Owner email</label>
      <input id="email" type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} required disabled={sent || busy} />
      {sent && <><p role="status">Check your inbox for the verification code.</p><label htmlFor="otp">Verification code</label>
        <input id="otp" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={e=>setOtp(e.target.value)} required autoFocus maxLength={8} /></>}
      {error && <p role="alert" className="live-error">{error}</p>}
      <button disabled={busy} className="live-primary">{busy ? "Please wait…" : sent ? "Open workspace" : "Send sign-in code"}</button>
      {sent && <button type="button" onClick={()=>{setSent(false);setOtp("");setError("");}} className="live-secondary">Use a different email or request a new code</button>}
    </form>
    <p className="login-foot">Private owner access · Neon Auth · $0 execution cap</p>
  </div></main>;
}

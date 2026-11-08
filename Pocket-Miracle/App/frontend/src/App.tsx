import { useState, type FormEvent } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./account";
import { Glyph, Spinner } from "./ui";

export function WelcomeMark() {
  return <svg className="welcome-mark" viewBox="0 0 80 80" fill="none" aria-hidden="true"><path d="M28 61V23c0-8 23-8 23 0v4H38" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/><path d="M28 49v12" stroke="#e7aba3" strokeWidth="5" strokeLinecap="round"/><circle cx="40" cy="40" r="36" stroke="currentColor" strokeOpacity=".16"/></svg>;
}
export default function AuthScreen() {
  const { recovery, finishRecovery, authError } = useAuth();
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(authError);
  const [message, setMessage] = useState("");
  const signup = mode === "signup" && !recovery;
  const reset = mode === "reset" && !recovery;
  function changeMode(next: typeof mode) { setMode(next); setError(""); setMessage(""); setPassword(""); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (recovery) {
        const { error: failure } = await supabase.auth.updateUser({ password });
        if (failure) throw failure;
        finishRecovery();
      } else if (reset) {
        const { error: failure } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
        if (failure) throw failure;
        setMessage("If this email has an account, you’ll receive a password reset link.");
      } else if (signup) {
        const { data, error: failure } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim() }, emailRedirectTo: window.location.origin } });
        if (failure) throw failure;
        if (!data.session) { setPassword(""); setMessage("Check your email to confirm your account, then come back and log in."); }
      } else {
        const { error: failure } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (failure) throw failure;
      }
    } catch (cause) { setError((cause as Error).message || "Could not connect. Please try again."); }
    finally { setBusy(false); }
  }
  return <main className="auth-shell"><div className="auth-page">
    <header className="auth-brand"><WelcomeMark /><span>pocket miracle<span className="auth-brand-dot">.</span></span></header>
    <div className="auth-intro" key={recovery ? "recovery" : mode}><span className="overline">A LITTLE MORE INDEPENDENCE</span><h1>{recovery ? "A fresh start." : signup ? "Your next chapter." : reset ? "Let’s get you back in." : <>Everyday,<br /><span>with confidence.</span></>}</h1><p>{recovery ? "Choose a new password for your account." : signup ? "Create your account to keep your preferences and detection history together." : reset ? "We’ll send a link to reset your password." : "Your smart cane companion. Your preferences, your surroundings, your peace of mind."}</p></div>
    <section className="auth-card" aria-label={signup ? "Create an account" : "Account access"}>
      {!reset && !recovery && <div className="auth-tabs" data-signup={signup}><span className="auth-tab-indicator" aria-hidden="true" /><button type="button" aria-pressed={!signup} onClick={() => changeMode("login")} disabled={busy}>Log in</button><button type="button" aria-pressed={signup} onClick={() => changeMode("signup")} disabled={busy}>Sign up</button></div>}
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          {signup && <label className="auth-field">Your name<input autoComplete="name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} placeholder="How should we call you?" /></label>}
          {!recovery && <label className="auth-field">Email address<input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required placeholder="you@example.com" /></label>}
          {!reset && <label className="auth-field">Password<div className="password-field"><input type={showPassword ? "text" : "password"} autoComplete={signup || recovery ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} minLength={signup || recovery ? 8 : 1} maxLength={128} required placeholder={signup || recovery ? "At least 8 characters" : "Your password"} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></label>}
        </fieldset>
        {error && <p className="auth-feedback error" role="alert">{error}</p>}
        {message && <p className="auth-feedback" role="status">{message}</p>}
        <button type="submit" className="auth-submit" disabled={busy} aria-busy={busy}>{busy ? "Please wait…" : recovery ? "Save new password" : signup ? "Create account" : reset ? "Send reset link" : "Log in"}{busy ? <Spinner /> : <Glyph name="arrow" />}</button>
      </form>
      {!signup && !recovery && <button className="auth-text-button" type="button" onClick={() => changeMode(reset ? "login" : "reset")} disabled={busy}>{reset ? "Back to log in" : "Forgot your password?"}</button>}
    </section>
    <p className="auth-footer"><Glyph name="shield" size={16} />Your preferences. Your own space.</p>
  </div></main>;
}

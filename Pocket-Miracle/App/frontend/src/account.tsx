import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

type AuthState = { session: Session | null; loading: boolean; recovery: boolean; finishRecovery: () => void; authError: string };
const AuthContext = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);
  const [authError, setAuthError] = useState("");
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      receivedEvent = true;
      if (!active) return;
      setSession(next); setLoading(false);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_OUT") setRecovery(false);
    });
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active || receivedEvent) return;
      setSession(data.session); setLoading(false);
      if (error) setAuthError(error.message);
    }).catch(() => { if (active) { setLoading(false); setAuthError("Could not restore your session. Please log in again."); } });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  return <AuthContext.Provider value={{ session, loading, recovery, finishRecovery: () => setRecovery(false), authError }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider missing");
  return value;
}

export type Settings = { voice_enabled: boolean; volume: number; large_text: boolean; reduce_motion: boolean; automatic_reconnect: boolean; warning_distance_cm: number; warning_confidence: number };
type AccountState = { settings: Settings | null; loading: boolean; error: string; saving: boolean; displayName: string; updateSettings: (next: Partial<Settings>) => void; retry: () => void; flush: () => Promise<void> };
const AccountContext = createContext<AccountState | null>(null);
export function AccountProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const user = session!.user;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [displayName, setDisplayName] = useState(user.email?.split("@")[0] || "there");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const latest = useRef<Settings | null>(null);
  const pending = useRef(false);
  const chain = useRef(Promise.resolve());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    void (async () => {
      try {
        const initial = await supabase.from("app_settings").select("*").eq("user_id", user.id).maybeSingle();
        if (initial.error) throw initial.error;
        let row = initial.data;
        if (!row) {
          const inserted = await supabase.from("app_settings").upsert({ user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true });
          if (inserted.error) throw inserted.error;
          const fetched = await supabase.from("app_settings").select("*").eq("user_id", user.id).single();
          if (fetched.error) throw fetched.error;
          row = fetched.data;
        }
        const profile = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
        if (!cancelled) {
          const value = pickSettings(row);
          latest.current = value; setSettings(value);
          if (profile.data?.display_name) setDisplayName(profile.data.display_name);
        }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : (cause as {message?:string}).message || "Could not load your account."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [user.id, reload]);

  function updateSettings(next: Partial<Settings>) {
    if (!latest.current) return;
    latest.current = { ...latest.current, ...next };
    pending.current = true;
    setSaving(true);
    setSettings(latest.current); setRevision(value => value + 1);
  }
  function flush() {
    if (!latest.current || !pending.current) return chain.current;
    const snapshot = latest.current;
    pending.current = false;
    setSaving(true);
    chain.current = chain.current.catch(() => {}).then(async () => {
      const { error: failure } = await supabase.from("app_settings").update(snapshot).eq("user_id", user.id).select("id").single();
      if (failure) {
        pending.current = true;
        if (alive.current) setError(`Preferences not saved: ${failure.message}`);
        throw new Error(failure.message);
      }
      if (alive.current) setError("");
    }).finally(() => { if (alive.current) setSaving(false); });
    return chain.current;
  }
  useEffect(() => {
    if (!revision) return;
    const timer = window.setTimeout(() => { void flush().catch(() => {}); }, 500);
    return () => window.clearTimeout(timer);
  }, [revision]);
  return <AccountContext.Provider value={{ settings, loading, error, saving, displayName, updateSettings,
    retry: () => { if (settings) void flush().catch(() => {}); else setReload(value => value + 1); }, flush }}>{children}</AccountContext.Provider>;
}
function pickSettings(row: Settings): Settings {
  return { voice_enabled: row.voice_enabled, volume: row.volume, large_text: row.large_text, reduce_motion: row.reduce_motion, automatic_reconnect: row.automatic_reconnect, warning_distance_cm: Number(row.warning_distance_cm), warning_confidence: Number(row.warning_confidence) };
}
export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountProvider missing");
  return value;
}

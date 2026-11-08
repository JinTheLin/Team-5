import App from "./App";
import AuthScreen, { WelcomeMark } from "./AuthScreen";
import { AccountProvider, useAccount, useAuth } from "./account";
import { VisionProvider } from "./vision";
import { supabase } from "./supabase";
import { Spinner } from "./ui";

function Loading({ message }: { message: string }) {
  return <main className="auth-shell"><div className="auth-loading" role="status"><WelcomeMark /><span className="inline-loading"><Spinner />{message}</span></div></main>;
}
function UserApp() {
  const { loading, settings, error, retry } = useAccount();
  if (loading) return <Loading message="Getting your preferences…" />;
  if (!settings) return <main className="auth-shell"><div className="auth-card"><h1>Let’s reconnect.</h1><p role="alert">{error || "Could not load your account."}</p><button className="auth-submit" onClick={retry}>Try again</button><button className="auth-text-button" onClick={() => void supabase.auth.signOut({ scope: "local" })}>Log out</button></div></main>;
  return <VisionProvider><App /></VisionProvider>;
}
export default function Root() {
  const { session, loading, recovery } = useAuth();
  if (loading) return <Loading message="Opening Pocket Miracle…" />;
  if (!session || recovery) return <AuthScreen />;
  return <AccountProvider key={session.user.id}><UserApp /></AccountProvider>;
}

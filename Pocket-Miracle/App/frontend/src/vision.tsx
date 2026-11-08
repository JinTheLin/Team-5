import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useAuth } from "./account";

export const VISION_URL = (import.meta.env.VITE_VISION_URL || "http://127.0.0.1:8765").replace(/\/$/, "");
export type VisionStatus = {
  phase: "idle" | "loading" | "waiting" | "live" | "error" | "stopped";
  detail: string;
  session_id: string | null;
  frame_id: number;
  mode?: "cane" | "webcam";
  host?: string;
  send_warnings?: boolean;
  simulated?: boolean;
  sonar_cm?: number | null;
  sonar_fresh?: boolean;
  cane_on?: boolean | null;
  inference_ms?: number | null;
  voice_status?: string;
  shared_busy?: boolean;
  history_sync?: { pending: number; error: string };
  detections: { name: string; confidence: number; ahead: boolean; eligible: boolean }[];
  last_warning: { message: string; at: number; simulated: boolean } | null;
};
type Config = { mode: "cane" | "webcam"; host: string; simulated_cm: number | null; send_warnings: boolean };
type Connection = { status: VisionStatus | null; connected: boolean; busy: boolean; error: string; command: (action: "start" | "stop" | "disconnect", config?: Config) => Promise<void> };
const VisionContext = createContext<Connection | null>(null);

export function VisionProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const account = useAccount();
  const token = useRef(session?.access_token || "");
  token.current = session?.access_token || "";
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let controller: AbortController | null = null;
    async function poll() {
      const requestRevision = revision.current;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 2000);
      try {
        const response = await fetch(`${VISION_URL}/api/status`, { headers: { Authorization: `Bearer ${token.current}` }, signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Vision service unavailable");
        const next: VisionStatus = await response.json();
        if (!stopped && requestRevision === revision.current) { setStatus(next); setConnected(true); }
      } catch {
        if (!stopped && requestRevision === revision.current) { setConnected(false); setStatus(null); }
      } finally {
        window.clearTimeout(timeout);
        if (!stopped) timer = window.setTimeout(poll, 500);
      }
    }
    void poll();
    return () => {
      stopped = true; window.clearTimeout(timer); controller?.abort();
      void fetch(`${VISION_URL}/api/disconnect`, { method: "POST", headers: { Authorization: `Bearer ${token.current}`, "Content-Type": "application/json" }, body: "{}", keepalive: true }).catch(() => {});
    };
  }, []);

  // Say each new warning on this laptop too, since the cane's speaker is quiet.
  // Uses the browser's built-in voice and follows the "Voice announcements" setting.
  const voiceOn = account.settings?.voice_enabled ?? false;
  const warning = status?.last_warning;
  const spokenAt = useRef<number | null>(null);
  useEffect(() => {
    if (!warning || warning.at === spokenAt.current) return;
    spokenAt.current = warning.at;
    const fresh = Date.now() / 1000 - warning.at < 5;  // don't replay an old warning after a page reload
    if (!voiceOn || !fresh || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();  // a newer warning cuts off an older one, like on the cane
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(warning.message));
  }, [warning, voiceOn]);

  async function command(action: "start" | "stop" | "disconnect", config?: Config) {
    revision.current += 1;
    setBusy(true); setError("");
    try {
      if (action === "start") await account.flush();
      const response = await fetch(`${VISION_URL}/api/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.current}` },
        body: JSON.stringify(config || {}), signal: AbortSignal.timeout(10000),
      });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || "Could not update detection.");
      revision.current += 1;
      setStatus(next); setConnected(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not reach the laptop service."); }
    finally { setBusy(false); }
  }
  return <VisionContext.Provider value={{ status, connected, busy, error, command }}>{children}</VisionContext.Provider>;
}

export function useVision() {
  const context = useContext(VisionContext);
  if (!context) throw new Error("VisionProvider is missing");
  return context;
}

export function VisionImage({ status, alt }: { status: VisionStatus; alt: string }) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [src, setSrc] = useState("");
  const currentUrl = useRef("");
  useEffect(() => {
    if (!accessToken) { setSrc(""); return; }
    const controller = new AbortController();
    void fetch(`${VISION_URL}/api/frame.jpg?session=${status.session_id}&frame=${status.frame_id}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("No current frame");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = url; setSrc(url);
    }).catch(() => { if (!controller.signal.aborted) setSrc(""); });
    return () => controller.abort();
  }, [status.session_id, status.frame_id, accessToken]);
  useEffect(() => () => { if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); }, []);
  return src ? <img src={src} alt={alt} /> : <div className="camera-mini-empty">Waiting for a processed frame…</div>;
}

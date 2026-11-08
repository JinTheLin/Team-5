import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "./account";
import { VISION_URL, VisionImage, useVision, type VisionStatus } from "./vision";
import { Glyph, Spinner } from "./ui";

export type Person = { id: string; email: string | null };
export type Alert = { id: string; kind: "sos"; at: number; location: { lat: number; lng: number; accuracy: number } | null; delivered_to: number };
export type LiveView = { state: "requested" | "active"; reason: "request" | "sos"; requested_at: number; expires_at: number | null; by: Person };
export type UserCare = { code: { code: string; expires_at: number } | null; caretakers: Person[]; live: LiveView | null; alerts: Alert[] };
type CaretakerView = { linked: Person | null; alerts?: Alert[]; live?: LiveView | null; detection_running?: boolean; camera?: Pick<VisionStatus, "phase" | "detail" | "session_id" | "frame_id" | "detections" | "last_warning" | "sonar_cm" | "sonar_fresh"> };

export const nameOf = (person: Person | null | undefined) => person?.email?.split("@")[0] || "your contact";
const time = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const mapLink = (location: NonNullable<Alert["location"]>) => `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=18/${location.lat}/${location.lng}`;

// Spoken prompts, so a blind user hears the link code and camera requests without reading the screen.
let lastSpoken = { text: "", at: 0 };
export function speak(text: string) {
  // Queue (never cut off what's playing) and skip a repeat of the same sentence within 5 s.
  if (text === lastSpoken.text && Date.now() - lastSpoken.at < 5000) return;
  lastSpoken = { text, at: Date.now() };
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    speechSynthesis.speak(utterance);
  } catch { /* speech unavailable */ }
}
const spokenCode = (code: string) => code.split("").join(", ");
export const speakCode = (code: string) => speak(`Your link code is ${spokenCode(code)}. Again: ${spokenCode(code)}.`);

export async function careCall(token: string, path: string, body?: object) {
  const response = await fetch(`${VISION_URL}/api/care/${path}`, {
    method: body ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The laptop service could not do that.");
  return data;
}

function useCareAction() {
  const { session } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(path: string, body: object = {}) {
    setBusy(true); setError("");
    try { return await careCall(session!.access_token, path, body); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not reach the laptop service."); }
    finally { setBusy(false); }
  }
  return { busy, error, run };
}

// Caretaker mode is chosen per account on this device.
export function useCaretakerMode(): [boolean, (on: boolean) => void] {
  const { session } = useAuth();
  const key = `pocket-miracle:caretaker:${session?.user.id}`;
  const [on, setOn] = useState(() => { try { return localStorage.getItem(key) === "1"; } catch { return false; } });
  return [on, (next: boolean) => { setOn(next); try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* private mode */ } }];
}

// ---------------- User side ----------------

function useShareTone(active: boolean) {
  // The user hears a soft tone while their camera is shared (on start, then every 20 s).
  const context = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!active) return;
    function chime() {
      try {
        context.current ||= new AudioContext();
        const ctx = context.current, osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.frequency.value = 660; gain.gain.setValueAtTime(.12, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .35);
        osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .35);
      } catch { /* audio unavailable */ }
    }
    chime();
    const timer = window.setInterval(chime, 20000);
    return () => window.clearInterval(timer);
  }, [active]);
}

export function LiveShareBanner() {
  const { status } = useVision();
  const live = status?.care?.live;
  const { busy, error, run } = useCareAction();
  useShareTone(live?.state === "active");
  const state = live ? `${live.state}:${live.requested_at}` : "";
  const previous = useRef("");
  useEffect(() => {
    if (state === previous.current) return;
    const was = previous.current;
    previous.current = state;
    if (live?.state === "requested") speak(`${nameOf(live.by)} wants to see your camera. Choose Allow, or Not now.`);
    else if (live?.state === "active") speak(`${nameOf(live.by)} can now see your camera. Press Stop to end it.`);
    else if (was.startsWith("active")) speak("Camera sharing stopped.");
  }, [state]);
  if (!live) return null;
  if (live.state === "requested") return <div className="approval-card care-banner" role="alertdialog" aria-label="Live view request">
    <span className="approval-icon"><Glyph name="camera" size={19} /></span>
    <span><strong>{nameOf(live.by)} wants to see your camera</strong><small>They will see what the cane sees for up to 10 minutes. You can stop at any time.</small></span>
    <div className="care-choice"><button disabled={busy} onClick={() => void run("live/respond", { approve: true })}>Allow</button><button disabled={busy} className="care-decline" onClick={() => void run("live/respond", { approve: false })}>Not now</button></div>
    {error && <p className="vision-error" role="alert">{error}</p>}
  </div>;
  return <div className="sharing-status is-sharing care-banner" role="status">
    <span className="sharing-status-icon"><Glyph name="camera" size={18} /></span>
    <span><strong>{nameOf(live.by)} can see your camera</strong><small>{live.reason === "sos" ? "Started by your SOS." : "You allowed this."} Ends at {time(live.expires_at!)}. A tone plays while sharing.</small></span>
    <button className="care-stop" disabled={busy} onClick={() => void run("live/end")}>Stop</button>
  </div>;
}

export function useSos() {
  const { busy, error, run } = useCareAction();
  const [sent, setSent] = useState<Alert | null>(null);
  async function send() {
    const location = await new Promise<{ lat: number; lng: number; accuracy: number } | null>(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => resolve(null), { timeout: 5000, maximumAge: 60000 });
    });
    const result = await run("sos", location ? { location } : {});
    if (result) {
      setSent(result.alert);
      speak(`SOS sent to ${result.alert.delivered_to} caretaker${result.alert.delivered_to === 1 ? "" : "s"}${location ? " with your location" : ""}.`);
    }
  }
  return { busy, error, sent, send, reset: () => setSent(null) };
}

export function CaretakerSettings() {
  const { status, connected } = useVision();
  const care = status?.care;
  const { busy, error, run } = useCareAction();
  if (!connected || !care) return <div className="permission-note">Start the laptop service (npm run vision) to link a caretaker.</div>;
  return <div className="caretaker-settings">
    {care.caretakers.length ? care.caretakers.map(person => <div className="caretaker-profile" key={person.id}>
      <span>{nameOf(person).slice(0, 2).toUpperCase()}</span>
      <div><strong>{nameOf(person)}</strong><small>{person.email || "Linked caretaker"} · gets your SOS alerts</small></div>
      <button className="auth-text-button" disabled={busy} onClick={() => void run("unlink", { caretaker_id: person.id })} aria-label={`Remove ${nameOf(person)}`}>Remove</button>
    </div>) : <div className="caretaker-profile"><span>?</span><div><strong>No caretaker yet</strong><small>Share a code with someone you trust.</small></div></div>}
    <div className="settings-card care-code">
      {care.code ? <><small>Ask your caretaker to enter this code in caretaker mode</small><strong aria-label={`Code ${care.code.code.split("").join(" ")}`}>{care.code.code}</strong><small>Works once, until {time(care.code.expires_at)}</small></>
        : <small>A code links one caretaker account to you.</small>}
      {care.code && <button className="sheet-primary care-read" onClick={() => speakCode(care.code!.code)}>Read code aloud</button>}
      <button className="sheet-primary" disabled={busy} onClick={() => void run("code").then(result => { if (result?.code) speakCode(result.code); })}>{busy ? <Spinner /> : null}{care.code ? "New code" : "Create link code"}</button>
    </div>
    {error && <p className="vision-error" role="alert">{error}</p>}
    <div className="permission-note"><Glyph name="shield" size={20} />You stay in control. Your camera is shared only when you allow it or press SOS, a tone plays while it is shared, and you can stop it at any time.</div>
  </div>;
}

// ---------------- Caretaker side ----------------

const CaretakerContext = createContext<{ view: CaretakerView | null; connected: boolean } | null>(null);

export function CaretakerProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const token = useRef(session?.access_token || "");
  token.current = session?.access_token || "";
  const [view, setView] = useState<CaretakerView | null>(null);
  const [connected, setConnected] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    let stopped = false, timer = 0;
    async function poll() {
      try {
        const next: CaretakerView = await careCall(token.current, "status");
        if (stopped) return;
        const ids = new Set((next.alerts || []).map(a => a.id));
        if (seen.current) for (const alert of next.alerts || []) if (!seen.current.has(alert.id)) notify(next.linked, alert);
        seen.current = ids;
        setView(next); setConnected(true);
      } catch { if (!stopped) { setConnected(false); } }
      finally { if (!stopped) timer = window.setTimeout(poll, 1000); }
    }
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, []);
  return <CaretakerContext.Provider value={{ view, connected }}>{children}</CaretakerContext.Provider>;
}

function notify(person: Person | null, alert: Alert) {
  const body = `${nameOf(person)} pressed SOS at ${time(alert.at)}${alert.location ? "" : " (no location)"}.`;
  speak(`Alert. ${body}`);
  try { if ("Notification" in window && Notification.permission === "granted") new Notification("SOS alert", { body }); } catch { /* unsupported */ }
}

function useCaretaker() {
  const value = useContext(CaretakerContext);
  if (!value) throw new Error("CaretakerProvider missing");
  return value;
}

export function CaretakerHome() {
  const { view, connected } = useCaretaker();
  const { busy, error, run } = useCareAction();
  const [code, setCode] = useState("");
  const latest = view?.alerts?.[0];
  async function link(event: FormEvent) {
    event.preventDefault();
    if (await run("link", { code })) setCode("");
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  }
  if (!connected) return <div className="caretaker-hero"><div className="caretaker-clear"><Glyph name="shield" size={27} /><div><strong>Laptop service offline</strong><span>Start it with npm run vision.</span></div></div></div>;
  if (!view?.linked) return <form className="caretaker-hero" onSubmit={event => void link(event)}>
    <div className="caretaker-top"><span className="person-avatar">?</span><div><div className="device-title">Link to someone</div><div className="soft-status">Enter the 6-digit code from their app</div></div></div>
    <label className="vision-field care-code-field">Link code<input value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required placeholder="123456" /></label>
    <button className="sheet-primary care-link-button" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : null}Link</button>
    {error && <p className="vision-error" role="alert">{error}</p>}
  </form>;
  return <div className="caretaker-hero">
    <div className="caretaker-top"><span className="person-avatar">{nameOf(view.linked).slice(0, 1).toUpperCase()}</span><div><div className="device-title">{nameOf(view.linked)}’s Smart Cane</div><div className="soft-status">{view.detection_running ? <><span />Cane detection is running</> : "Cane detection is off"}</div></div></div>
    <div className="caretaker-clear"><Glyph name="shield" size={27} /><div>{latest ? <><strong>Last SOS at {time(latest.at)}</strong><span>{latest.location ? "Location shared · see Safety" : "No location was shared"}</span></> : <><strong>No alerts</strong><span>You’ll be notified here if they press SOS.</span></>}</div></div>
  </div>;
}

export function CaretakerSafety() {
  const { view } = useCaretaker();
  const { busy, run } = useCareAction();
  return <div className="screen">
    <header className="page-header"><div><div className="overline">SAFETY</div><div className="page-title">Shared safety</div></div></header>
    {!view?.linked ? <div className="location-empty"><Glyph name="shield" size={32} /><h2>Not linked yet</h2><p>Link from the Home tab with the code they share.</p></div>
      : !view.alerts?.length ? <div className="location-empty"><Glyph name="shield" size={32} /><h2>All quiet</h2><p>SOS alerts from {nameOf(view.linked)} appear here with their location.</p></div>
      : <div className="history-list">{view.alerts.map(alert => <div className="obstacle-alert care-alert" key={alert.id}><span><strong>SOS · {new Date(alert.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</strong>
        <small>{alert.location ? <a href={mapLink(alert.location)} target="_blank" rel="noreferrer">Open location on map (±{alert.location.accuracy} m)</a> : "No location shared"}</small></span></div>)}</div>}
    {view?.linked && <button className="auth-text-button care-unlink" disabled={busy} onClick={() => void run("unlink")}>Stop being {nameOf(view.linked)}’s caretaker</button>}
  </div>;
}

export function CaretakerCamera() {
  const { view } = useCaretaker();
  const { busy, error, run } = useCareAction();
  const live = view?.live, camera = view?.camera;
  return <div className="screen camera-screen">
    <header className="page-header"><div><div className="overline">LIVE VIEW</div><div className="page-title">{view?.linked ? `What ${nameOf(view.linked)} sees.` : "Live view"}</div></div>{live?.state === "active" && <span className="share-pill"><i />SHARED</span>}</header>
    <div className={`camera-view ${camera?.phase === "live" ? "camera-live" : "camera-paused"}`}>
      {camera?.phase === "live" && camera.session_id ? <VisionImage status={camera as VisionStatus} path="/api/care/frame.jpg" alt={`Live cane camera from ${nameOf(view?.linked)}, with detected objects outlined`} />
        : <div className="camera-empty"><span className="empty-emblem"><Glyph name="camera" size={32} /></span><strong>{!view?.linked ? "Not linked" : live?.state === "active" ? "Their camera is off" : live?.state === "requested" ? "Waiting for approval" : "Camera is private"}</strong>
          <small>{!view?.linked ? "Link from the Home tab first." : live?.state === "active" ? "Sharing is on, but cane detection isn’t running right now." : live?.state === "requested" ? `${nameOf(view.linked)} has to allow it on their phone.` : "You can ask to see it. They decide."}</small></div>}
      <span className="viewfinder-corner top-left" aria-hidden="true" /><span className="viewfinder-corner bottom-right" aria-hidden="true" />
    </div>
    {view?.linked && (live?.state === "active"
      ? <button className="camera-action stop" disabled={busy} onClick={() => void run("live/end")}><span className="stop-mark" aria-hidden="true" />End live view</button>
      : <button className="camera-action primary" disabled={busy || live?.state === "requested"} onClick={() => void run("live/request")}>{busy ? <Spinner /> : <Glyph name="camera" size={19} />}{live?.state === "requested" ? "Request sent" : "Ask to see their camera"}</button>)}
    {live?.state === "active" && <p className="vision-note">Ends automatically at {time(live.expires_at!)}.</p>}
    {error && <p className="vision-error" role="alert">{error}</p>}
    {camera?.phase === "live" && <>
      <div className="camera-section-title"><span>What the cane sees</span><small>{camera.sonar_fresh && camera.sonar_cm != null ? `Sonar ${camera.sonar_cm.toFixed(0)} cm` : "No sonar reading"}</small></div>
      <div className="detection-list">{camera.detections.length ? camera.detections.map((d, i) => <div className="detection-item" key={`${d.name}-${i}`}><span className="detection-symbol" aria-hidden="true">{d.ahead ? "↑" : "↗"}</span><span><strong>{d.name}</strong><small>{d.ahead ? "Ahead" : "Off to the side"}</small></span><span><strong>{Math.round(d.confidence * 100)}%</strong><small>confidence</small></span></div>) : <p className="vision-note detection-empty">Nothing detected right now.</p>}</div>
      {camera.last_warning && <div className="obstacle-alert"><span><strong>Last warning to the cane</strong><small>{camera.last_warning.message}</small><em>{time(camera.last_warning.at)}</em></span></div>}
    </>}
  </div>;
}

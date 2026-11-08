import { useState } from "react";
import { VisionImage, useVision } from "./vision";
import { useAccount } from "./account";
import { Glyph, Spinner } from "./ui";

export default function VisionCamera({ caretaker }: { caretaker: boolean }) {
  const { status, connected, busy, error, command } = useVision();
  const { settings } = useAccount();
  const [mode, setMode] = useState<"cane" | "webcam">(status?.mode || "cane");
  const [host, setHost] = useState(status?.host || import.meta.env.VITE_CANE_IP || "172.20.10.3");
  const [simulate, setSimulate] = useState(status?.simulated || false);
  const [distance, setDistance] = useState(status?.simulated && status.sonar_cm != null ? status.sonar_cm : 80);
  const [voice, setVoice] = useState(status?.send_warnings ?? settings!.voice_enabled);
  const live = connected && status?.phase === "live";
  const active = connected && status && ["loading", "waiting", "live"].includes(status.phase);
  const title = !connected ? "Laptop service offline" : status?.phase === "live" ? "Detection is running" : status?.phase === "loading" ? "Loading model…" : status?.phase === "waiting" ? "Waiting for the camera" : status?.phase === "error" ? "Detection needs attention" : "Ready when you are";

  if (caretaker) return <div className="screen"><header className="page-header"><div><div className="overline">CAMERA</div><div className="page-title">Camera stays private.</div></div></header><div className="location-empty"><h2>Local viewing only</h2><p>Switch off caretaker preview to control laptop detection. Remote camera sharing is not connected.</p></div></div>;

  return <div className="screen camera-screen">
    <header className="page-header"><div><div className="overline">LAPTOP VISION</div><div className="page-title">Your surroundings.</div></div><span className="private-pill">LOCAL ONLY</span></header>
    <div className={`camera-view ${live ? "camera-live" : "camera-paused"}`}>
      {live && status ? <VisionImage status={status} alt="Live camera with detected objects outlined by the laptop" /> : <div className="camera-empty"><span className="empty-emblem">{active ? <Spinner /> : <Glyph name="camera" size={32} />}</span><strong>{title}</strong><small>{!connected ? "Start the Python service on this laptop, then choose your camera below." : status?.detail}</small></div>}
      <span className="viewfinder-corner top-left" aria-hidden="true" /><span className="viewfinder-corner bottom-right" aria-hidden="true" />
    </div>
    <div className="camera-connection" role="status"><span className={`connection-light ${live ? "online" : ""}`} /><span><strong>{title}</strong><small>{live ? `${status?.mode === "webcam" ? "Webcam" : "Cane camera"} · processed on this laptop` : connected ? status?.detail : "Run npm run vision in a second terminal."}</small></span></div>
    <form className="vision-controls" onSubmit={event => { event.preventDefault(); void command("start", { mode, host, simulated_cm: mode === "webcam" && simulate ? distance : null, send_warnings: mode === "cane" && voice }); }}>
      <fieldset disabled={busy || Boolean(active)}>
        <legend>Camera source</legend>
        <div className="source-options">
          <label><input type="radio" name="source" checked={mode === "cane"} onChange={() => setMode("cane")} />Physical cane</label>
          <label><input type="radio" name="source" checked={mode === "webcam"} onChange={() => setMode("webcam")} />Laptop webcam</label>
        </div>
        <div className="source-detail" key={mode}>{mode === "cane" ? <>
          <label className="vision-field">Cane IP address<input value={host} onChange={event => setHost(event.target.value)} required placeholder="172.20.10.3" inputMode="decimal" /></label>
          <label className="vision-check"><input type="checkbox" checked={settings!.voice_enabled && voice} disabled={!settings!.voice_enabled} onChange={event => setVoice(event.target.checked)} />Send qualifying warnings to the cane speaker</label>
          {!settings!.voice_enabled && <p className="vision-note">Voice announcements are turned off in Settings.</p>}
        </> : <>
          <p className="vision-note">Webcam opens only when you press Start. No video is uploaded.</p>
          <label className="vision-check"><input type="checkbox" checked={simulate} onChange={event => setSimulate(event.target.checked)} />Simulate distance to test warning rules</label>
          {simulate && <label className="vision-field">Simulated distance (cm)<input type="number" min="1" max="500" required value={distance} onChange={event => setDistance(Number(event.target.value))} /></label>}
        </>}</div>
      </fieldset>
      {active ? <button type="button" className="camera-action stop" disabled={busy} aria-busy={busy} onClick={() => void command("stop")}>{busy ? <Spinner /> : <span className="stop-mark" aria-hidden="true" />}{busy ? "Stopping…" : "Stop detection"}</button> : <button className="camera-action primary" type="submit" disabled={!connected || busy || status?.shared_busy} aria-busy={busy}>{busy ? <Spinner /> : <Glyph name="camera" size={19} />}{busy ? "Starting…" : `Start ${mode === "cane" ? "cane detection" : "webcam test"}`}</button>}
      <p className="vision-note">Detection keeps running when you switch tabs. Use Stop detection to release the camera.</p>
      {error && <p className="vision-error" role="alert">{error}</p>}
      {status?.history_sync && <p className="vision-note" role="status">{status.history_sync.pending ? `${status.history_sync.pending} history updates waiting to sync.` : "History is synced to your account."}{status.history_sync.error ? ` ${status.history_sync.error}` : ""}</p>}
    </form>
    {connected && status && <>
      <div className="fall-card"><span><strong>{status.simulated ? "Simulated distance" : "Sonar distance"}</strong><small>{status.sonar_fresh && status.sonar_cm != null ? `${status.sonar_cm.toFixed(0)} cm${status.simulated ? " · test value, not measured" : ""}` : status.cane_on === false ? "Cane is switched off" : "No fresh distance reading"}</small></span></div>
      <div className="camera-section-title"><span>Objects detected</span><small>{live ? `${status.inference_ms?.toFixed(0)} ms / frame` : "Waiting for video"}</small></div>
      <div className="detection-list">{live && status.detections.length ? status.detections.map((detection, index) => <div className="detection-item" key={`${detection.name}-${index}`}><span className="detection-symbol" aria-hidden="true">{detection.ahead ? "↑" : "↗"}</span><span><strong>{detection.name}</strong><small>{detection.ahead ? "Ahead" : "Off to the side"}{!detection.eligible ? " · below warning criteria" : ""}</small></span><span><strong>{Math.round(detection.confidence * 100)}%</strong><small>confidence</small></span></div>) : <p className="vision-note detection-empty">{live ? "No objects detected in the current frame." : "Detections appear here when video arrives."}</p>}</div>
      <p className="vision-note">{status.detail}</p>
      {status.last_warning && <div className="obstacle-alert"><span><strong>Last warning{status.last_warning.simulated ? " · simulated distance" : ""}</strong><small>{status.last_warning.message}</small><em>{new Date(status.last_warning.at * 1000).toLocaleTimeString()} · {status.mode === "webcam" ? "Shown locally; not sent to a cane" : status.voice_status || "Queued for cane speaker"}</em></span></div>}
      <p className="vision-note">Stock model recognizes everyday objects. Doors, stairs, and curbs still need the custom model.</p>
    </>}
  </div>;
}

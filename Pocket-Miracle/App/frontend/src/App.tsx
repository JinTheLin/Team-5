import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

// The cane's ESP32 camera. If the cane gets a different address on the hotspot,
// set VITE_CANE_IP in App/frontend/.env.local (e.g. VITE_CANE_IP=172.20.10.5) and restart the dev server.
const CANE_IP = import.meta.env.VITE_CANE_IP || "172.20.10.3";
const CANE_STREAM_URL = `http://${CANE_IP}:81/stream`;
const CANE_RETRY_MS = 4000;

type StreamStatus = "connecting" | "live" | "offline";

type Tab = "home" | "safety" | "camera";
type IconName =
  | Tab | "settings" | "battery" | "vision" | "location" | "shield"
  | "help" | "close" | "chevron" | "bluetooth" | "wifi" | "volume"
  | "accessibility" | "person" | "check" | "cameraOff" | "alert" | "send";

const paths: Record<IconName, ReactNode> = {
  home: <><path d="m3 11 9-8 9 8"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-7h5v7"/></>,
  safety: <><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></>,
  camera: <><path d="M14.5 6 13 4H8L6.5 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-5.5Z"/><circle cx="10.5" cy="13" r="4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.5 1A8 8 0 0 0 15 6l-.4-2.7h-4L10 6a8 8 0 0 0-1.5 1L6 6 4 9.5 6.1 11a7 7 0 0 0 0 2L4 14.5 6 18l2.5-1A8 8 0 0 0 10 18l.5 2.7h4L15 18a8 8 0 0 0 1.5-1l2.5 1 2-3.5-2-1.5a7 7 0 0 0 0-1Z"/></>,
  battery: <><rect x="2" y="7" width="18" height="10" rx="3"/><path d="M22 10v4"/><path d="M5 10h10v4H5z"/></>,
  vision: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  location: <><path d="M20 10c0 5.5-8 12-8 12S4 15.5 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
  shield: <><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.6 2.25c-.7.35-1.1.9-1.1 1.75"/><path d="M12 17h.01"/></>,
  close: <><path d="m7 7 10 10"/><path d="M17 7 7 17"/></>,
  chevron: <path d="m9 18 6-6-6-6"/>,
  bluetooth: <path d="m7 7 10 10-5 4V3l5 4L7 17"/>,
  wifi: <><path d="M4 9a12 12 0 0 1 16 0"/><path d="M7 12.5a7.5 7.5 0 0 1 10 0"/><path d="M10.5 16a2.3 2.3 0 0 1 3 0"/><path d="M12 19h.01"/></>,
  volume: <><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 9a4 4 0 0 1 0 6"/><path d="M18 6a8 8 0 0 1 0 12"/></>,
  accessibility: <><circle cx="12" cy="4" r="2"/><path d="M5 8h14"/><path d="M12 6v7"/><path d="m8 21 4-8 4 8"/></>,
  person: <><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  cameraOff: <><path d="m3 3 18 18"/><path d="M14.5 6 13 4H8L6.5 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14"/><path d="M18 6h2a2 2 0 0 1 2 2v9"/><path d="M8 10a4 4 0 0 0 5.5 5.5"/></>,
  alert: <><path d="M10.3 3.5 2.4 18a2 2 0 0 0 1.75 3h15.7a2 2 0 0 0 1.75-3L13.7 3.5a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></>,
  send: <><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></>,
};

function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Button({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={className} {...props}>{children}</button>;
}

function Switch({ on, setOn, label }: { on: boolean; setOn: (value: boolean) => void; label: string }) {
  return <Button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => setOn(!on)}><span /></Button>;
}

function MiniMap({ large = false }: { large?: boolean }) {
  return (
    <div className={`map ${large ? "map-large" : ""}`} role="img" aria-label="Map showing current location near Willow Park">
      <span className="map-park" /><span className="map-water" />
      <span className="map-road road-a" /><span className="map-road road-b" /><span className="map-road road-c" />
      <span className="map-label">Willow Park</span>
      <span className="location-pulse"><span><Icon name="person" size={large ? 21 : 15} /></span></span>
      {large && <><span className="street street-one">Brook Avenue</span><span className="street street-two">West 74th</span></>}
    </div>
  );
}

function DeviceCard() {
  return (
    <div className="device-card">
      <div className="orb">
        <span className="orbit one" /><span className="orbit two" />
        <span className="cane"><i /><b /></span>
      </div>
      <div className="device-content">
        <div className="connected"><span /> CANE CONNECTED</div>
        <div className="device-title">Ready for your day</div>
        <div className="device-stats">
          <div><Icon name="battery" size={19} /><span><strong>84%</strong> battery</span></div>
          <div><Icon name="vision" size={19} /><span><strong>Active</strong> detection</span></div>
        </div>
      </div>
    </div>
  );
}

function Home({ setTab, openSettings, caretaker }: { setTab: (tab: Tab) => void; openSettings: () => void; caretaker: boolean }) {
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [sent, setSent] = useState(false);

  return (
    <div className="screen home-screen">
      <header className="hello">
        <div><div className="overline">{caretaker ? "CARETAKER VIEW" : "GOOD MORNING"}</div><div className="title">{caretaker ? "Alex is doing well." : "Your journey, simplified."}</div></div>
        <Button className="round-button" onClick={openSettings} aria-label="Open settings"><Icon name="settings" size={21} /></Button>
      </header>
      {caretaker ? (
        <div className="caretaker-hero">
          <div className="caretaker-top"><span className="person-avatar">A</span><div><div className="device-title">Alex’s Smart Cane</div><div className="soft-status"><span /> Connected · 84% battery</div></div></div>
          <div className="caretaker-clear"><Icon name="shield" size={27} /><div><strong>No active alerts</strong><span>Fall monitoring is on</span></div></div>
        </div>
      ) : <DeviceCard />}

      <div className="feature-grid">
        <Button className="feature-card" onClick={() => setTab("safety")}>
          <div className="feature-heading"><span className="feature-icon lavender"><Icon name="location" size={19} /></span><span><strong>Live Location</strong><small>Sharing with Maya</small></span><Icon name="chevron" size={18} /></div>
          <MiniMap />
        </Button>
        <Button className="feature-card" onClick={() => setTab("camera")}>
          <div className="feature-heading"><span className="feature-icon blue"><Icon name="camera" size={19} /></span><span><strong>{caretaker ? "Request Camera" : "Live Camera"}</strong><small>{caretaker ? "Approval required" : "Detection active"}</small></span><Icon name="chevron" size={18} /></div>
          <div className="camera-mini">
            {caretaker ? <div className="camera-mini-empty"><Icon name="cameraOff" size={17} />Camera is private</div> : <CanePreview />}
          </div>
        </Button>
      </div>

      <div className="fall-card">
        <span className="fall-icon"><Icon name="shield" size={21} /></span>
        <span><strong>Fall detection</strong><small>Simulated · Monitoring normally</small></span>
        <span className="status-check"><Icon name="check" size={16} /></span>
      </div>

      <Button className="help-button" onClick={() => { setEmergencyOpen(true); setSent(false); }}><Icon name="alert" size={22} />SOS Emergency Assistance</Button>
      {emergencyOpen && (
        <div className="home-emergency-layer" role="dialog" aria-modal="true" aria-label="Emergency assistance">
          <Button className="emergency-scrim" onClick={() => setEmergencyOpen(false)} aria-label="Close emergency assistance" />
          <div className="home-emergency-sheet">
            {!sent ? <>
              <div className="emergency-grabber" />
              <div className="panel-top">
                <div><div className="emergency-kicker">SOS EMERGENCY ASSISTANCE</div><div className="emergency-title">Send an SOS alert?</div><div className="panel-subtitle">Maya will be notified immediately with your shared location.</div></div>
                <Button className="tiny-close" onClick={() => setEmergencyOpen(false)} aria-label="Close"><Icon name="close" size={18} /></Button>
              </div>
              <div className="sos-summary"><span className="sos-summary-icon"><Icon name="location" size={21} /></span><span><strong>Your location will be shared</strong><small>Willow Park · updated just now</small></span></div>
              <Button className="send-button home-send" onClick={() => setSent(true)}><Icon name="send" size={18} />Send SOS to Maya</Button>
            </> : <div className="home-delivered" role="status">
              <span className="delivery-icon"><Icon name="check" size={24} /></span>
              <div className="emergency-title">SOS delivered</div>
              <div className="delivered-copy">Maya received your emergency alert and shared location.</div>
              <div className="delivery-status"><i /> Delivered just now</div>
              <Button className="sheet-primary" onClick={() => setEmergencyOpen(false)}>Done</Button>
            </div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Safety({ caretaker }: { caretaker: boolean }) {
  const [showHelp, setShowHelp] = useState(false);
  const [sent, setSent] = useState(false);

  const sendAlert = () => {
    setSent(true);
    window.setTimeout(() => setSent(true), 500);
  };

  return (
    <div className="screen">
      <header className="page-header"><div><div className="overline">SAFETY</div><div className="page-title">{caretaker ? "Alex’s location" : "You’re looked after."}</div></div><span className="live-pill"><i /> LIVE</span></header>
      <div className="safety-map-wrap">
        <MiniMap large />
        <div className="map-glass">
          <span className="map-avatar">A</span>
          <span><strong>{caretaker ? "Alex is at Willow Park" : "Location is being shared"}</strong><small>Updated just now · 0.8 mi away</small></span>
        </div>
      </div>
      <div className="safety-row">
        <div><span className="safety-icon"><Icon name="shield" size={20} /></span><span><strong>Fall monitoring</strong><small>Simulated · Active</small></span></div>
        <div><span className="safety-icon"><Icon name="person" size={20} /></span><span><strong>Maya connected</strong><small>Trusted caretaker</small></span></div>
      </div>
      {!showHelp && !sent && <Button className="assist-button" onClick={() => setShowHelp(true)}><Icon name="alert" size={20} />SOS Emergency Assistance</Button>}
      {showHelp && !sent && (
        <div className="emergency-panel">
          <div className="panel-top"><div><div className="panel-title">Send an SOS alert?</div><div className="panel-subtitle">Maya will be notified immediately with your live location.</div></div><Button className="tiny-close" onClick={() => setShowHelp(false)} aria-label="Close"><Icon name="close" size={18} /></Button></div>
          <Button className="send-button" onClick={sendAlert}><Icon name="send" size={18} />Send SOS to Maya</Button>
        </div>
      )}
      {sent && (
        <div className="delivery-card" role="status">
          <span className="delivery-icon"><Icon name="check" size={22} /></span>
          <span><strong>SOS delivered to Maya</strong><small>Live location shared</small><em><i /> Delivered just now</em></span>
        </div>
      )}
    </div>
  );
}

// Live MJPEG video from the cane. If the cane can't be reached, it keeps retrying every few
// seconds, so the video appears on its own once the cane is turned on.
// The ESP32 only streams to one viewer at a time, so the connection is closed when this view goes away.
function CaneStream({ onStatus }: { onStatus: (status: StreamStatus) => void }) {
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const element = img.current;
    if (!element) return;
    let retryTimer = 0;
    let heartbeat = 0;
    let missed = 0;

    const connect = () => { element.src = `${CANE_STREAM_URL}?t=${Date.now()}`; };
    const fail = () => {
      window.clearInterval(heartbeat);
      heartbeat = 0;
      window.clearTimeout(retryTimer);
      onStatus("offline");
      retryTimer = window.setTimeout(connect, CANE_RETRY_MS);
    };
    // The browser doesn't report when a running stream dies (e.g. the cane is switched off) and just
    // freezes on the last frame, so while live, check that the cane still answers.
    const live = () => {
      onStatus("live");
      if (heartbeat) return;
      missed = 0;
      heartbeat = window.setInterval(() => {
        fetch(`http://${CANE_IP}/status`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(3000) })
          .then(() => { missed = 0; })
          .catch(() => { if (++missed >= 2) fail(); });
      }, CANE_RETRY_MS);
    };

    element.addEventListener("load", live);
    element.addEventListener("error", fail);
    onStatus("connecting");
    connect();
    return () => {
      window.clearTimeout(retryTimer);
      window.clearInterval(heartbeat);
      element.removeEventListener("load", live);
      element.removeEventListener("error", fail);
      element.src = "";
    };
  }, [onStatus]);

  return <img ref={img} alt="Live view from the cane's camera" />;
}

// Small live preview of the cane's camera for the Home screen.
function CanePreview() {
  const [stream, setStream] = useState<StreamStatus>("connecting");
  return <>
    <CaneStream onStatus={setStream} />
    {stream === "offline"
      ? <div className="camera-mini-empty"><Icon name="cameraOff" size={17} />Cane camera offline</div>
      : <span className="object-tag">{stream === "live" ? "Live" : "Connecting…"}</span>}
  </>;
}

function Camera({ caretaker }: { caretaker: boolean }) {
  const [sharing, setSharing] = useState(false);
  const [requested, setRequested] = useState(false);
  const [stream, setStream] = useState<StreamStatus>("connecting");
  const feedVisible = !caretaker || sharing;
  const showFeed = feedVisible && stream !== "offline";

  const request = () => {
    setRequested(true);
  };

  const connection = !feedVisible
    ? { light: "", title: "Camera private", detail: "Waiting for user approval", badge: "OFF" }
    : stream === "live" ? { light: "online", title: "Cane camera connected", detail: `Live from cane · ${CANE_IP}`, badge: "LIVE" }
    : stream === "offline" ? { light: "", title: "Camera offline", detail: `Can't reach the cane at ${CANE_IP} · retrying`, badge: "OFF" }
    : { light: "", title: "Connecting to cane…", detail: CANE_IP, badge: "…" };

  return (
    <div className="screen camera-screen">
      <header className="page-header"><div><div className="overline">LIVE CAMERA</div><div className="page-title">{caretaker ? "See what Alex sees." : "Your surroundings."}</div></div><span className={caretaker ? (sharing ? "share-pill" : "private-pill") : "detection-pill"}><i />{caretaker ? (sharing ? " SHARED" : " PRIVATE") : " DETECTION ACTIVE"}</span></header>
      <div className={`camera-view ${showFeed ? "camera-live" : "camera-paused"}`}>
        {!feedVisible ? <div className="camera-empty"><Icon name="cameraOff" size={36} /><strong>Camera is private</strong><small>Object detection continues locally. Live video requires Alex’s approval.</small></div>
          : <>
              <CaneStream onStatus={setStream} />
              {stream === "offline" && <div className="camera-empty"><Icon name="cameraOff" size={36} /><strong>Waiting for the cane…</strong><small>The video will appear on its own once the cane is on and this device is on the same hotspot. The cane streams to one viewer at a time, so close any other tab showing it.</small></div>}
            </>}
        {showFeed && <><span className="detect-box"><i>Bench · 12 ft</i></span><span className="detect-box second"><i>Pedestrian · 24 ft</i></span><span className="sim-label">OBJECT DETECTION · SIMULATED</span></>}
        {showFeed && <div className="object-panel"><span className="direction-arrow">↑</span><span><small>AHEAD · LOW PRIORITY</small><strong>Park bench in 12 feet</strong></span></div>}
      </div>
      <div className="camera-connection"><span className={`connection-light ${connection.light}`} /><span><strong>{connection.title}</strong><small>{connection.detail}</small></span><span className="connection-quality">{connection.badge}</span></div>
      {feedVisible && <>
        <div className="camera-section-title"><span>Objects detected</span><small>Computer vision · simulated</small></div>
        <div className="detection-list">
          <div className="detection-item"><span className="detection-symbol">↑</span><span><strong>Park bench</strong><small>Directly ahead</small></span><span><strong>12 ft</strong><small>96% confidence</small></span></div>
          <div className="detection-item"><span className="detection-symbol">↗</span><span><strong>Pedestrian</strong><small>Right side</small></span><span><strong>24 ft</strong><small>91% confidence</small></span></div>
          <div className="detection-item"><span className="detection-symbol">←</span><span><strong>Tree</strong><small>Left side</small></span><span><strong>8 ft</strong><small>88% confidence</small></span></div>
        </div>
        <div className="obstacle-alert"><span className="obstacle-icon"><Icon name="alert" size={21} /></span><span><strong>Obstacle awareness</strong><small>Bench ahead · 12 ft · Low priority</small><em>Sonar + vision data simulated</em></span></div>
      </>}
      {!caretaker && <div className={`sharing-status ${sharing ? "is-sharing" : ""}`}><span className="sharing-status-icon"><Icon name={sharing ? "camera" : "shield"} size={19} /></span><span><strong>{sharing ? "Camera shared with Maya" : "Not shared with caretaker"}</strong><small>{sharing ? "Maya can view this live feed." : "Object detection runs privately on your cane."}</small></span></div>}
      {caretaker && !sharing && !requested && <Button className="camera-action primary" onClick={request}><Icon name="camera" size={20} />Request live camera</Button>}
      {caretaker && requested && !sharing && (
        <div className="approval-card">
          <span className="approval-icon"><Icon name="person" size={22} /></span>
          <span><strong>Waiting for Alex’s approval</strong><small>The camera remains private until approved.</small></span>
          <Button onClick={() => setSharing(true)}>Simulate Alex’s approval</Button>
        </div>
      )}
      {!caretaker && !sharing && <Button className="camera-action primary" onClick={() => setSharing(true)}><Icon name="camera" size={19} />Share Camera with Maya</Button>}
      {sharing && <Button className="camera-action stop" onClick={() => { setSharing(false); setRequested(false); }}><Icon name="cameraOff" size={19} />Stop Sharing</Button>}
      <div className="privacy-note"><Icon name="shield" size={18} /><span><strong>Privacy first</strong><small>Camera access is visible, temporary, and always under user control.</small></span></div>
    </div>
  );
}

function SettingRow({ icon, title, detail, children, onClick }: { icon: IconName; title: string; detail?: string; children?: ReactNode; onClick?: () => void }) {
  const content = <><span className="setting-icon"><Icon name={icon} size={20} /></span><span className="setting-text"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>{children || (onClick && <Icon name="chevron" size={18} />)}</>;
  return onClick ? <Button className="setting-row" onClick={onClick}>{content}</Button> : <div className="setting-row">{content}</div>;
}

type Preferences = { voice: boolean; reconnect: boolean; location: boolean; paired: boolean; volume: number; largeText: boolean; reduceMotion: boolean };

function SettingsSheet({ close, caretaker, setCaretaker, preferences, setPreferences }: { close: () => void; caretaker: boolean; setCaretaker: (value: boolean) => void; preferences: Preferences; setPreferences: (value: Preferences) => void }) {
  const { voice, reconnect, location, paired, volume } = preferences;
  const setVoice = (voice: boolean) => setPreferences({ ...preferences, voice });
  const setReconnect = (reconnect: boolean) => setPreferences({ ...preferences, reconnect });
  const setLocation = (location: boolean) => setPreferences({ ...preferences, location });
  const setPaired = (paired: boolean) => setPreferences({ ...preferences, paired });
  const [view, setView] = useState<"main" | "connection" | "caretaker" | "accessibility">("main");


  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <Button className="scrim" onClick={close} aria-label="Close settings" />
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-header">
          {view !== "main" ? <Button className="back-button" onClick={() => setView("main")}>Back</Button> : <span />}
          <div>{view === "main" ? "Settings" : view === "connection" ? "Connection setup" : view === "accessibility" ? "Accessibility" : "Trusted caretaker"}</div>
          <Button className="tiny-close" onClick={close} aria-label="Close settings"><Icon name="close" size={19} /></Button>
        </div>
        {view === "main" && <>
          <div className="setting-section">EXPERIENCE</div>
          <div className="settings-card">
            <SettingRow icon="volume" title="Voice announcements" detail="Objects, directions, and status"><Switch on={voice} setOn={setVoice} label="Voice announcements" /></SettingRow>
            <SettingRow icon="volume" title="Alert volume" detail={`${volume === 0 ? "Muted" : volume < 40 ? "Quiet" : volume < 80 ? "Comfortable" : "Loud"} · ${volume}%`}><input className="mini-range" aria-label="Alert volume" type="range" min="0" max="100" value={volume} onChange={(event) => setPreferences({ ...preferences, volume: Number(event.target.value) })} /></SettingRow>
            <SettingRow icon="accessibility" title="Accessibility" detail="Text size, motion, screen readers" onClick={() => setView("accessibility")} />
          </div>
          <div className="setting-section">CONNECTIONS & TRUST</div>
          <div className="settings-card">
            <SettingRow icon="bluetooth" title="Cane connection" detail={`Bluetooth + Wi-Fi · ${paired ? "Connected" : "Disconnected"}`} onClick={() => setView("connection")} />
            <SettingRow icon="wifi" title="Automatic reconnection" detail="Reconnect whenever available"><Switch on={reconnect} setOn={setReconnect} label="Automatic reconnection" /></SettingRow>
            <SettingRow icon="person" title="Trusted caretaker" detail={`Maya Chen · Location ${location ? "allowed" : "off"}`} onClick={() => setView("caretaker")} />
          </div>
          <div className="mode-row"><span><strong>Caretaker mode preview</strong><small>See the simplified shared dashboard</small></span><Switch on={caretaker} setOn={setCaretaker} label="Caretaker mode preview" /></div>
        </>}
        {view === "accessibility" && <>
          <div className="setting-section">DISPLAY & MOTION</div>
          <div className="settings-card">
            <SettingRow icon="accessibility" title="Larger text" detail="Increase text size throughout the app"><Switch on={preferences.largeText} setOn={(largeText) => setPreferences({ ...preferences, largeText })} label="Larger text" /></SettingRow>
            <SettingRow icon="vision" title="Reduce motion" detail="Turn off screen and panel animations"><Switch on={preferences.reduceMotion} setOn={(reduceMotion) => setPreferences({ ...preferences, reduceMotion })} label="Reduce motion" /></SettingRow>
          </div>
          <div className="permission-note"><Icon name="accessibility" size={20} /><span>Use your device’s accessibility settings to enable VoiceOver or TalkBack. Buttons and switches in this app include screen reader labels.</span></div>
        </>}
        {view === "connection" && <div className="setup-content">
          <div className={`setup-orb ${paired ? "paired" : ""}`}><Icon name={paired ? "check" : "bluetooth"} size={31} /></div>
          <div className="setup-title">{paired ? "Cane is connected" : "Ready to pair"}</div>
          <div className="setup-copy">{paired ? `Bluetooth and Wi-Fi are configured. Automatic reconnection is ${reconnect ? "active" : "off"}.` : "Keep the cane nearby and press its pairing button."}</div>
          <div className="connection-detail"><span>Smart Cane SC-204</span><strong>{paired ? "Connected" : "Available"}</strong></div>
          <Button className="sheet-primary" onClick={() => setPaired(!paired)}>{paired ? "Disconnect for demo" : "Connect cane"}</Button>
          <div className="prototype-note">Hardware connection is simulated in this prototype.</div>
        </div>}
        {view === "caretaker" && <div className="caretaker-settings">
          <div className="caretaker-profile"><span>MC</span><div><strong>Maya Chen</strong><small>Trusted caretaker · Active</small></div></div>
          <div className="settings-card">
            <SettingRow icon="location" title="Share live location" detail={location ? "Maya can see your current location" : "Location sharing is off"}><Switch on={location} setOn={setLocation} label="Share live location" /></SettingRow>
            <SettingRow icon="camera" title="Camera requests" detail="Always requires your approval"><span className="locked-label">ASK</span></SettingRow>
            <SettingRow icon="alert" title="SOS emergency alerts" detail="Notifies Maya and shares location"><span className="locked-label">ON</span></SettingRow>
          </div>
          <div className="permission-note"><Icon name="shield" size={20} />You stay in control. Camera access can never begin without your approval.</div>
        </div>}
      </div>
    </div>
  );
}

const tabs: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" }, { id: "safety", label: "Safety" }, { id: "camera", label: "Camera" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [settings, setSettings] = useState(false);
  const [caretaker, setCaretaker] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({ voice: true, reconnect: true, location: true, paired: true, volume: 70, largeText: false, reduceMotion: false });
  return (
    <main className="app-shell">
      <div className={`phone${preferences.largeText ? " large-text" : ""}${preferences.reduceMotion ? " reduce-motion" : ""}`}>
        <div className="statusbar"><strong>9:41</strong><span><i /><i /><b /></span></div>
        <div className="viewport">
          {tab === "home" && <Home setTab={setTab} openSettings={() => setSettings(true)} caretaker={caretaker} />}
          {tab === "safety" && <Safety caretaker={caretaker} />}
          {tab === "camera" && <Camera caretaker={caretaker} />}
        </div>
        <nav className="tabbar" aria-label="Primary navigation">
          {tabs.map((item) => <Button key={item.id} className={`tab ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)} aria-current={tab === item.id ? "page" : undefined}><Icon name={item.id} size={22} /><span>{item.label}</span></Button>)}
        </nav>
        <div className="homebar" />
        {settings && <SettingsSheet preferences={preferences} setPreferences={setPreferences} close={() => setSettings(false)} caretaker={caretaker} setCaretaker={setCaretaker} />}
      </div>
    </main>
  );
}

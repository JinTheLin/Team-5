import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import VisionCamera from "./VisionCamera";
import { VisionImage, useVision } from "./vision";
import { useAccount, useAuth } from "./account";
import { supabase } from "./supabase";
import History from "./History";

type Tab = "home" | "safety" | "camera" | "history";
type IconName =
  | Tab | "settings" | "battery" | "vision" | "location" | "shield"
  | "help" | "close" | "chevron" | "bluetooth" | "wifi" | "volume"
  | "accessibility" | "person" | "check" | "cameraOff" | "alert" | "send";

const paths: Record<IconName, ReactNode> = {
  history: <><path d="M3 11a9 9 0 1 1 2.6 7"/><path d="M3 4v7h7"/><path d="M12 7v5l3 2"/></>,
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

// Retain sheets briefly on dismissal so their exit can finish. Reopening cancels it.
function MotionPresence({ open, className, children, onClose }: { open: boolean; className: string; children: ReactNode; onClose?: () => void }) {
  const [mounted, setMounted] = useState(open);
  const element = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => element.current?.querySelector<HTMLElement>(".tiny-close, .close-sos, button:not(.scrim):not(.emergency-scrim)")?.focus({ preventScroll: true }));
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); close.current?.(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(element.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),a[href],[tabindex='0']") || []).filter(node => node.getClientRects().length && !node.closest("[inert]"));
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !element.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keyboard);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", keyboard); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || element.current?.closest(".reduce-motion");
    const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : 220);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!open && !mounted) return null;
  return <div ref={element} className={`${className}${open ? "" : " is-exiting"}`} inert={!open} aria-hidden={!open || undefined}>{children}</div>;
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
  const { status, connected } = useVision();
  return (
    <div className="device-card">
      <div className="orb">
        <span className="orbit one" /><span className="orbit two" />
        <span className="cane"><i /><b /></span>
      </div>
      <div className="device-content">
        <div className="connected">YOUR SMART CANE</div>
        <div className="device-title">A little more independence.</div>
        <div className="device-stats">
          <div><Icon name="battery" size={19} /><span><strong>Unavailable</strong> battery status</span></div>
          <div><Icon name="vision" size={19} /><span><strong>{connected && status?.phase === "live" ? "Running on laptop" : "Not running"}</strong> detection</span></div>
        </div>
      </div>
    </div>
  );
}

function callEmergencyContact(phone: string | null) {
  if (!phone || !/^\+?[0-9]{7,15}$/.test(phone)) return;
  window.location.href = `tel:${phone}`;
}

function Home({ setTab, openSettings, caretaker }: { setTab: (tab: Tab) => void; openSettings: () => void; caretaker: boolean }) {
  const { displayName, settings } = useAccount();
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const contactName = settings?.emergency_contact_name;
  const contactPhone = settings?.emergency_contact_phone;

  return (
    <div className="screen home-screen">
      <header className="hello">
        <div><div className="overline">{caretaker ? "CARETAKER PREVIEW" : `HELLO, ${displayName}`}</div><div className="title">{caretaker ? "Stay in touch." : "Your everyday companion."}</div></div>
        <Button className="round-button" onClick={openSettings} aria-label="Open settings"><Icon name="settings" size={21} /></Button>
      </header>
      {caretaker ? (
        <div className="caretaker-hero">
          <div className="caretaker-top"><span className="person-avatar">A</span><div><div className="device-title">Alex’s Smart Cane</div><div className="soft-status">Example caretaker view</div></div></div>
          <div className="caretaker-clear"><Icon name="shield" size={27} /><div><strong>Monitoring not connected</strong><span>Alerts will appear here once set up.</span></div></div>
        </div>
      ) : <DeviceCard />}
      <div className="home-section-heading"><span>YOUR DAY, AT A GLANCE</span><span className="section-rule" /></div>
      <div className="feature-grid">
        <Button className="feature-card" onClick={() => setTab("safety")}>
          <div className="feature-heading"><span className="feature-icon lavender"><Icon name="location" size={19} /></span><span><strong>Safety</strong><small>Contacts & location</small></span><Icon name="chevron" size={18} /></div>
          <div className="feature-description">Stay connected to someone you trust.</div>
        </Button>
        <Button className="feature-card" onClick={() => setTab("camera")}>
          <div className="feature-heading"><span className="feature-icon blue"><Icon name="camera" size={19} /></span><span><strong>{caretaker ? "Camera" : "Cane camera"}</strong><small>{caretaker ? "Approval required" : "View surroundings"}</small></span><Icon name="chevron" size={18} /></div>
          <div className="camera-mini">
            {caretaker ? <div className="camera-mini-empty"><Icon name="cameraOff" size={17} />Camera is private</div> : <CanePreview />}
          </div>
        </Button>
      </div>
      <div className="fall-card">
        <span className="fall-icon"><Icon name="shield" size={21} /></span>
        <span><strong>Fall detection</strong><small>Not connected yet</small></span>
      </div>
      <Button className="help-button" onClick={() => setEmergencyOpen(true)}><Icon name="alert" size={22} />Emergency help</Button>
      <MotionPresence open={emergencyOpen} className="home-emergency-layer" onClose={() => setEmergencyOpen(false)}>
        <div className="emergency-dialog" role="dialog" aria-modal="true" aria-label="Emergency assistance">
          <Button className="emergency-scrim" onClick={() => setEmergencyOpen(false)} aria-label="Close emergency assistance" />
          <div className="home-emergency-sheet">
            <div className="emergency-grabber" />
            <div className="panel-top">
              <div><div className="emergency-kicker">EMERGENCY HELP</div><div className="emergency-title">Call your trusted contact</div><div className="panel-subtitle">{contactPhone ? `Open your phone's dialer to call ${contactName || "your trusted contact"}. You may need to confirm the call.` : "No emergency contact is saved. Add one in Settings first."}</div></div>
              <Button className="tiny-close" onClick={() => setEmergencyOpen(false)} aria-label="Close"><Icon name="close" size={18} /></Button>
            </div>
            <div className="sos-summary"><span className="sos-summary-icon"><Icon name="person" size={21} /></span><span><strong>{contactName || "Trusted contact"}</strong><small>{contactPhone || "Not set up"}</small></span></div>
            {contactPhone ? <Button className="send-button home-send" onClick={() => callEmergencyContact(contactPhone)}><Icon name="alert" size={18} />Open phone dialer</Button> : <Button className="send-button home-send" onClick={() => { setEmergencyOpen(false); openSettings(); }}><Icon name="settings" size={18} />Set emergency contact</Button>}
          </div>
        </div>
      </MotionPresence>
    </div>
  );
}

function Safety({ caretaker, openSettings }: { caretaker: boolean; openSettings: () => void }) {
  const { settings } = useAccount();
  const [showHelp, setShowHelp] = useState(false);
  const contactName = settings?.emergency_contact_name;
  const contactPhone = settings?.emergency_contact_phone;

  return (
    <div className="screen">
      <header className="page-header"><div><div className="overline">SAFETY</div><div className="page-title">{caretaker ? "Shared safety" : "Your support circle."}</div></div></header>
      <div className="safety-map-wrap">
        <div className="location-empty"><Icon name="location" size={32} /><h2>Location isn’t connected</h2><p>Your shared location will appear here after location sharing is set up.</p></div>
      </div>
      <div className="safety-row">
        <div><span className="safety-icon"><Icon name="shield" size={20} /></span><span><strong>Fall monitoring</strong><small>Not connected</small></span></div>
        <div><span className="safety-icon"><Icon name="person" size={20} /></span><span><strong>Trusted contact</strong><small>{contactPhone ? `${contactName || "Contact"} · ${contactPhone}` : "Not set up"}</small></span></div>
      </div>
      {!showHelp && <Button className="assist-button" onClick={() => setShowHelp(true)}><Icon name="alert" size={20} />SOS Emergency Assistance</Button>}
      {showHelp && (
        <div className="emergency-panel">
          <div className="panel-top"><div><div className="panel-title">Call your trusted contact</div><div className="panel-subtitle">{contactPhone ? `Open your phone's dialer for ${contactName || "your contact"}. Calling may require confirmation.` : "No emergency contact is saved. Add one in Settings first."}</div></div><Button className="tiny-close" onClick={() => setShowHelp(false)} aria-label="Close"><Icon name="close" size={18} /></Button></div>
          {contactPhone ? <Button className="send-button" onClick={() => callEmergencyContact(contactPhone)}><Icon name="alert" size={18} />Open phone dialer</Button> : <Button className="send-button" onClick={() => { setShowHelp(false); openSettings(); }}><Icon name="settings" size={18} />Set emergency contact</Button>}
        </div>
      )}
    </div>
  );
}

// Small live preview of the cane's camera for the Home screen.
function CanePreview() {
  const { status, connected } = useVision();
  return <>
    {connected && status?.phase === "live" ? <><VisionImage status={status} alt="Camera processed by laptop detection" /><span className="object-tag">Detection live</span></> : <div className="camera-mini-empty"><Icon name="cameraOff" size={17} />Open camera to start</div>}
  </>;
}

function SettingRow({ icon, title, detail, children, onClick }: { icon: IconName; title: string; detail?: string; children?: ReactNode; onClick?: () => void }) {
  const content = <><span className="setting-icon"><Icon name={icon} size={20} /></span><span className="setting-text"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>{children || (onClick && <Icon name="chevron" size={18} />)}</>;
  return onClick ? <Button className="setting-row" onClick={onClick}>{content}</Button> : <div className="setting-row">{content}</div>;
}

type Preferences = { voice: boolean; reconnect: boolean; location: boolean; paired: boolean; volume: number; largeText: boolean; reduceMotion: boolean };

function SettingsSheet({ close, caretaker, setCaretaker, preferences, setPreferences }: { close: () => void; caretaker: boolean; setCaretaker: (value: boolean) => void; preferences: Preferences; setPreferences: (value: Preferences) => void }) {
  const account = useAccount();
  const { session } = useAuth();
  const { command } = useVision();
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [contactName, setContactName] = useState(account.settings?.emergency_contact_name || "");
  const [contactPhone, setContactPhone] = useState(account.settings?.emergency_contact_phone || "");
  const [contactError, setContactError] = useState("");
  const [contactStatus, setContactStatus] = useState("");
  const [contactSaving, setContactSaving] = useState(false);
  async function saveContact() {
    const name = contactName.trim();
    const phone = contactPhone.replace(/[\s().-]/g, "");
    setContactError(""); setContactStatus("");
    if ((name && !phone) || (!name && phone)) { setContactError("Enter both a name and phone number, or clear both fields."); return; }
    if (phone && !/^\+?[0-9]{7,15}$/.test(phone)) { setContactError("Enter a valid phone number, including country code if needed."); return; }
    setContactSaving(true);
    try {
      const { error } = await supabase.from("app_settings").update({ emergency_contact_name: name || null, emergency_contact_phone: phone || null }).eq("user_id", session!.user.id).select("id").single();
      if (error) throw error;
      account.updateSettings({ emergency_contact_name: name || null, emergency_contact_phone: phone || null });
      setContactPhone(phone);
      setContactStatus(name ? "Emergency contact saved." : "Emergency contact removed.");
    } catch (error) { setContactError((error as Error).message || "Could not save emergency contact."); }
    finally { setContactSaving(false); }
  }
  async function logout() {
    setSigningOut(true); setLogoutError("");
    try {
      await account.flush();
      await command("disconnect");
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw error;
    } catch (error) { setLogoutError((error as Error).message); setSigningOut(false); }
  }
  const { voice, reconnect, location, paired, volume } = preferences;
  const setVoice = (voice: boolean) => setPreferences({ ...preferences, voice });
  const setReconnect = (reconnect: boolean) => setPreferences({ ...preferences, reconnect });
  const setLocation = (location: boolean) => setPreferences({ ...preferences, location });
  const setPaired = (paired: boolean) => setPreferences({ ...preferences, paired });
  const [view, setView] = useState<"main" | "connection" | "caretaker" | "accessibility" | "emergency">("main");


  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <Button className="scrim" onClick={close} aria-label="Close settings" />
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-header">
          {view !== "main" ? <Button className="back-button" onClick={() => setView("main")}>Back</Button> : <span />}
          <div>{view === "main" ? "Settings" : view === "connection" ? "Connection setup" : view === "accessibility" ? "Accessibility" : view === "emergency" ? "Emergency contact" : "Trusted caretaker"}</div>
          <Button className="tiny-close" onClick={close} aria-label="Close settings"><Icon name="close" size={19} /></Button>
        </div>
        <div className="sheet-content" key={view}>
        {view === "main" && <>
          <div className="setting-section">EXPERIENCE</div>
          <div className="settings-card">
            <SettingRow icon="volume" title="Voice announcements" detail="Used for your next detection run"><Switch on={voice} setOn={setVoice} label="Voice announcements" /></SettingRow>
            <SettingRow icon="volume" title="Alert volume" detail={`${volume}% · Saved preference; device sync not connected`}><input className="mini-range" aria-label="Alert volume" type="range" min="0" max="100" value={volume} onChange={(event) => setPreferences({ ...preferences, volume: Number(event.target.value) })} /></SettingRow>
            <SettingRow icon="accessibility" title="Accessibility" detail="Text size, motion, screen readers" onClick={() => setView("accessibility")} />
          </div>
          <div className="setting-section">CONNECTIONS & TRUST</div>
          <div className="settings-card">
            <SettingRow icon="bluetooth" title="Cane connection" detail={paired ? "Pairing preview active" : "Pairing not set up"} onClick={() => setView("connection")} />
            <SettingRow icon="wifi" title="Automatic reconnection" detail="Reconnect whenever available"><Switch on={reconnect} setOn={setReconnect} label="Automatic reconnection" /></SettingRow>
            <SettingRow icon="person" title="Emergency contact" detail={account.settings?.emergency_contact_phone ? account.settings.emergency_contact_name || account.settings.emergency_contact_phone : "Add a phone number for SOS calls"} onClick={() => { setContactName(account.settings?.emergency_contact_name || ""); setContactPhone(account.settings?.emergency_contact_phone || ""); setContactError(""); setContactStatus(""); setView("emergency"); }} />
            <SettingRow icon="person" title="Trusted caretaker" detail="View sharing setup preview" onClick={() => setView("caretaker")} />
          </div>
          <div className="mode-row"><span><strong>Caretaker mode preview</strong><small>See the simplified shared dashboard</small></span><Switch on={caretaker} setOn={setCaretaker} label="Caretaker mode preview" /></div>
          <div className="setting-section">DETECTION THRESHOLDS</div>
          <div className="settings-card threshold-settings"><label>Warning distance (cm)<input aria-label="Warning distance" type="number" min="1" max="10000" value={account.settings!.warning_distance_cm} onChange={event => { const value = Number(event.target.value); if (value >= 1 && value <= 10000) account.updateSettings({ warning_distance_cm: value }); }} /></label><label>Warning confidence (%)<input aria-label="Warning confidence" type="number" min="1" max="100" value={Math.round(account.settings!.warning_confidence * 100)} onChange={event => { const value = Number(event.target.value); if (value >= 1 && value <= 100) account.updateSettings({ warning_confidence: value / 100 }); }} /></label><p>Applied when you start your next run.</p></div>
          <div className="account-footer"><strong>{account.displayName}</strong><span>{session?.user.email}</span><small role="status">{account.saving ? "Saving preferences…" : account.error ? "Changes need to be saved" : "Preferences saved to your account"}</small>{account.error && <><p className="vision-error" role="alert">{account.error}</p><button className="auth-text-button" onClick={account.retry}>Retry saving</button></>}{logoutError && <p className="vision-error" role="alert">{logoutError}</p>}<button className="camera-action stop" disabled={signingOut} onClick={() => void logout()}>{signingOut ? "Logging out…" : "Log out"}</button></div>
        </>}
        {view === "emergency" && <div className="caretaker-settings">
          <div className="setting-section">TRUSTED EMERGENCY CONTACT</div>
          <div className="settings-card threshold-settings">
            <label>Contact name<input type="text" autoComplete="name" maxLength={80} value={contactName} onChange={event => setContactName(event.target.value)} placeholder="Name" /></label>
            <label>Phone number<input type="tel" autoComplete="tel" maxLength={25} value={contactPhone} onChange={event => setContactPhone(event.target.value)} placeholder="+15551234567" /></label>
          </div>
          {contactError && <p className="vision-error" role="alert">{contactError}</p>}
          {contactStatus && <p role="status">{contactStatus}</p>}
          <Button className="sheet-primary" disabled={contactSaving} onClick={() => void saveContact()}>{contactSaving ? "Saving…" : "Save emergency contact"}</Button>
          <div className="permission-note"><Icon name="shield" size={20} /><span>SOS opens the phone dialer. It does not automatically place a call, send an alert, or share your location.</span></div>
        </div>}
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
          <div className="setup-title">Pair your cane</div>
          <div className="setup-copy">Pairing is a preview. Your camera connection works separately when your phone and cane are on the same network.</div>
          <div className="connection-detail"><span>Smart cane</span><strong>{paired ? "Preview paired" : "Not paired"}</strong></div>
          <Button className="sheet-primary" onClick={() => setPaired(!paired)}>{paired ? "Reset preview" : "Preview pairing"}</Button>
          <div className="prototype-note">Hardware connection is simulated in this prototype.</div>
        </div>}
        {view === "caretaker" && <div className="caretaker-settings">
          <div className="caretaker-profile"><span><Icon name="person" size={20} /></span><div><strong>{account.settings?.emergency_contact_name || "No emergency contact"}</strong><small>{account.settings?.emergency_contact_phone || "Not set up"}</small></div></div>
          <div className="settings-card">
            <SettingRow icon="location" title="Share live location" detail="Preview preference · no location is shared"><Switch on={location} setOn={setLocation} label="Share live location" /></SettingRow>
            <SettingRow icon="camera" title="Camera requests" detail="Always requires your approval"><span className="locked-label">ASK</span></SettingRow>
            <SettingRow icon="alert" title="SOS emergency calls" detail="Opens the device dialer; no automatic alert"><span className="locked-label">{account.settings?.emergency_contact_phone ? "READY" : "NOT SET UP"}</span></SettingRow>
          </div>
          <div className="permission-note"><Icon name="shield" size={20} />You stay in control. Camera access can never begin without your approval.</div>
        </div>}
        </div>
      </div>
    </div>
  );
}

const tabs: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" }, { id: "safety", label: "Safety" }, { id: "camera", label: "Camera" },
  { id: "history", label: "History" },
];

export default function App() {
  const account = useAccount();
  const [tab, setActiveTab] = useState<Tab>("home");
  const [direction, setDirection] = useState(1);
  function setTab(next: Tab) {
    if (next === tab) return;
    setDirection(tabs.findIndex(item => item.id === next) > tabs.findIndex(item => item.id === tab) ? 1 : -1);
    setActiveTab(next);
  }
  const [settings, setSettings] = useState(false);
  const [caretaker, setCaretaker] = useState(false);
  const [previewPreferences, setPreviewPreferences] = useState({ location: false, paired: false });
  const saved = account.settings!;
  const preferences: Preferences = { ...previewPreferences, voice: saved.voice_enabled, reconnect: saved.automatic_reconnect, volume: saved.volume, largeText: saved.large_text, reduceMotion: saved.reduce_motion };
  function setPreferences(next: Preferences) {
    setPreviewPreferences({ location: next.location, paired: next.paired });
    account.updateSettings({ voice_enabled: next.voice, automatic_reconnect: next.reconnect, volume: next.volume, large_text: next.largeText, reduce_motion: next.reduceMotion });
  }
  return (
    <main className="app-shell">
      <div className={`phone${preferences.largeText ? " large-text" : ""}${preferences.reduceMotion ? " reduce-motion" : ""}`}>
        <div className="viewport" data-tab={tab} style={{ "--screen-offset": `${direction * 14}px` } as CSSProperties} inert={settings}>
          {tab === "home" && <Home setTab={setTab} openSettings={() => setSettings(true)} caretaker={caretaker} />}
          {tab === "safety" && <Safety caretaker={caretaker} openSettings={() => setSettings(true)} />}
          {tab === "camera" && <VisionCamera caretaker={caretaker} />}
          {tab === "history" && <History startCamera={() => setTab("camera")} />}
        </div>
        <nav className="tabbar" aria-label="Primary navigation" inert={settings}>
          <span className="tab-indicator" aria-hidden="true" style={{ transform: `translateX(${tabs.findIndex(item => item.id === tab) * 100}%)` }} />
          {tabs.map((item) => <Button key={item.id} className={`tab ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)} aria-current={tab === item.id ? "page" : undefined}><Icon name={item.id} size={22} /><span>{item.label}</span></Button>)}
        </nav>
        <MotionPresence open={settings} className="settings-presence" onClose={() => setSettings(false)}><SettingsSheet preferences={preferences} setPreferences={setPreferences} close={() => setSettings(false)} caretaker={caretaker} setCaretaker={setCaretaker} /></MotionPresence>
      </div>
    </main>
  );
}

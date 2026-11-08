import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./account";
import { Disclosure, Glyph, Spinner } from "./ui";

type Run = { id: string; source_type: string; started_at: string; ended_at: string | null; status: string; simulated_distance_cm: number | null };
type Event = { id: string; object_label: string; peak_confidence: number; position: string; first_seen_at: string };
type Warning = { id: string; message: string; created_at: string; is_simulated: boolean; delivery_status: string };
function RunDetails({ id }: { id: string }) {
  const [data, setData] = useState<{ events: Event[]; warnings: Warning[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      supabase.from("detection_events").select("id,object_label,peak_confidence,position,first_seen_at").eq("session_id", id).order("first_seen_at", { ascending: false }).limit(50),
      supabase.from("warnings").select("id,message,created_at,is_simulated,delivery_status").eq("session_id", id).order("created_at", { ascending: false }).limit(50),
    ]).then(([events, warnings]) => {
      if (!active) return;
      if (events.error || warnings.error) { setError(events.error?.message || warnings.error!.message); return; }
      setData({ events: events.data as Event[], warnings: warnings.data as Warning[] });
    }).catch(() => { if (active) setError("Could not load this run. Close and reopen it to retry."); });
    return () => { active = false; };
  }, [id]);
  if (error) return <p className="vision-error" role="alert">{error}</p>;
  if (!data) return <p className="inline-loading" role="status"><Spinner />Loading this run…</p>;
  return <div className="run-details"><h3>Warnings</h3>{!data.warnings.length ? <p>No warnings recorded.</p> : data.warnings.map(warning => <div className="history-warning" key={warning.id}><strong>{warning.message}</strong><span>{new Date(warning.created_at).toLocaleTimeString()} · {warning.delivery_status.replace(/_/g, " ")}{warning.is_simulated ? " · simulated distance" : ""}</span></div>)}<h3>Object sightings</h3>{!data.events.length ? <p>No sightings recorded.</p> : data.events.map(event => <div className="history-event" key={event.id}><span>{event.object_label}<small>{event.position} · {new Date(event.first_seen_at).toLocaleTimeString()}</small></span><strong>{Math.round(event.peak_confidence * 100)}%</strong></div>)}{(data.events.length === 50 || data.warnings.length === 50) && <p>Showing the 50 most recent entries of each type.</p>}</div>;
}
export default function History({ startCamera }: { startCamera: () => void }) {
  const { session } = useAuth();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void supabase.from("detection_sessions").select("id,source_type,started_at,ended_at,status,simulated_distance_cm").eq("user_id", session!.user.id).order("started_at", { ascending: false }).range(page * 20, page * 20 + 19).then(({ data, error: failure }) => {
      if (!active) return;
      if (failure) setError(failure.message);
      else { setRuns(previous => page ? [...previous, ...(data as Run[])] : data as Run[]); setMore(data.length === 20); }
      setLoading(false);
    });
    return () => { active = false; };
  }, [session!.user.id, page, refresh]);
  return <div className="screen history-screen">
    <header className="page-header"><div><div className="overline">YOUR HISTORY</div><h1 className="page-title">A look back.</h1></div><button className="history-refresh" disabled={loading} onClick={() => { setPage(0); setOpen(null); setRefresh(value => value + 1); }}>{loading ? <Spinner /> : <Glyph name="refresh" size={18} />}Refresh</button></header>
    <p className="history-intro">Your sightings and warnings, all in one place. Camera images stay on your laptop.</p>
    {error && <p className="vision-error" role="alert">{error}</p>}
    {!loading && !error && !runs.length && <div className="location-empty history-empty"><span className="empty-emblem"><Glyph name="history" size={32} /></span><h2>Your history starts here.</h2><p>Start a cane or webcam run to save sightings and warnings.</p><button className="sheet-primary" onClick={startCamera}>Open camera<Glyph name="arrow" size={18} /></button></div>}
    <div className="history-list">{runs.map(run => <article className="history-run" key={run.id} data-open={open === run.id}>
      <button className="run-heading" aria-expanded={open === run.id} aria-controls={`run-${run.id}`} onClick={() => setOpen(value => value === run.id ? null : run.id)}>
        <span className="run-icon"><Glyph name={run.source_type === "webcam" ? "camera" : "history"} /></span>
        <span className="run-source">{run.source_type === "webcam" ? "Webcam test" : "Cane session"}<small>{new Date(run.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></span>
        <span className="run-status"><span className="run-badge" data-status={run.status}>{run.status}</span><Glyph name="chevron" size={18} /></span>
      </button>
      {run.simulated_distance_cm != null && <p className="run-simulation">Test distance: {run.simulated_distance_cm} cm</p>}
      <Disclosure open={open === run.id} id={`run-${run.id}`}><RunDetails id={run.id} /></Disclosure>
    </article>)}</div>
    {loading && <div className="history-loading" role="status"><span className="inline-loading"><Spinner />Loading your history…</span>{!runs.length && <div className="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>}</div>}
    {more && !loading && <button className="sheet-primary history-more" onClick={() => setPage(value => value + 1)}>Load more runs<Glyph name="chevron" size={18} /></button>}
  </div>;
}

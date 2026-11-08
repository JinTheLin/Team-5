import { useEffect, useRef, useState, type ReactNode } from "react";

const marks = {
  camera: <><path d="M14 5h-4L8 8H4a2 2 0 0 0-2 2v9h20v-9a2 2 0 0 0-2-2h-4z" /><circle cx="12" cy="13" r="3" /></>,
  history: <><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
};

export function Glyph({ name, size = 22 }: { name: keyof typeof marks; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{marks[name]}</svg>;
}

export function Spinner() {
  return <span className="ui-spinner" aria-hidden="true" />;
}

// Closing content stays mounted for its exit; inert immediately removes it from navigation.
export function Disclosure({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || ref.current?.closest(".reduce-motion");
    const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : 240);
    return () => clearTimeout(timer);
  }, [open]);
  return <div id={id} ref={ref} className={`disclosure${open ? " is-open" : ""}`} inert={!open} aria-hidden={!open}>
    <div>{(open || mounted) && children}</div>
  </div>;
}

export default Glyph;

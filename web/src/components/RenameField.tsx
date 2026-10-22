import { useEffect, useRef, useState } from "react";

/**
 * A session title that turns into a text box in place.
 *
 * Enter or leaving the field saves; Escape puts the old name back. Saving an
 * unchanged or empty name is a no-op rather than an error — clicking away is
 * how people say "never mind" as often as Escape.
 */
export function RenameField({
  value,
  editing,
  onDone,
  onSave,
  className = "",
  inputClassName = "",
}: {
  value: string;
  editing: boolean;
  onDone: () => void;
  onSave: (title: string) => Promise<void>;
  className?: string;
  inputClassName?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Enter saves and then blurs; without this the blur saves a second time.
  const settled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    settled.current = false;
    setDraft(value);
    setError(null);
    requestAnimationFrame(() => input.current?.select());
  }, [editing, value]);

  const commit = async () => {
    if (settled.current) return;
    const next = draft.replace(/\s+/g, " ").trim();
    if (!next || next === value) {
      settled.current = true;
      return onDone();
    }
    setSaving(true);
    try {
      await onSave(next);
      settled.current = true;
      onDone();
    } catch (e) {
      setError((e as Error).message);
      input.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  if (!editing) return <span className={`truncate ${className}`}>{value}</span>;

  return (
    <span className="flex min-w-0 flex-1 flex-col" onClick={(e) => e.stopPropagation()}>
      <input
        ref={input}
        value={draft}
        disabled={saving}
        maxLength={200}
        aria-label="Session name"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            settled.current = true;
            onDone();
          }
        }}
        onBlur={() => void commit()}
        className={`w-full min-w-0 rounded-md border border-accent/50 bg-canvas px-1.5 py-0.5 text-sm text-fg outline-none ${inputClassName}`}
      />
      {error && <span className="mt-0.5 text-[11px] text-danger">{error}</span>}
    </span>
  );
}

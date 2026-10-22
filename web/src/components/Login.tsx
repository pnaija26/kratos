import { useState } from "react";
import { api } from "../api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card-glass w-full max-w-[22rem] rounded-3xl p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="hero-halo"><img src="/logo-512.png" alt="" className="h-16 w-16 rounded-2xl object-contain shadow-lg ring-1 ring-accent/30" draggable={false} /></div>
          <h1 className="text-gradient mt-4 text-2xl font-bold tracking-tight">Kratos</h1>
          <p className="mt-1 text-xs text-fg-subtle">
            Give it a task, close the browser, come back later.
          </p>
        </div>

        <input
          autoFocus
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-fg outline-none transition placeholder:text-fg-faint focus:border-accent/50 focus:ring-4 focus:ring-accent/10"
        />
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}

        <button
          type="submit"
          disabled={busy || !password}
          className="btn-gold mt-3 w-full rounded-xl px-3 py-2.5 text-sm font-semibold disabled:opacity-40"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

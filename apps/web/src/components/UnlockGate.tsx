import { useState, type FormEvent } from 'react';
import { Lock, ArrowRight, ShieldCheck } from 'lucide-react';
import { BrandMark, Panel } from '@mj/ui';

interface UnlockGateProps {
  onLogin: (passcode: string) => Promise<void>;
  errorMessage?: string | null;
}

export function UnlockGate({ onLogin, errorMessage }: UnlockGateProps) {
  const [passcode, setPasscode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passcode.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onLogin(passcode);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <Panel elevated className="w-full max-w-md p-7 sm:p-8">
        <div className="flex items-center gap-3.5">
          <div
            className="grid h-11 w-11 place-items-center rounded-xl"
            style={{
              border: '1px solid rgba(199, 227, 245, 0.25)',
              background:
                'linear-gradient(145deg, rgba(164, 205, 232, 0.14), rgba(255, 255, 255, 0.02))',
            }}
          >
            <BrandMark className="h-6 w-6" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-[0.2em] text-[#EDF3F8]">
              MJ ASSISTANT
            </div>
            <div className="text-[11px] tracking-[0.14em] uppercase" style={{ color: 'var(--mj-text-subtle)' }}>
              STAGE 1 · PROTECTED SESSION
            </div>
          </div>
        </div>

        <h1 className="mt-6 text-xl font-medium tracking-tight text-[#EDF3F8]">
          Unlock your workspace
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--mj-text-muted)' }}>
          Enter the server access passcode to establish an HttpOnly session cookie.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label
              htmlFor="mj-passcode"
              className="mb-1.5 block text-xs font-medium tracking-[0.08em] uppercase"
              style={{ color: 'var(--mj-text-secondary)' }}
            >
              Access Passcode
            </label>
            <div
              className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5"
              style={{
                backgroundColor: '#07090E',
                border: '1px solid var(--mj-border-strong)',
              }}
            >
              <Lock className="h-4 w-4 shrink-0" style={{ color: 'var(--mj-accent-blue)' }} />
              <input
                id="mj-passcode"
                type="password"
                autoComplete="current-password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Enter passcode…"
                className="w-full bg-transparent text-sm text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
                autoFocus
              />
            </div>
          </div>

          {errorMessage && (
            <div
              role="alert"
              className="rounded-xl px-3.5 py-2.5 text-xs"
              style={{
                backgroundColor: 'rgba(240, 138, 138, 0.1)',
                border: '1px solid rgba(240, 138, 138, 0.3)',
                color: 'var(--mj-status-error)',
              }}
            >
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !passcode.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: 'linear-gradient(145deg, #DCEEF9, #9AC6E6)',
              color: '#070B11',
            }}
          >
            <span>{submitting ? 'Verifying…' : 'Unlock MJ Assistant'}</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>

        <div
          className="mt-6 flex items-center gap-2 border-t pt-4 text-xs"
          style={{
            borderColor: 'var(--mj-border-subtle)',
            color: 'var(--mj-text-subtle)',
          }}
        >
          <ShieldCheck className="h-4 w-4 shrink-0" style={{ color: 'var(--mj-status-good)' }} />
          <span>Your xAI API key remains isolated on the backend server.</span>
        </div>
      </Panel>
    </div>
  );
}

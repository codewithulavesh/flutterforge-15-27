import { useState } from 'react';
import { Eye, EyeOff, KeyRound, ExternalLink, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';

export function OpenRouterKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validated, setValidated] = useState(false);

  async function handleSave() {
    const trimmed = key.trim();
    if (!trimmed) { setError('Please enter your OpenRouter API key'); return; }
    setValidating(true);
    setError(null);
    try {
      // Validate key with a cheap models list call
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${trimmed}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        setError('Invalid API key — please check your OpenRouter dashboard');
        setValidating(false);
        return;
      }
      // Save to localStorage
      localStorage.setItem('openrouter_api_key', trimmed);
      setValidated(true);
      toast('success', 'OpenRouter key saved — ready to generate!');
      setTimeout(() => { setValidated(false); setKey(''); onClose(); }, 1200);
    } catch {
      setError('Could not validate key — check your internet connection');
    } finally {
      setValidating(false);
    }
  }

  function handleSkip() {
    // Save without validating (user may be offline)
    const trimmed = key.trim();
    if (trimmed) localStorage.setItem('openrouter_api_key', trimmed);
    onClose();
  }

  return (
    <Modal onClose={onClose} open={open} title="Add your OpenRouter API key">
      <div className="space-y-4">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-start gap-3">
            <KeyRound size={18} className="text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-200 mb-1">API key required</p>
              <p className="text-xs text-amber-300/80 leading-relaxed">
                FlutterForge uses OpenRouter to generate professional Flutter code with real AI models.
                Your key is stored locally and never sent to our servers.
              </p>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            OpenRouter API Key
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={(e) => { setKey(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
              placeholder="sk-or-v1-..."
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 pr-10 text-sm text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
            />
            <button
              type="button"
              onClick={() => setShowKey(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors"
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertCircle size={13} className="shrink-0" />
            {error}
          </div>
        )}

        {validated && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
            <CheckCircle2 size={13} className="shrink-0" />
            Key validated successfully!
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            onClick={() => void handleSave()}
            disabled={validating || !key.trim()}
            variant="primary"
          >
            {validating ? (
              <><Loader2 size={14} className="animate-spin mr-2" />Validating…</>
            ) : (
              <><CheckCircle2 size={14} className="mr-2" />Save & Validate</>
            )}
          </Button>
          <Button onClick={handleSkip} variant="outline" title="Save without validating">
            Skip
          </Button>
        </div>

        <div className="flex items-center justify-between pt-1">
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            Get a free key on OpenRouter
            <ExternalLink size={11} />
          </a>
          <span className="text-xs text-slate-500">Free tier available</span>
        </div>
      </div>
    </Modal>
  );
}

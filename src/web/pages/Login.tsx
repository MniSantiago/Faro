import { useState, type FormEvent } from 'react';
import { pair } from '../api';
import { defaultDeviceName } from '../push';

export function Login() {
  const [code, setCode] = useState('');
  const [name, setName] = useState(() => defaultDeviceName(navigator.userAgent));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await pair(code.trim(), name.trim() || 'Navegador');
      location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <h1>Faro</h1>
      <p>Este dispositivo no está vinculado. Abre Faro en tu Mac → Dispositivos → Vincular un dispositivo, y escribe aquí el código de 6 dígitos.</p>
      <form onSubmit={submit} className="qform">
        <label>Código
          <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus />
        </label>
        <label>Nombre de este dispositivo
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}

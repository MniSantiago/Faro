import { useCallback, useEffect, useState } from 'react';
import type { Device } from '../../server/types';
import { authState, createPairingCode, deviceProjects, devices, pushKey, pushSubscribe, pushTest, pushUnsubscribe, revokeDevice, setDeviceProject } from '../api';
import { useProject } from '../project';
import { isIos, isStandalone, urlBase64ToUint8Array } from '../push';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function PairingCode({ code, expiresAt, onExpire }: { code: string; expiresAt: string; onExpire: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { clearInterval(t); onExpire(); }
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpire]);
  return (
    <div className="card">
      <p className="paircode" aria-label="Código de vinculación">{code}</p>
      <p className="muted">Caduca en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}. Escríbelo en el dispositivo que quieras vincular.</p>
    </div>
  );
}

/** Un interruptor por proyecto: «Avisos de <proyecto>» en este dispositivo vinculado. */
function DeviceProjects({ deviceId }: { deviceId: string }) {
  const [list, setList] = useState<{ id: string; name: string; muted: boolean }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let ignore = false;
    deviceProjects(deviceId).then((r) => { if (!ignore) setList(r.projects); }).catch((e: Error) => { if (!ignore) setError(e.message); });
    return () => { ignore = true; };
  }, [deviceId]);
  const toggle = async (pid: string, on: boolean) => {
    setBusy(pid); setError(null);
    try {
      await setDeviceProject(deviceId, pid, on);
      setList((cur) => cur?.map((p) => (p.id === pid ? { ...p, muted: !on } : p)) ?? cur);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (error && !list) return <p className="error">{error}</p>;
  if (!list) return null;
  return (
    <div className="dev-projects">
      {list.map((p) => (
        <label key={p.id} className="check">
          <input type="checkbox" checked={!p.muted} disabled={busy === p.id} onChange={(e) => void toggle(p.id, e.target.checked)} />
          Avisos de {p.name}
        </label>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Notifications() {
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const [perm, setPerm] = useState<string>(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  const [active, setActive] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) return;
    setPerm(Notification.permission);
    try {
      const reg = await navigator.serviceWorker.ready;
      setActive((await reg.pushManager.getSubscription()) !== null);
    } catch { setActive(false); }
  }, [supported]);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setError(null); setMsg(null);
    try { const m = await fn(); if (m) setMsg(m); } catch (e) { setError((e as Error).message); } finally { setBusy(false); await refresh(); }
  };

  const enable = () => run(async () => {
    const p = await Notification.requestPermission();
    if (p !== 'granted') throw new Error('Permiso de avisos denegado. Cámbialo en los ajustes del navegador.');
    const { publicKey } = await pushKey();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    const j = sub.toJSON();
    if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) throw new Error('La suscripción no es válida');
    await pushSubscribe({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } });
    return 'Avisos activados en este dispositivo.';
  });
  const disable = () => run(async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await pushUnsubscribe(sub.endpoint); await sub.unsubscribe(); }
    return 'Avisos desactivados.';
  });
  const test = () => run(async () => {
    const r = await pushTest();
    return `Aviso enviado a ${r.sent} dispositivo(s)${r.failed ? `, ${r.failed} con error` : ''}.`;
  });

  const needsInstall = isIos() && !isStandalone();
  return (
    <section>
      <h2>Avisos en este dispositivo</h2>
      {needsInstall && <p className="notice">Añade Faro a la pantalla de inicio (Compartir → Añadir a pantalla de inicio) para recibir avisos.</p>}
      {!supported ? <p className="muted">Este navegador no admite avisos push.</p> : (
        <>
          <p>Estado: {perm === 'granted' ? (active ? 'activados' : 'permitidos, sin suscripción') : perm === 'denied' ? 'bloqueados' : 'sin activar'}</p>
          <p className="actions">
            {!active && <button className="btn primary" disabled={busy || needsInstall} onClick={enable}>Activar avisos</button>}
            {active && <button className="btn" disabled={busy} onClick={disable}>Desactivar</button>}
            <button className="btn" disabled={busy} onClick={test}>Enviar aviso de prueba</button>
          </p>
        </>
      )}
      {msg && <p role="status">{msg}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

export function Devices() {
  const [local, setLocal] = useState(false);
  const [list, setList] = useState<Device[] | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const many = useProject().projects.length > 1;

  const load = useCallback(() => { devices().then(setList).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => { load(); authState().then((s) => setLocal(s.local)).catch(() => {}); }, [load]);
  const expire = useCallback(() => setPairing(null), []);

  const newCode = async () => {
    setError(null);
    try { setPairing(await createPairingCode()); } catch (e) { setError((e as Error).message); }
  };
  const revoke = async (d: Device) => {
    if (!confirm(`¿Revocar «${d.name}»? Dejará de tener acceso.`)) return;
    setError(null);
    try { await revokeDevice(d.id); load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div>
      <h1>Dispositivos</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {local && (
        <section>
          <button className="btn primary" onClick={newCode}>Vincular un dispositivo</button>
          {pairing && <PairingCode code={pairing.code} expiresAt={pairing.expiresAt} onExpire={expire} />}
        </section>
      )}
      {!list ? <p className="muted">Cargando…</p> : list.length === 0 ? <p className="muted">No hay dispositivos vinculados.</p> : (
        <ul className="routines">
          {list.map((d) => (
            <li key={d.id} className="card">
              <div className="row">
                <strong>{d.name}</strong>
                <button className="btn small" onClick={() => revoke(d)}>Revocar</button>
              </div>
              <span className="muted">Creado {fmt(d.createdAt)} · último uso {fmt(d.lastSeenAt)}</span>
              {many && <DeviceProjects deviceId={d.id} />}
            </li>
          ))}
        </ul>
      )}
      <Notifications />
      <section>
        <h2>Acceso desde fuera de casa</h2>
        <ol>
          <li>Instala Tailscale en el Mac y en el iPhone, con la misma cuenta.</li>
          <li>En el Mac ejecuta: <code>tailscale serve --bg --https=443 http://127.0.0.1:3200</code></li>
          <li>Añade el nombre <code>&lt;mac&gt;.&lt;tailnet&gt;.ts.net</code> a <code>allowedHosts</code> en <code>faro.config.ts</code> y reinicia Faro.</li>
          <li>Abre <code>https://&lt;mac&gt;.&lt;tailnet&gt;.ts.net</code> en el iPhone.</li>
        </ol>
      </section>
    </div>
  );
}

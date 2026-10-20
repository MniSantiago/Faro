/** Logo de Faro «haz de luz»: torre y base con el color del texto; linterna y haz en ámbar. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false" className="logo">
      <path d="M22 14 L46 6 L46 22 Z" fill="var(--accent)" opacity=".55" />
      <rect x="16" y="11" width="8" height="6" rx="1.5" fill="var(--accent)" />
      <path d="M17 18 H23 L25 40 H15 Z" fill="currentColor" />
      <path d="M8 40 H32" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

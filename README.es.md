# Faro

[English](README.md)

Faro es un panel de mando que instalas en tu máquina para orquestar agentes de [Claude Code](https://claude.com/claude-code) sobre tus propios repositorios. Describes una tarea desde la web (o desde el móvil), Faro lanza `claude -p` en un worktree de git aislado, pasa tus comprobaciones y te deja el resultado para revisarlo, integrarlo y subirlo. Es gratis, con licencia MIT, y lo adaptas a tus proyectos con un solo archivo de configuración en TypeScript.

## Qué hace

- **Tareas en worktrees de git.** Cada tarea tiene su rama y su worktree, así que varios agentes trabajan a la vez sin pisarse.
- **Niveles de autonomía, por tarea o rutina:**

  | Nivel | Puede hacer solo | Necesita tu aprobación |
  |---|---|---|
  | 1. Solo lectura | Leer el repo y escribir un informe | Cualquier escritura en el repo |
  | 2. Borrador (por defecto) | Escribir en su worktree | Merge, push, publicar versión |
  | 3. Merge automático | Integrar en la rama base si las comprobaciones pasan | Push, publicar versión |
  | 4. Autónomo | Push y lanzar un build | Publicar en tiendas o redes (siempre) |

- **Revisión.** Diff, comprobaciones, aprobar e integrar (fast-forward, o PR con squash al pasar el CI), subir o parar un agente en marcha.
- **Perfiles.** Roles con sus instrucciones, nivel por defecto y tiempo máximo (coordinador, desarrollo, calidad, análisis…). El coordinador divide un objetivo en subtareas.
- **Rutinas.** Tareas periódicas con cron: revisión de bugs, auditoría de dependencias, resumen del estado del proyecto…
- **GitHub (opcional, con `gh`).** Vigila el CI de la rama base y crea una tarea de arreglo cuando falla; integra cada tarea por PR.
- **PWA para el móvil.** Bandeja, nuevas tareas y avisos push (web push con VAPID). Acceso remoto por Tailscale con emparejamiento de dispositivos.
- **Sandbox.** En macOS, los agentes y las comprobaciones corren dentro de `sandbox-exec`, y los comandos peligrosos (`git push`, `gh api`, publicar…) están bloqueados.
- **Métricas y ASO (opcional, para apps móviles).** RevenueCat, PostHog y App Store Connect, y seguimiento de keywords de la App Store.

## Requisitos

- **macOS.** El sandbox (`sandbox-exec`), los secretos (llavero con `security`) y el arranque automático (`launchd`) son solo de macOS de momento.
- **Node 22 o ≥24.** `better-sqlite3` falla en Node 23. Hay un `.nvmrc`: ejecuta `nvm use` primero.
- **La CLI `claude`** con la sesión iniciada (`claude login`). Los agentes usan tu propia cuenta y tu cuota de Claude.
- `gh` con la sesión iniciada, si usas la integración con GitHub.

## Puesta en marcha

```bash
git clone <url-del-repo> faro && cd faro
nvm use
npm install
cp faro.config.example.ts faro.config.ts   # edítalo: proyectos, perfiles, rutinas
npm run build:web
npm start                                   # http://127.0.0.1:3200
```

Git ignora `faro.config.ts`, así que tus proyectos y prompts no salen de tu máquina. Para guardarlo en otro sitio, usa `FARO_CONFIG=/ruta/a/faro.config.ts`.

Desarrollo: `npm run dev` (servidor) y `npm run dev:web` (web en :5173 con proxy a la API).

Arranque automático en el Mac: `scripts/install-launchd.sh` (usa el Node activo; con otro, `FARO_NODE=/ruta/a/node`). Para pararlo: `launchctl bootout gui/$(id -u)/com.faro.server`.

## Personalizarlo

Toda tu configuración vive en `faro.config.ts`:

- `projects`: ruta del repo, rama base, prefijo de las tareas (`DEM-1`…), comandos `prepare` para cada worktree nuevo, `checks` que tiene que pasar una tarea, `routines` y los bloques opcionales `github`, `metrics`, `aso` y `release`.
- `profiles`: los roles y las instrucciones que recibe cada agente.
- `maxConcurrentRuns`, `host`, `port`, `dataDir`, `allowedHosts` (para el acceso remoto).

Los secretos nunca van en la config. Faro los lee del llavero de macOS (servicio `faro`), y la página Métricas muestra el comando exacto para guardar cada uno:

```bash
security add-generic-password -U -s faro -a posthog -w
```

Limitación conocida: el embudo de PostHog usa nombres de eventos fijos en `src/server/metrics/posthog.ts`. Cámbialos por los de tu app.

## Datos

Todo vive en `~/.faro` (o en tu `dataDir`): `faro.db` (SQLite), `artifacts/`, `worktrees/`, `logs/` y `vapid.json`.

## Pruebas

- `npm test`: suite completa con un `claude` simulado.
- `npm run smoke`: prueba real con la CLI de Claude (gasta un poco de cuota).
- `npm run typecheck`.

## Licencia

[MIT](LICENSE)

// Copy this file to `faro.config.ts` (ignored by git) and adapt it to your projects.
// Copia este archivo a `faro.config.ts` (git lo ignora) y adáptalo a tus proyectos.
import type { FaroConfigInput } from './src/server/types';

const config: FaroConfigInput = {
  // Nombre del panel en la web.
  title: 'Faro',
  host: '127.0.0.1',
  port: 3200,
  dataDir: '~/.faro',
  claudeBin: 'claude',
  // Optional global cap on simultaneous agents across all projects (each project has its own limit, 2 by default).
  // Tope global opcional de agentes simultáneos entre todos los proyectos (cada proyecto tiene su límite, 2 por defecto).
  // maxConcurrentRuns: 3,
  // Contacto para los avisos push (VAPID): una URL o un `mailto:`.
  pushContact: 'mailto:you@example.com',
  // Acceso remoto opcional por Tailscale (`tailscale serve --bg --https=443 http://127.0.0.1:3200`).
  // allowedHosts: ['<mac>.<tailnet>.ts.net'],
  // Perfil de los chats y de dividir objetivos en subtareas (por defecto «coordinador»).
  coordinatorProfile: 'coordinador',
  // Waits of the Claude CLI on usage limits and overload (CLAUDE_CODE_RETRY_WATCHDOG); on by default, 5 min max each.
  // Esperas de la CLI ante límites de uso y sobrecarga (CLAUDE_CODE_RETRY_WATCHDOG); activado por defecto, 5 min como máximo.
  // retryWatchdog: { enabled: true, maxWaitMs: 5 * 60_000, maxUsageLimitWaitMs: 5 * 60_000 },
  projects: [
    {
      id: 'demo',
      name: 'Demo',
      // Prefijo de las tareas: DEM-1, DEM-2… (startNumber cambia el primer número).
      prefix: 'DEM',
      repoPath: '~/code/demo',
      baseBranch: 'main',
      remote: 'origin',
      worktreesDir: '~/.faro/worktrees/demo',
      // Agentes simultáneos de este proyecto (por defecto 2).
      maxConcurrentRuns: 2,
      // Instrucciones del proyecto para todos los perfiles (van tras las del perfil, bajo «Sobre Demo:»),
      // y notas que solo recibe un perfil en este proyecto.
      // instructions: 'Demo es una app web en React; el código está en src/ y los tests en test/.',
      // profileNotes: { calidad: 'En Demo los tests de integración tardan: ejecútalos solo si tocas src/api/.' },
      // GitHub con `gh`: vigila el CI de main y cada tarea se integra por PR (squash al pasar el CI).
      // ciProfile: perfil de las tareas que arreglan el CI.
      // github: { ci: true, prs: true, ciProfile: 'dev' },
      // Comandos que se ejecutan en cada worktree nuevo antes de lanzar al agente.
      prepare: ['ln -sfn "$HOME/code/demo/node_modules" node_modules'],
      // Rutas que nunca se commitean desde un worktree (p. ej. los enlaces de prepare).
      exclude: ['node_modules'],
      // Comprobaciones que tiene que pasar una tarea antes de revisión.
      checks: [
        { name: 'Tipos', command: 'npm run typecheck' },
        { name: 'Tests', command: 'npm test' },
      ],
      // Métricas opcionales (los secretos van en el llavero o en FARO_SECRET_*, ver README):
      // metrics: {
      //   revenuecatProjectId: '…', ascAppId: '…',
      //   posthogHost: 'https://eu.posthog.com', posthogProjectId: '…',
      //   posthogFunnel: {
      //     title: 'Embudo de registro',
      //     filter: "properties.$host = 'app.example.com'",
      //     steps: [
      //       { event: 'signup_started', label: 'Registro iniciado' },
      //       { event: 'signup_completed', label: 'Registro completado' },
      //       { event: 'purchase', label: 'Compra', where: "properties.plan != 'free'" },
      //     ],
      //     conversion: { from: 'signup_completed', to: 'purchase', label: 'Conversión registro → compra' },
      //   },
      // },
      // Lanzamientos opcionales (build y envío tras integrar; pensado para EAS / App Store):
      // release: { cwd: 'app', build: 'npx eas-cli build …', submit: 'npx eas-cli submit … --id {buildId}' },
      // ASO opcional para apps de la App Store:
      // aso: { appId: '1234567890', stores: [{ id: 'en', country: 'us', storefront: '143441-1,29', fichaFile: 'store/en.md' }] },
      routines: [
        {
          // Sin cron: se lanza a mano desde Rutinas.
          id: 'estado-proyecto', name: 'Resumen del estado del proyecto', profileId: 'analisis', level: 1, context: 'estado',
          title: 'Estado del proyecto ({fecha})',
          prompt:
            'Haz un resumen de cómo va el proyecto a fecha {fecha}, para leerlo en dos minutos. Parte del estado de Faro que va al final ' +
            'y complétalo con el repo (`git log --since=14.days --oneline`, ramas sin fusionar). ' +
            'Estructúralo en: en una frase, listo, a medias (qué falta y quién lo mueve) y pendiente por prioridad.',
        },
        {
          id: 'revision-bugs', name: 'Revisión de bugs y code smells', cron: '0 9 * * 4', profileId: 'calidad', level: 1,
          title: 'Revisión de bugs ({fecha})',
          prompt:
            'Revisa el código en busca de bugs y code smells, empezando por lo que ha cambiado en los últimos 7 días ' +
            '(`git log --since=7.days`). No cambies código. Da los hallazgos ordenados por gravedad, cada uno con archivo:línea, ' +
            'qué falla y cómo comprobarlo. Para los graves propone subtareas (perfil dev, nivel 2) con el arreglo y un test que lo cubra.',
          // Spending cap per run in USD (--max-budget-usd); overrides the profile's one.
          // Tope de gasto por ejecución en dólares (--max-budget-usd); manda sobre el del perfil.
          // maxBudgetUsd: 1.5,
        },
        {
          id: 'dependencias', name: 'Dependencias y seguridad', cron: '0 10 * * 1', profileId: 'calidad', level: 1,
          title: 'Dependencias y seguridad ({fecha})',
          prompt:
            'Ejecuta `npm audit` y `npm outdated` (solo para leer). Para cada vulnerabilidad di gravedad, paquete, si nos afecta ' +
            'y cómo se arregla. Separa las actualizaciones seguras de las que piden trabajo y propone subtareas para estas últimas.',
        },
      ],
    },
    // A project with several repos: each task picks which ones it works on (all by default) and they are merged
    // together or not at all. Repo fields (path, baseBranch, remote, prepare, exclude, checks, release) go per repo.
    // Un proyecto con varios repos: cada tarea elige en cuáles trabaja (por defecto, en todos) y se integran todos
    // juntos o ninguno. Los campos de repo (path, baseBranch, remote, prepare, exclude, checks, release) van por repo.
    // {
    //   id: 'tienda',
    //   name: 'Tienda',
    //   prefix: 'TIE',
    //   worktreesDir: '~/.faro/worktrees/tienda',
    //   maxConcurrentRuns: 2,
    //   // Carpeta común de los repos: los agentes la pueden leer pero no escribir en ella.
    //   rootPath: '~/code/tienda',
    //   // Copia ~/code/tienda/CLAUDE.md a la carpeta de cada tarea (por defecto, no).
    //   // copyRootClaudeMd: true,
    //   repos: [
    //     {
    //       id: 'app', name: 'App', path: '~/code/tienda/app', baseBranch: 'main', remote: 'origin',
    //       prepare: ['ln -sfn "$HOME/code/tienda/app/node_modules" node_modules'], exclude: ['node_modules'],
    //       checks: [{ name: 'Tests', command: 'npm test' }],
    //     },
    //     {
    //       id: 'api', name: 'API', path: '~/code/tienda/api', baseBranch: 'main', remote: 'origin',
    //       prepare: ['ln -sfn "$HOME/code/tienda/api/node_modules" node_modules'], exclude: ['node_modules'],
    //       checks: [{ name: 'Tests', command: 'npm test' }],
    //     },
    //   ],
    //   // En la carpeta de cada tarea hay una subcarpeta por repo (app/, api/), cada una un worktree en la rama de la tarea.
    //   instructions: 'Tienda tiene la app en app/ y la API en api/; si cambias un endpoint, actualiza también su cliente en app/.',
    //   // Rutinas: `repos` limita sus tareas a algunos repos (si falta, todos).
    //   routines: [],
    // },
  ],
  profiles: [
    {
      id: 'coordinador',
      name: 'Coordinador',
      instructions:
        'Recibes un objetivo y lo divides en tareas concretas e independientes para los demás perfiles. No escribes código.',
      defaultLevel: 1,
      timeoutMinutes: 20,
    },
    {
      id: 'dev',
      name: 'Desarrollo',
      instructions:
        'Trabajas en el código del proyecto. Sigues las convenciones del código existente y añades tests cuando cambias lógica.',
      // Optional per profile: model, reasoning effort ('low' | 'medium' | 'high' | 'xhigh' | 'max', --effort) and a
      // spending cap per run in USD (--max-budget-usd; when reached, the task is blocked with that reason).
      // Opcionales por perfil: modelo, esfuerzo de razonamiento (--effort) y tope de gasto por ejecución en dólares
      // (--max-budget-usd; al alcanzarlo, la tarea se bloquea con ese motivo).
      // model: 'claude-opus-5-5', effort: 'high', maxBudgetUsd: 3,
      // isolation: 'minimal' (default) loads only the repo's CLAUDE.md and settings, the profile's mcpConfig and the tools
      // its level allows — none of your plugins, skills, hooks, auto-memory or ~/.claude/CLAUDE.md (much cheaper per run).
      // 'user' also loads your user configuration from ~/.claude.
      // isolation: 'minimal' (por defecto) carga solo el CLAUDE.md y los ajustes del repo, el mcpConfig del perfil y las
      // herramientas de su nivel: nada de tus plugins, skills, hooks, memoria ni ~/.claude/CLAUDE.md (mucho más barato).
      // 'user' carga además tu configuración de ~/.claude.
      // isolation: 'minimal',
      defaultLevel: 2,
      timeoutMinutes: 45,
    },
    {
      id: 'calidad',
      name: 'Calidad',
      instructions:
        'Cuidas la calidad del código: buscas bugs, code smells y código muerto. No cambias comportamiento sin un test ' +
        'que lo cubra y justificas cada hallazgo con archivo y línea.',
      defaultLevel: 1,
      timeoutMinutes: 45,
    },
    {
      id: 'analisis',
      name: 'Análisis',
      instructions: 'Analizas el proyecto y escribes informes breves con conclusiones accionables. No modificas el repositorio.',
      defaultLevel: 1,
      timeoutMinutes: 20,
    },
  ],
};

export default config;

// Copy this file to `faro.config.ts` (ignored by git) and adapt it to your projects.
// Copia este archivo a `faro.config.ts` (git lo ignora) y adáptalo a tus proyectos.
import type { FaroConfig } from './src/server/types';

const config: FaroConfig = {
  // Nombre del panel en la web.
  title: 'Faro',
  host: '127.0.0.1',
  port: 3200,
  dataDir: '~/.faro',
  claudeBin: 'claude',
  maxConcurrentRuns: 2,
  // Contacto para los avisos push (VAPID): una URL o un `mailto:`.
  pushContact: 'mailto:you@example.com',
  // Acceso remoto opcional por Tailscale (`tailscale serve --bg --https=443 http://127.0.0.1:3200`).
  // allowedHosts: ['<mac>.<tailnet>.ts.net'],
  // Perfil de los chats y de dividir objetivos en subtareas (por defecto «coordinador»).
  coordinatorProfile: 'coordinador',
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

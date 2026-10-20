# Faro

[Español](README.es.md)

Faro is a self-hosted control panel for running [Claude Code](https://claude.com/claude-code) agents on your own repositories. You describe a task from the web UI (or your phone), Faro runs `claude -p` in an isolated git worktree, runs your checks, and leaves the result for you to review, merge and push. It's free, MIT-licensed, and you set it up for your own projects with a single TypeScript config file.

> The UI and agent prompts are in Spanish for now. Translations are welcome.

## What it does

- **Tasks in git worktrees.** Each task gets its own branch and worktree, so several agents can work at once without stepping on each other.
- **Autonomy levels, per task or routine:**

  | Level | Can do on its own | Needs your approval |
  |---|---|---|
  | 1. Read-only | Read the repo and write a report | Any write to the repo |
  | 2. Draft (default) | Write in its worktree | Merge, push, release |
  | 3. Auto-merge | Merge to the base branch when checks pass | Push, release |
  | 4. Autonomous | Push and start a build | Publishing to stores or social media (always) |

- **Review flow.** Diff, checks, approve and merge (fast-forward, or PR + squash once CI passes), push, or stop a running agent.
- **Profiles.** Roles with their own instructions, default level and timeout (coordinator, dev, quality, analysis…). The coordinator splits a goal into subtasks.
- **Routines.** Recurring tasks on a cron schedule: bug reviews, dependency audits, project status reports, and so on.
- **GitHub (optional, via `gh`).** Watches CI on the base branch and opens a fix task when it fails; merges each task through a PR.
- **Mobile PWA.** Inbox, new tasks and push notifications (web push with VAPID). Remote access over Tailscale, with device pairing.
- **Sandbox.** On macOS, agents and checks run inside `sandbox-exec`, and dangerous commands (`git push`, `gh api`, publishing…) are blocked.
- **Metrics and ASO (optional, for mobile apps).** RevenueCat, PostHog and App Store Connect, plus App Store keyword tracking.

## Requirements

- **macOS recommended.** The agent sandbox (`sandbox-exec`), the Keychain and autostart (`launchd`) are macOS-only. On Linux Faro runs without the sandbox, and you pass secrets as environment variables.
- **Node 22 or ≥24.** `better-sqlite3` crashes on Node 23. There's an `.nvmrc`, so run `nvm use` first.
- **The `claude` CLI**, signed in (`claude login`). Agents run on your own Claude account and usage.
- `gh`, signed in, if you use the GitHub integration.

## Getting started

```bash
git clone <repo-url> faro && cd faro
nvm use
npm install
cp faro.config.example.ts faro.config.ts   # edit it: projects, profiles, routines
npm run build:web
npm start                                   # http://127.0.0.1:3200
```

`faro.config.ts` is git-ignored, so your projects and prompts stay on your machine. To keep it somewhere else, set `FARO_CONFIG=/path/to/faro.config.ts`.

Development: `npm run dev` (server) and `npm run dev:web` (UI on :5173, proxying the API).

Start at login on macOS: `scripts/install-launchd.sh` (uses the active Node; to pick another one, set `FARO_NODE=/path/to/node`). To stop it: `launchctl bootout gui/$(id -u)/com.faro.server`.

## Customizing it

Your whole setup lives in `faro.config.ts` (see [`faro.config.example.ts`](faro.config.example.ts)):

| Option | What it does |
|---|---|
| `title` | Panel name shown in the UI (default `Faro`). |
| `profiles` | Roles: instructions each agent gets, default level and timeout. |
| `coordinatorProfile` | Profile used for chats and for splitting goals into subtasks (default `coordinador`). |
| `projects[].repoPath`, `baseBranch`, `prefix`, `startNumber` | Which repo, which branch, and how tasks are numbered (`DEM-1`…). |
| `projects[].prepare`, `exclude` | Commands run in each new worktree (e.g. symlink `node_modules`) and paths never committed. |
| `projects[].checks` | Commands a task must pass before review; `whenChanged` limits one to a folder. |
| `projects[].routines` | Recurring tasks with a cron schedule, profile, level and prompt (`{fecha}` is today's date). |
| `projects[].github` | `ci` watches CI, `prs` merges through PRs, `ciProfile` picks who fixes a failing CI. |
| `projects[].metrics` | RevenueCat, App Store Connect and PostHog; `posthogFunnel` defines your funnel steps, filters and conversion card. |
| `projects[].aso`, `release` | App Store keyword tracking, and build/submit commands after merging (EAS by default). |
| `maxConcurrentRuns`, `host`, `port`, `dataDir`, `allowedHosts`, `sandbox` | Server and runtime settings. |

The menu only shows Metrics and ASO when a project uses them, and the Plan page only shows the store sections when the project has `release`.

Secrets never go in the config. You can give each one in either of two ways (the Metrics page shows the exact command for each):

```bash
security add-generic-password -U -s faro -a posthog -w
```

or, on any OS, as an environment variable when starting Faro (`FARO_SECRET_POSTHOG`, `FARO_SECRET_REVENUECAT`, `FARO_SECRET_ASC_KEY_ID`, `FARO_SECRET_ASC_ISSUER`, `FARO_SECRET_ASC_P8`, `FARO_SECRET_GITHUB_LECTURA`). Faro removes them from its environment at startup so agents and checks never inherit them.

## Data

Everything lives in `~/.faro` (or your `dataDir`): `faro.db` (SQLite), `artifacts/`, `worktrees/`, `logs/` and `vapid.json`.

## Tests

- `npm test`: full suite, using a fake `claude`.
- `npm run smoke`: a real run with the Claude CLI (uses a little of your quota).
- `npm run typecheck`.

## License

[MIT](LICENSE)

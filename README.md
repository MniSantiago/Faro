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

- **macOS.** The sandbox (`sandbox-exec`), secrets (Keychain via `security`) and autostart (`launchd`) are macOS-only for now.
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

Your whole setup lives in `faro.config.ts`:

- `projects`: the repo path, base branch, task prefix (`DEM-1`…), `prepare` commands for each new worktree, `checks` a task must pass, `routines`, and optional `github`, `metrics`, `aso` and `release` blocks.
- `profiles`: the roles and the instructions each agent gets.
- `maxConcurrentRuns`, `host`, `port`, `dataDir`, `allowedHosts` (for remote access).

Secrets never go in the config. Faro reads them from the macOS Keychain (service `faro`), and the Metrics page shows the exact command to save each one:

```bash
security add-generic-password -U -s faro -a posthog -w
```

Known limitation: the PostHog funnel uses fixed event names in `src/server/metrics/posthog.ts`. Change them to match your app.

## Data

Everything lives in `~/.faro` (or your `dataDir`): `faro.db` (SQLite), `artifacts/`, `worktrees/`, `logs/` and `vapid.json`.

## Tests

- `npm test`: full suite, using a fake `claude`.
- `npm run smoke`: a real run with the Claude CLI (uses a little of your quota).
- `npm run typecheck`.

## License

[MIT](LICENSE)

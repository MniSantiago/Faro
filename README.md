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
- **Several projects, several repos.** Each project is independent (tasks, routines, agent limit, spend, notifications, secrets); only profiles are shared. A project can span several repos: a task picks which ones it works on, and they are merged together or not at all.
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

## Home and settings panel

- **Home.** The landing page sums up each project: a headline, key figures, health (CI, last build, store version, open PRs, failed routines) and the week's activity. Each figure opens a detail view with its daily series and breakdowns. Without `metrics`, GitHub or `release` it still works and shows Faro's own spend, health and week.
- **Settings panel.** Routines, profiles, project and general settings can be edited from the web. `faro.config.ts` is the seed: whatever you change in the panel is saved in the database and takes precedence over the file, field by field, and applies without a restart. "Volver a la config" (back to config) drops the change and restores the file's value. Server settings (`host`, `port`, `dataDir`, `allowedHosts`, `claudeBin`, `sandbox`…) and a profile's `mcpConfig` are only edited in the file, and so are routines that publish to the stores.
- **From a paired device** (your phone over Tailscale) you can only change routines and profiles up to level 2: nothing that is already level 3–4, the coordinator profile, or a profile used by a level 3–4 routine. Project and General settings can only be changed from the Mac. The server enforces this; the UI just disables the controls.
- **Routine assistant.** Describe a routine in one sentence and Claude drafts it (name, schedule, profile, level 1–2, context, budget and prompt) for you to review before saving. Each call runs `claude` with a minimal setup and a $0.50 cap, so it costs very little but is not free, and it's charged to your account. One draft at a time, at most 50 per day.

## Customizing it

Your whole setup lives in `faro.config.ts` (see [`faro.config.example.ts`](faro.config.example.ts)):

| Option | What it does |
|---|---|
| `title` | Panel name shown in the UI (default `Faro`). |
| `profiles` | Roles: instructions each agent gets, default level and timeout; optional `model`, `effort` (`--effort`), `isolation` (`minimal` by default: agents load only the repo's own Claude setup, not your plugins, skills or global CLAUDE.md; `user` loads them too) and `maxBudgetUsd` (spending cap per run: when reached, the task is blocked). |
| `coordinatorProfile` | Profile used for chats and for splitting goals into subtasks (default `coordinador`). |
| `projects[].repoPath`, `baseBranch`, `prefix`, `startNumber` | Which repo, which branch, and how tasks are numbered (`DEM-1`…). |
| `projects[].repos` | Instead of `repoPath`/`baseBranch`/`remote`, a list of repos (`id`, `name`, `path`, `baseBranch`, `remote`, and per repo `prepare`, `exclude`, `checks`, `release`). See [Several repos in one project](#several-repos-in-one-project). |
| `projects[].rootPath`, `copyRootClaudeMd` | Common folder of a multi-repo project (agents can read it but not write to it), and whether its `CLAUDE.md` is copied into each task folder (off by default). |
| `projects[].instructions`, `profileNotes` | Project instructions every profile gets after its own (under "Sobre <project>:"), and notes only one profile gets in this project (`{ <profileId>: 'text' }`). Keep profiles generic and put project specifics here. |
| `projects[].maxConcurrentRuns` | Agents of this project running at once (default 2). A full project doesn't hold back the others. |
| `projects[].prepare`, `exclude` | Commands run in each new worktree (e.g. symlink `node_modules`) and paths never committed. |
| `projects[].checks` | Commands a task must pass before review; `whenChanged` limits one to a folder. |
| `projects[].routines` | Recurring tasks with a cron schedule, profile, level and prompt (`{fecha}` is today's date); `maxBudgetUsd` overrides the profile's cap; `repos` limits a multi-repo routine to some repos. |
| `projects[].github` | `ci` watches CI, `prs` merges through PRs, `ciProfile` picks who fixes a failing CI. |
| `projects[].metrics` | RevenueCat, App Store Connect and PostHog; `posthogFunnel` defines your funnel steps, filters and conversion card. |
| `projects[].aso`, `release` | App Store keyword tracking, and build/submit commands after merging (EAS by default). |
| `retryWatchdog` | How long the CLI keeps retrying on overload and usage limits (on by default, 5 min max) before Faro pauses the queue. |
| `maxConcurrentRuns` | Optional global cap on agents across all projects. Without it, each project only follows its own limit. |
| `host`, `port`, `dataDir`, `allowedHosts`, `sandbox` | Server and runtime settings. |

The menu only shows Metrics and ASO when a project uses them, and the Plan page only shows the store sections when the project has `release`.

Secrets never go in the config. You can give each one in either of two ways (the Metrics page shows the exact command for each):

```bash
security add-generic-password -U -s faro -a posthog -w
```

or, on any OS, as an environment variable when starting Faro (`FARO_SECRET_POSTHOG`, `FARO_SECRET_REVENUECAT`, `FARO_SECRET_ASC_KEY_ID`, `FARO_SECRET_ASC_ISSUER`, `FARO_SECRET_ASC_P8`, `FARO_SECRET_GITHUB_LECTURA`). Faro removes them from its environment at startup so agents and checks never inherit them.

With several projects, each metrics secret (`revenuecat`, `posthog`, `asc-*`) can also be given per project: Keychain account `<name>:<project>` (e.g. `revenuecat:tienda`) or the variable `FARO_SECRET_<NAME>_<PROJECT>` (uppercase, `-` and `:` become `_`, e.g. `FARO_SECRET_REVENUECAT_TIENDA`). If a project has none of its own, it uses the general one, so projects can share an App Store Connect or PostHog key and keep separate RevenueCat keys.

## Several projects

With more than one project, a project picker appears in the sidebar. Everything in the UI (home, inbox, chats, history, routines, plan, metrics, ASO, spend) shows only the current project; the picked project is remembered per device, and links can pin it with `?p=<id>`. Opening a task switches to its project. In **Devices**, each paired device chooses which projects it gets notifications from (all by default), and notification titles carry the project name.

### Several repos in one project

Use `repos` instead of `repoPath` (see the commented `tienda` project in [`faro.config.example.ts`](faro.config.example.ts)). Tasks share one numbering, and when creating one you tick the repos it works on (all by default). Then:

- The task gets a folder `worktreesDir/<branch>/` with one worktree per repo (`<branch>/<repoId>/`), all on the same branch. The agent runs in that folder and is told which subfolder is which repo.
- `prepare`, `exclude` and `checks` run per repo, inside its worktree; `whenChanged` is relative to the repo, and checks of repos without changes are skipped.
- **Merging is atomic**: Faro updates every repo with its base branch first; if any repo conflicts, none is merged and a conflict task is created for just the repos that clash. Two tasks of the same project never merge at the same time.
- **Pushing** goes repo by repo and skips repos with nothing new. If one fails, the others stay pushed, the error says which one is missing, and retrying only pushes what's left.
- Faro can push the base branch even if it isn't checked out anywhere (e.g. your checkouts are on feature branches), merging what's new on the remote in a temporary worktree.
- The sandbox protects the repos and worktrees of every other project, and `rootPath` is read-only.
- `release` can be set on one repo only; a task with a release must include that repo.
- For now a multi-repo project can't use `github.prs` or `github.ci`: tasks are merged locally after Faro's checks.

## Data

Everything lives in `~/.faro` (or your `dataDir`): `faro.db` (SQLite), `artifacts/`, `worktrees/`, `logs/` and `vapid.json`.

## Tests

- `npm test`: full suite, using a fake `claude`.
- `npm run smoke`: a real run with the Claude CLI (uses a little of your quota).
- `npm run typecheck`.

## License

[MIT](LICENSE)

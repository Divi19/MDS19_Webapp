# Git Workflow Rules (MDS19)

## Core rule
Never edit or commit directly on `main`. `main` is the live production website.

## Before starting any task
1. Run `git status` and make sure there are no uncommitted changes.
2. Run `git checkout main` then `git pull` to get the latest code.
3. Create a new branch:
   - New feature: `git checkout -b feature/<short-name>`
   - Bug fix: `git checkout -b fix/<short-name>`
   - Setup or tidy-up: `git checkout -b chore/<short-name>`
4. Push it to GitHub immediately, before making any changes:
   `git push -u origin <branch-name>`
   This is so everyone's work is visible on GitHub as a real branch from the
   start — not just something that shows up once merged into `main`.
5. Tell me the branch name before making changes.

## While working
- Commit in small, logical steps with clear present-tense messages
  (e.g. "Add session history table", "Fix export CSV encoding").
- Push commits to the branch regularly, not only at the very end — the whole
  point of pushing early is so progress is visible on GitHub as it happens.
- Never commit `.env`, `.env.local`, API keys, Supabase keys, model weights, or datasets.
- If a new environment variable is needed, add its name (no value) to the relevant `.env.example`.

## Before merging into main
Run these checks and report the results to me:
- Frontend: `npm run lint`, `npx tsc --noEmit`, `npm run build` (all run from `frontend/`)
- Backend: there is no automated lint or test suite set up yet. At minimum, start the
  server locally (`uvicorn app.main:app --reload` from `backend/`) and manually exercise
  the endpoint(s) your change touches before asking for a merge.

Then remind me to test the feature locally in the browser (`npm run dev`),
including sign-in and History if the change touches Supabase.

Do NOT merge until I explicitly confirm "tested, merge it".

## Merging
Only after my confirmation:
1. `git checkout main`
2. `git pull`
3. `git merge <branch-name>`
4. If there are conflicts, stop and show them to me. Do not resolve them silently.
5. `git push`
6. `git branch -d <branch-name>` — this deletes your *local* copy only.
   Leave the remote branch on GitHub as-is (do not `git push origin --delete`
   it) — that's the footprint of the work, it should stay visible after
   merging, not disappear.

## Never do
- `git push --force` to main
- Commit or merge to main without my confirmation
- Skip the checks above
- Print, log, or commit secret values

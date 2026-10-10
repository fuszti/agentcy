# Contributing to Agentcy

Thanks for your interest in Agentcy. It's an experimental prototype maintained by a small
group of volunteers, so please keep contributions focused and be patient with review times.

## Dev setup

```bash
git clone git@github.com:fuszti/agentcy.git
cd agentcy
npm ci
```

You'll also want Docker, tmux, git, and the Claude Code CLI and/or opencode installed locally to
exercise the full stack (see the README's Requirements section). Most unit tests do not require
any of that.

To run the stack, bring up a dev office: `bin/office dev init`. It is isolated from any other
office on your machine (own containers, ports and volumes), and each checkout or worktree gets its
own. Tear it down with `bin/office dev down --purge`. If you already run a live office from another
checkout, never run `office init`, `up`, `start` or `setup` here without `dev init` first. See
"Developing Agentcy" in the README.

## Checks

Run this before opening a PR. CI runs the same checks on Node 20 and 22:

```bash
npm run check    # tsc --noEmit, biome lint, vitest run
```

CI also runs integration and end-to-end tests against a dev office. Run them yourself if your
change touches that area; both need `bin/office dev init` first and refuse to run otherwise:

```bash
npm run test:integration
npm run test:e2e                                # hires an opencode agent on a cheap model
OPENCODE_LIVE=1 npx vitest run test/opencode.test.ts    # against a live opencode server
```

## Guidelines

- Keep PRs small and focused on one change. Large, multi-topic PRs are hard to review and more
  likely to stall.
- Match the existing code style (see the surrounding file). Biome lints the code (`npm run lint`);
  there is no formatter, so don't reformat files you aren't changing.
- Add or update tests for behavior changes. Tests must not depend on any contributor's local
  machine, account, or files — use fixtures and generic example data.
- Write commit messages that explain *why*, not just *what*; a short, conventional-ish prefix
  (`fix:`, `feat:`, `docs:`, `test:`, `refactor:`) is welcome but not required.
- Don't commit `office.config.json`, anything under `state/`, `workspaces/`, `brain/`, or
  `infra/data/`/`infra/.env` — these are gitignored on purpose and can contain local secrets.

## Sign-off (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) to confirm you
have the right to submit your contribution. Adding `Signed-off-by: Your Name <email>` to your
commit messages (`git commit -s`) is appreciated but optional for this project.

## Reporting bugs / requesting features

Please use the issue templates. For security issues, see [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the project's
[MIT License](LICENSE).

# Contributing to Agentcy

Thanks for your interest in Agentcy. It's an experimental prototype maintained by a small
group of volunteers, so please keep contributions focused and be patient with review times.

## Dev setup

```bash
git clone git@github.com:fuszti/agentcy.git
cd agentcy
npm ci
cp office.config.example.json office.config.json   # bin/office does this for you too if you skip it
```

You'll also want Docker, tmux, git, and the Claude Code CLI and/or opencode installed locally to
exercise the full stack (see the README's Requirements section). Most unit tests do not require
any of that.

## Checks

Run these before opening a PR — CI runs the same checks on Node 20 and 22:

```bash
npx tsc --noEmit
npx vitest run
```

Integration tests that talk to a live stack (`OFFICE_INTEGRATION=1 npx vitest run test/integration`)
or a live opencode server (`OPENCODE_LIVE=1 npx vitest run test/opencode.test.ts`) are not run in
CI and aren't required for a PR, but please run them if your change touches that area.

## Guidelines

- Keep PRs small and focused on one change. Large, multi-topic PRs are hard to review and more
  likely to stall.
- Match the existing code style (see the surrounding file); there's no separate linter/formatter
  config to run.
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

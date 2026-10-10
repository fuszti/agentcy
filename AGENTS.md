# AGENTS.md

Guidance for coding agents working on Agentcy itself (not the generated per-agent files under
`workspaces/`).

- Read [`CLAUDE.md`](CLAUDE.md) first. It has the commands, architecture and the hard rules for
  the dev office. It applies to every coding agent, not only Claude.
- Topic guides are in [`.claude/skills/`](.claude/skills/): one `SKILL.md` per area (dev office,
  delivery, harnesses, admin, finance, infra). Read the matching one before changing that area.
- Run `npm run check` before you finish. Test against a dev office (`bin/office dev init`), never
  against a live office on the same machine.

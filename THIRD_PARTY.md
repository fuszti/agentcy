# Third-party components

Agentcy (MIT-licensed, see [LICENSE](LICENSE)) orchestrates and depends on the following
third-party software, which is **not distributed with this repository** and is obtained
separately — typically as a Docker image you pull yourself, or a CLI you install yourself.

## Container images (pulled at runtime, run as separate services)

- **Mattermost Team Edition** — https://mattermost.com/
  See https://github.com/mattermost/mattermost for licensing (Team Edition components are
  Apache-2.0; some server components use the Mattermost Source Available License).
- **Forgejo** — https://forgejo.org/
  Licensed under the GNU General Public License, version 3.0 or later (GPL-3.0-or-later).
  See https://codeberg.org/forgejo/forgejo for source and license text.
- **PostgreSQL** — https://www.postgresql.org/
  Licensed under the PostgreSQL License (a permissive, MIT/BSD-style license).

## External programs (installed by the user, invoked as subprocesses)

- **Claude Code** — https://claude.com/claude-code
  Proprietary; use is governed by Anthropic's terms of service and the user's own Claude
  subscription. Not distributed with Agentcy.
- **opencode** — https://opencode.ai/
  Licensed under the MIT License. Not distributed with Agentcy.

## npm dependencies

See `package.json` / `package-lock.json` for the exact set and versions. Agentcy's own
dependencies are distributed under permissive licenses, principally MIT, ISC, Apache-2.0 and
BSD (2-Clause / 3-Clause). Run a license-checking tool (e.g. `npx license-checker`) against
`package-lock.json` for a full, version-pinned list. None of them are modified or redistributed
beyond ordinary npm installation.

None of the above projects are affiliated with or endorse Agentcy. Their names and marks
belong to their respective owners.

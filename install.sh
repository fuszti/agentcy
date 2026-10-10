#!/usr/bin/env bash
# Agentcy installer for the machine that will run the office (e.g. a home server).
#
#   git clone https://github.com/fuszti/agentcy.git && cd agentcy && ./install.sh
#
# Run it as your normal, sudo-capable user. It checks each prerequisite and asks before
# installing anything (automated on Debian/Ubuntu; elsewhere it only checks). By default it
# creates a dedicated, sudo-less `agentcy` user with its own checkout in /home/agentcy/agentcy,
# because agents get a real shell: keep them away from your own files. Then it runs the
# interactive `office setup` wizard as that user and installs a systemd service so the office
# comes back by itself after a reboot.
#
# Options:
#   --here           run the office as the current user from this checkout (no dedicated user)
#   --user NAME      name of the office user (default: agentcy)
#   --no-service     don't install the systemd service
#   --service-only   only (re)install the systemd service
#   --yes            answer "yes" to every install question (unattended)
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
OFFICE_USER=agentcy
HERE=0 SERVICE=1 SERVICE_ONLY=0 ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --here) HERE=1 ;;
    --user) OFFICE_USER="$2"; shift ;;
    --no-service) SERVICE=0 ;;
    --service-only) SERVICE_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
miss() { printf '  \033[33m✗\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
confirm() { # confirm "question" -> 0 = yes
  [ "$ASSUME_YES" = 1 ] && return 0
  local a; read -r -p "  $1 (y/N) " a </dev/tty; [[ "$a" =~ ^[Yy] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Linux ] || die "the office runs on Linux only (your laptop just needs a browser)"
if [ "$(id -u)" = 0 ]; then SUDO=""; else have sudo || die "sudo is required"; SUDO="sudo"; fi

APT=0
if [ -r /etc/os-release ]; then
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in *" debian "*|*" ubuntu "*) APT=1 ;; esac
fi

apt_install() {
  if [ "$APT" != 1 ]; then miss "install $* with your package manager, then re-run"; return 1; fi
  $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

if [ "$HERE" = 1 ]; then
  OFFICE_USER="$(id -un)"; OFFICE_HOME="$HOME"; DIR="$SRC"
else
  OFFICE_HOME="/home/$OFFICE_USER"; DIR="$OFFICE_HOME/agentcy"
fi
OFFICE_PATH="$OFFICE_HOME/.local/bin:$OFFICE_HOME/.opencode/bin:/usr/local/bin:/usr/bin:/bin"

run_as_office() { # run argv as the office user (sudo from a normal user, runuser from root)
  if [ "$HERE" = 1 ]; then env PATH="$OFFICE_PATH" "$@"
  elif [ -z "$SUDO" ]; then runuser -u "$OFFICE_USER" -- env HOME="$OFFICE_HOME" PATH="$OFFICE_PATH" "$@"
  else sudo -u "$OFFICE_USER" -H env PATH="$OFFICE_PATH" "$@"; fi
}
as_office() { run_as_office bash -c "cd ~ && $1"; }

install_service() {
  bold "Service: start the office at boot"
  have systemctl || { miss "no systemd; start the office with \`bin/office start\` after a reboot"; return; }
  local unit=/etc/systemd/system/agentcy.service
  sed -e "s#@USER@#$OFFICE_USER#g" -e "s#@HOME@#$OFFICE_HOME#g" -e "s#@DIR@#$DIR#g" -e "s#@PATH@#$OFFICE_PATH#g" \
    "$SRC/infra/agentcy.service" | $SUDO tee "$unit" >/dev/null
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable agentcy.service >/dev/null
  ok "installed $unit (enabled)"
  if confirm "Start the office now (admin daemon + any hired agents)?"; then
    $SUDO systemctl start agentcy.service && ok "started"
  fi
}

if [ "$SERVICE_ONLY" = 1 ]; then install_service; exit 0; fi

# --------------------------------------------------------------- 1. system packages
bold "1/5 System tools"
for pkg in git tmux curl; do
  if have "$pkg"; then ok "$pkg"; else
    miss "$pkg"; confirm "Install $pkg?" && apt_install "$pkg" && ok "$pkg installed" || die "$pkg is required"
  fi
done

if have docker && docker compose version >/dev/null 2>&1; then ok "docker + compose"; else
  miss "docker engine with the compose plugin"
  if confirm "Install Docker with Docker's official script (https://get.docker.com)?"; then
    curl -fsSL https://get.docker.com | $SUDO sh && ok "docker installed"
  else die "docker is required"; fi
fi

node_ok() { have node && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; }
if node_ok; then ok "node $(node -v)"; else
  miss "Node.js 20 or newer"
  if [ "$APT" = 1 ] && confirm "Install Node.js 22 from NodeSource (https://deb.nodesource.com)?"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - && apt_install nodejs && ok "node $(node -v)"
  else die "Node.js >= 20 is required"; fi
fi

# --------------------------------------------------------------- 2. office user + checkout
bold "2/5 Office user"
if [ "$HERE" = 1 ]; then
  ok "running as $OFFICE_USER from $DIR (--here)"
  if ! id -nG "$OFFICE_USER" | grep -qw docker; then
    confirm "Add $OFFICE_USER to the docker group?" || die "$OFFICE_USER needs docker access"
    $SUDO usermod -aG docker "$OFFICE_USER"
    die "added to the docker group: log out and back in, then re-run ./install.sh --here"
  fi
else
  if id "$OFFICE_USER" >/dev/null 2>&1; then ok "user $OFFICE_USER exists"; else
    confirm "Create the dedicated user '$OFFICE_USER' (no sudo; agents run as this user)?" || die "re-run with --here to use your own user"
    $SUDO useradd -m -s /bin/bash "$OFFICE_USER" && ok "created $OFFICE_USER"
  fi
  $SUDO usermod -aG docker "$OFFICE_USER" && ok "$OFFICE_USER can use docker"
  if [ -d "$DIR/.git" ]; then ok "checkout $DIR exists (not touched; update it with git pull as $OFFICE_USER)"; else
    branch="$(git -C "$SRC" rev-parse --abbrev-ref HEAD)"
    $SUDO git -c safe.directory='*' clone -q --no-local -b "$branch" "$SRC" "$DIR"
    upstream="$(git -C "$SRC" remote get-url origin 2>/dev/null || true)"
    [ -n "$upstream" ] && $SUDO git -C "$DIR" remote set-url origin "$upstream"
    $SUDO chown -R "$OFFICE_USER:" "$DIR"
    ok "cloned $branch into $DIR"
  fi
fi

# --------------------------------------------------------------- 3. agent harnesses
bold "3/5 Agent harnesses (installed for $OFFICE_USER)"
if as_office 'command -v claude' >/dev/null 2>&1; then ok "claude"; else
  miss "Claude Code"
  confirm "Install Claude Code (https://claude.ai/install.sh) for $OFFICE_USER?" \
    && as_office 'curl -fsSL https://claude.ai/install.sh | bash' && ok "claude installed" || true
fi
if as_office 'command -v opencode' >/dev/null 2>&1; then ok "opencode"; else
  miss "opencode (also used for merge summaries and the admin helper)"
  confirm "Install opencode (https://opencode.ai/install) for $OFFICE_USER?" \
    && as_office 'curl -fsSL https://opencode.ai/install | bash' && ok "opencode installed" || true
fi

# --------------------------------------------------------------- 4. dependencies + wizard
bold "4/5 Agentcy"
as_office "cd '$DIR' && npm ci --no-audit --no-fund --loglevel=error" && ok "npm dependencies"
echo
as_office "cd '$DIR' && bin/office setup" </dev/tty

# --------------------------------------------------------------- 5. service
if [ "$SERVICE" = 1 ]; then install_service; else bold "5/5 Service"; ok "skipped (--no-service)"; fi

bold "All set."
cat <<EOF
  Run office commands as $OFFICE_USER:   sudo -iu $OFFICE_USER   then   cd $DIR && bin/office status
  Watch agents live:                    sudo -iu $OFFICE_USER tmux attach -t office
  Day to day, just use #office-admin in chat.
EOF

[[ -n "${MISE_ORIGINAL_CWD:-}" ]] && cd "$MISE_ORIGINAL_CWD"

header()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()    { printf '  %s\n' "$*"; }
success() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()    { printf '\033[33m⚠\033[0m %s\n' "$*"; }
error()   { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
dim()     { printf '\033[2m%s\033[0m\n' "$*"; }
ask()     { read -r -p "$1 [${2:-}] " REPLY; REPLY=${REPLY:-$2}; }
confirm() { local r; read -r -p "$1 [y/N] " r; [[ $r == [yY]* ]]; }

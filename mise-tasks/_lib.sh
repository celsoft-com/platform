[[ -n "${MISE_ORIGINAL_CWD:-}" ]] && cd "$MISE_ORIGINAL_CWD"

header()  { print -P "%B$*%b" }
info()    { print -r -- "  $*" }
success() { print -P "%F{green}✓%f $*" }
warn()    { print -P "%F{yellow}⚠%f $*" }
error()   { print -P "%F{red}✗%f $*" >&2 }
dim()     { print -P "%F{8}$*%f" }
ask()     { read -r "REPLY?$1 [${2:-}] "; REPLY=${REPLY:-$2} }
confirm() { read -q "?$1 [y/N] "; local r=$?; print; return $r }

set -Eeuo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")"

CONTAINER="litrizzv7"
IMAGE="litrizzv7"

log() { printf '[ctl %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "ERRO: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "preciso de '$1' instalado"; }

short_commit() { git rev-parse --short HEAD 2>/dev/null || echo unknown; }

dc() {
  APP_UID="$(id -u)" APP_GID="$(id -g)" GIT_COMMIT="$(short_commit)" docker compose "$@"
}

health_status() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo missing
}

wait_healthy() {
  local timeout="${1:-120}" waited=0
  while (( waited < timeout )); do
    [[ "$(health_status)" == "healthy" ]] && return 0
    sleep 3; waited=$(( waited + 3 ))
  done
  return 1
}

acquire_lock() {
  mkdir -p data
  if command -v flock >/dev/null 2>&1; then
    exec 9>"data/.ctl.lock"
    flock -n 9 || die "já existe outra operação do ctl em andamento"
  else
    local lockdir="data/.ctl.lock.d"
    mkdir "$lockdir" 2>/dev/null \
      || die "já existe outra operação do ctl em andamento (se for engano: rmdir $lockdir)"
    trap "rmdir '$lockdir' 2>/dev/null || true" EXIT
  fi
}

ensure_dirs() { mkdir -p data/auth data/auth-backups data/control/{requests,pending,results,tmp}; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  ' | head -c 400; }


cmd_cold_start() {
  need docker; need git; acquire_lock
  if [[ ! -f .env ]]; then
    cp .env.example .env
    die ".env criado a partir do exemplo. Edite (principalmente WHATSAPP_PHONE) e rode ./ctl cold-start de novo."
  fi
  ensure_dirs
  systemctl is-enabled docker >/dev/null 2>&1 \
    || log "AVISO: o Docker não inicia no boot. Rode: sudo systemctl enable --now docker"
  log "build (pode levar alguns minutos na primeira vez)…"
  dc build
  dc up -d
  log "aguardando o bot conectar…"
  if wait_healthy 180; then
    log "✅ no ar (versão $(short_commit))"
  else
    log "⚠️ ainda não está saudável. Se for o primeiro uso, veja o código de pareamento com: ./ctl logs"
  fi
}

cmd_start()   { ensure_dirs; dc up -d; log "iniciado"; }
cmd_stop()    { dc stop; log "parado"; }
cmd_restart() { dc restart bot; log "reiniciado"; }
cmd_logs()    { dc logs -f --tail="${1:-100}" bot; }

cmd_status() {
  echo "versão (git):  $(short_commit)"
  echo "container:     $(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo ausente)"
  echo "saúde:         $(health_status)"
  echo "pedidos fila:  $(ls data/control/requests 2>/dev/null | wc -l)"
  echo "backups sessão: $(ls data/auth-backups 2>/dev/null | wc -l)"
  echo "── últimas linhas ──"
  docker logs --tail 5 "$CONTAINER" 2>&1 || true
}

tag_previous() {
  if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
    docker tag "$IMAGE:latest" "$IMAGE:previous"
  fi
}

do_rollback() {
  docker image inspect "$IMAGE:previous" >/dev/null 2>&1 || die "não existe imagem 'previous' para voltar"
  local rev
  rev="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE:previous" 2>/dev/null || true)"
  docker tag "$IMAGE:previous" "$IMAGE:latest"
  dc up -d --no-build
  if [[ -n "$rev" && "$rev" != "unknown" ]] && git cat-file -e "$rev^{commit}" 2>/dev/null; then
    git reset --hard "$rev" >/dev/null
  fi
}

cmd_rollback() {
  need docker; acquire_lock
  do_rollback
  if wait_healthy 120; then log "✅ rollback concluído (versão $(short_commit))"
  else die "rollback feito, mas o bot não ficou saudável — veja ./ctl logs"; fi
}

cmd_update() {
  need docker; need git; acquire_lock
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] \
    || die "há alterações locais não commitadas (git status); resolva antes de atualizar"

  local before after was_healthy=0
  before="$(git rev-parse HEAD)"
  log "git pull…"
  git pull --ff-only || die "git pull falhou (histórico divergente ou sem rede)"
  after="$(git rev-parse HEAD)"

  if [[ "$before" == "$after" && "${FORCE:-0}" != "1" ]]; then
    log "✅ já está na versão mais recente ($(short_commit))"; return 0
  fi

  [[ "$(health_status)" == "healthy" ]] && was_healthy=1
  tag_previous

  log "build da versão $(short_commit)…"
  if ! dc build; then
    git reset --hard "$before" >/dev/null
    die "build falhou; nada mudou (o bot continua na versão ${before:0:7})"
  fi

  dc up -d
  if wait_healthy 120; then
    log "✅ atualizado ${before:0:7} → ${after:0:7}"
    docker image prune -f >/dev/null 2>&1 || true
    docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || true
    return 0
  fi

  if (( was_healthy )); then
    log "⚠️ a nova versão não ficou saudável — voltando para a anterior"
    do_rollback
    if wait_healthy 120; then die "update falhou; rollback automático OK (versão ${before:0:7})"
    else die "update falhou E o rollback não ficou saudável — intervenção manual (./ctl logs)"; fi
  fi
  die "nova versão não ficou saudável, mas o bot também não estava saudável antes (sem rollback). Veja ./ctl logs"
}

cmd_pair() {
  need docker; acquire_lock
  local mode="${1:-code}"
  [[ "$mode" == "code" || "$mode" == "qr" ]] || die "uso: ./ctl pair [qr]"
  [[ -f .env ]] || die "crie o .env primeiro (./ctl cold-start)"
  if [[ "$mode" == "code" ]]; then
    grep -Eq '^WHATSAPP_PHONE=[0-9]{10,15}$' .env || die "defina WHATSAPP_PHONE=5513999999999 (só dígitos) no .env"
    local phone
    phone="$(grep -E '^WHATSAPP_PHONE=' .env | head -n1 | cut -d= -f2 | tr -d '\r')"
    log "número usado: ${phone:0:4}…${phone: -2} (${#phone} dígitos; no Brasil o normal são 13: 55+DDD+9+8 dígitos)"
    (( ${#phone} >= 12 )) || log "AVISO: parece faltar o DDI (55) ou o DDD — o WhatsApp vai recusar o código"
  fi
  export PAIRING_MODE="$mode"
  ensure_dirs
  dc stop || true
  if [[ -f data/auth/creds.json ]]; then
    mv data/auth "data/auth.old-$(date +%Y%m%d-%H%M%S)"
    mkdir -p data/auth
    log "sessão antiga guardada em data/auth.old-*"
  fi
  log "build…"
  dc build
  dc up -d --force-recreate
  if [[ "$mode" == "qr" ]]; then
    log "No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o QR MAIS RECENTE (Ctrl+C sai do log; o bot continua)."
    log "Dica: aumente a janela do terminal para o QR caber inteiro."
    dc logs -f --tail=0 bot
    return 0
  fi
  log "gerando código de pareamento…"
  local code="" i
  for i in $(seq 1 30); do
    code="$(docker logs "$CONTAINER" 2>&1 | grep -o 'CÓDIGO DE PAREAMENTO: [A-Z0-9-]*' | tail -n1 || true)"
    [[ -n "$code" ]] && break
    sleep 2
  done
  [[ -n "$code" ]] || die "não apareceu código; veja ./ctl logs"
  echo
  echo "  $code"
  echo "  No celular: WhatsApp → Aparelhos conectados → Conectar com número de telefone"
  echo "  O código vale ~2 min. Se der erro, rode ./ctl pair de novo e use o código NOVO."
  echo
  log "depois de digitar o código, acompanhe com ./ctl logs"
}

cmd_backup() {
  [[ -f data/auth/creds.json ]] || die "não há sessão em data/auth"
  local dest="data/auth-backups/manual-$(date +%Y%m%d-%H%M%S)"
  mkdir -p data/auth-backups && cp -a data/auth "$dest"
  log "cópia criada em $dest"
}


write_result() { # id action rc message
  local id="$1" action="$2" rc="$3" msg="$4" ok=false
  [[ "$rc" == "0" ]] && ok=true
  local tmp="data/control/tmp/$id.json.$$"
  printf '{"id":"%s","action":"%s","ok":%s,"message":"%s","finishedAt":"%s"}\n' \
    "$id" "$action" "$ok" "$(json_escape "$msg")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  mv "$tmp" "data/control/results/$id.json"
}

cmd_handle_requests() {
  ensure_dirs
  shopt -s nullglob
  local f base action id out rc
  for f in data/control/requests/*.req; do
    base="${f##*/}"; base="${base%.req}"
    action="${base%%-*}"; id="${base#*-}"
    rm -f "$f"
    [[ "$id" =~ ^[A-Za-z0-9]+$ ]] || { log "pedido com id inválido ignorado"; continue; }
    case "$action" in
      update|rollback) ;;
      *) log "ação não permitida ignorada: $action"; continue ;;
    esac
    log "executando '$action' ($id)"
    rc=0; out="$("$SELF" "$action" 2>&1)" || rc=$?
    write_result "$id" "$action" "$rc" "$(printf '%s\n' "$out" | tail -n 2)"
  done
}

cmd_install_systemd() {
  need systemctl
  local dir user
  dir="$(pwd)"; user="${SUDO_USER:-$(id -un)}"
  ensure_dirs
  id -nG "$user" | tr ' ' '\n' | grep -qx docker || log "AVISO: '$user' não está no grupo docker (sudo usermod -aG docker $user)"
  for unit in litrizzv7-control.path litrizzv7-control.service; do
    sed -e "s|@APP_DIR@|$dir|g" -e "s|@APP_USER@|$user|g" "deploy/$unit.template" \
      | sudo tee "/etc/systemd/system/$unit" >/dev/null
  done
  sudo systemctl daemon-reload
  sudo systemctl enable --now litrizzv7-control.path
  log "✅ controle remoto habilitado (.update / .rollback pelo WhatsApp)"
}

usage() { sed -n '2,13p' "$SELF" | sed 's/^# \{0,1\}//'; }

main() {
  local cmd="${1:-help}"; shift || true
  case "$cmd" in
    cold-start)        cmd_cold_start ;;
    start)             cmd_start ;;
    stop)              cmd_stop ;;
    restart)           cmd_restart ;;
    update)            cmd_update ;;
    rollback)          cmd_rollback ;;
    status)            cmd_status ;;
    logs)              cmd_logs "$@" ;;
    pair)              cmd_pair "$@" ;;
    backup)            cmd_backup ;;
    handle-requests)   cmd_handle_requests ;;
    install-systemd)   cmd_install_systemd ;;
    help|-h|--help)    usage ;;
    *)                 usage; exit 1 ;;
  esac
}


main "$@"; exit $?

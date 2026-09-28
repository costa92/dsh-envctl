#!/usr/bin/env bash
# End-to-end test of dshenv's main chain against a real npm DSH in an isolated DSH_HOME:
# adopt -> manifest/lock/ownership -> plan -> apply -> verify on disk and in DSH -> runtime -> rollback -> remove.
# Usage: scripts/e2e-dsh.sh <dsh-version> [work-dir]
set -uo pipefail

version="${1:?usage: scripts/e2e-dsh.sh <dsh-version> [work-dir]}"
work="${2:-$(mktemp -d)}"
# An npm plugin compatible with the DSH under test; a local tool plugin covers source updates.
pkg="${E2E_PLUGIN:-@nanmicoder/dsh-agent-teams}"
pkg_version="${E2E_PLUGIN_VERSION:-0.1.21}"
tool="e2e-tool"
root="$(cd "$(dirname "$0")/.." && pwd)"
dshenv=(node "$root/bin/dshenv.js")
failed=0
web_pid=""

step() {
  local name="$1" expected="$2"
  shift 2
  "$@" >"$work/last.log" 2>&1
  local code=$?
  if [ "$code" -eq "$expected" ]; then
    echo "PASS  $name"
  else
    echo "FAIL  $name (exit $code, expected $expected)"
    sed 's/^/      /' "$work/last.log"
    failed=1
  fi
}

# Evaluates a JS expression over the parsed JSON file; the step passes when it is truthy.
json_true() {
  node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(new Function("v","return ("+process.argv[2]+")")(v)?0:1)' "$1" "$2"
}

installed_version() {
  node -p 'require(process.argv[1]).version' "$DSH_HOME/profiles/web/node_modules/$1/package.json" 2>/dev/null
}

# The manifest alias dshenv gave a package, read from `list --json`.
alias_of() {
  "${run[@]}" list --profile web --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).plugins.find(p=>p.package===process.argv[1]&&p.alias);console.log(r?r.alias:"")})' "$1"
}

stop_web() {
  if [ -n "$web_pid" ]; then
    kill "$web_pid" 2>/dev/null
    wait "$web_pid" 2>/dev/null
    web_pid=""
  fi
}
trap stop_web EXIT

mkdir -p "$work/dsh" "$work/home"
echo "DSH $version, work dir $work"
if ! npm install --prefix "$work/dsh" --no-audit --no-fund "@deepseek-ai/dsh@$version" >"$work/npm.log" 2>&1; then
  echo "FAIL  npm install @deepseek-ai/dsh@$version (see $work/npm.log)"
  exit 1
fi
export DSH_HOME="$work/home"
export DSH_CLI="$work/dsh/node_modules/.bin/dsh"
unset DSHENV_OVERLAY DSHENV_DSH_URL
envctl="$DSH_HOME/envctl"

"${dshenv[@]}" doctor --json >"$work/doctor.json" 2>&1
case "$?" in
  0) allow=() ;;
  4) echo "WARN  version gate rejects $version; continuing with --allow-untested-dsh"; allow=(--allow-untested-dsh) ;;
  *) echo "FAIL  doctor"; sed 's/^/      /' "$work/doctor.json"; exit 1 ;;
esac
run=("${dshenv[@]}" "${allow[@]}")

# 1. Adopt a plugin DSH installed on its own: capture, adopt, ownership, clean plan.
step "dsh installs $pkg@$pkg_version outside dshenv" 0 "$DSH_CLI" plugin --profile web add "$pkg@$pkg_version"
step "init" 0 "${run[@]}" init
step "plan leaves the unmanaged plugin alone" 0 "${run[@]}" plan
step "capture the profile" 0 "${run[@]}" capture --profile web --output "$work/capture.yaml"
step "adopt the capture" 0 "${run[@]}" adopt --from "$work/capture.yaml"
step "adopt records ownership" 0 json_true "$envctl/state.json" "v.ownership?.web?.['$pkg']?.lockedVersion === '$pkg_version'"
step "plan clean after adopt" 0 "${run[@]}" plan
alias="$(alias_of "$pkg")"
step "manifest declares an alias for $pkg" 0 test -n "$alias"
step "dsh composes the adopted plugin" 0 bash -c '"$DSH_CLI" --profile web --dump-config | grep -q "$1"' _ "$pkg"

# 2. Install a local source: manifest -> plan -> apply -> lock digest; a source edit plans an update.
step "scaffold and declare a local tool plugin" 0 bash -c 'cd "$1" && "${@:2}" new tool '"$tool"' -p web' _ "$work" "${run[@]}"
tool_alias="$(alias_of "$tool")"
step "plan shows the install" 2 "${run[@]}" plan
step "apply install" 0 "${run[@]}" apply --yes
step "plan clean after install" 0 "${run[@]}" plan
step "lock records the local source digest" 0 json_true "$envctl/lock.json" "Boolean(v.profiles.web.plugins['$tool_alias']?.source?.digest)"
step "state takes ownership of the installed plugin" 0 json_true "$envctl/state.json" "Boolean(v.ownership?.web?.['$tool'])"
step "dsh composes the tool plugin" 0 bash -c '"$DSH_CLI" --profile web --dump-config | grep -q "$1"' _ "$tool"
echo "// e2e edit" >>"$work/$tool/index.js"
step "plan sees the source change as an update" 2 "${run[@]}" plan
step "apply update" 0 "${run[@]}" apply --yes
step "plan clean after update" 0 "${run[@]}" plan

# 3. Configure through a managed patch block.
step "declare config" 0 "${run[@]}" config set "$alias" e2eMarker on --profile web
step "plan shows configure" 2 "${run[@]}" plan
step "apply configure" 0 "${run[@]}" apply --yes
step "patch file holds the managed block" 0 grep -q "# dshenv:begin profile=web plugin=$alias" "$DSH_HOME/profiles/web/cordis.patch.yml"
step "plan clean after configure" 0 "${run[@]}" plan

# 4. Drift: a change made behind dshenv's back is detected and repaired.
node -e 'const f=process.argv[1];const p=require(f);p.version="0.0.0-drift";require("fs").writeFileSync(f,JSON.stringify(p))' \
  "$DSH_HOME/profiles/web/node_modules/$pkg/package.json"
step "plan detects version drift" 2 "${run[@]}" plan
step "apply repairs the drift" 0 "${run[@]}" apply --yes
step "plan clean after repair" 0 "${run[@]}" plan
step "profile has $pkg@$pkg_version again" 0 test "$(installed_version "$pkg")" = "$pkg_version"

# 5. Runtime: the running dsh web reports the plugin loaded.
"$DSH_CLI" web --no-open --port 0 >"$work/web.log" 2>&1 &
web_pid=$!
url=""
for _ in $(seq 1 60); do
  url="$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[^[:space:]]*' "$work/web.log" | head -1)"
  [ -n "$url" ] && break
  sleep 1
done
step "dsh web starts and prints its URL" 0 test -n "$url"
if [ -n "$url" ]; then
  runtime_ok() {
    for _ in $(seq 1 30); do
      DSHENV_DSH_URL="$url" "${run[@]}" runtime --profile web && return 0
      sleep 2
    done
    return 1
  }
  step "runtime reports the plugin loaded" 0 runtime_ok
fi
stop_web

# 6. Rollback restores the manifest files; apply converges again.
step "rollback dry-run" 0 "${run[@]}" rollback --dry-run
step "rollback" 0 "${run[@]}" rollback --yes
step "apply after rollback" 0 "${run[@]}" apply --yes
step "plan clean after rollback" 0 "${run[@]}" plan

# 7. Remove: an owned plugin dropped from the manifest is uninstalled.
step "declare remove" 0 "${run[@]}" remove "$alias" --profile web
step "apply remove" 0 "${run[@]}" apply --yes
step "plan clean after remove" 0 "${run[@]}" plan
step "profile no longer has $pkg" 0 test -z "$(installed_version "$pkg")"
step "ownership released" 0 json_true "$envctl/state.json" "!v.ownership?.web?.['$pkg']"

exit "$failed"

#!/usr/bin/env bash
#
# Puts Ibid in front of someone, over a throwaway public URL.
#
# A quick tunnel's hostname is not yours: Cloudflare hands one out per run and reclaims it
# the moment the connection drops, which a laptop going to sleep is guaranteed to do. The
# tunnel process survives that and retries forever against a name it can never be given
# back, so the failure looks like "the tunnel is running and the site is down".
#
# Recovering means restarting the tunnel, rewriting the manifest around the new hostname —
# it is baked in at ten places — and putting the file back where Word can read it. That is
# a five-minute errand done by hand and a fifteen-second one done here.
#
#   npm run trial              # recover, or start from cold
#   npm run trial -- --build   # rebuild the pane first, after changing it
#
# The add-in <Id> is generated once and then kept, which is the part that matters to
# whoever you are showing it to: Word keys an add-in by that Id, so reusing it makes the
# new manifest an *update* to the one they already loaded rather than a second entry beside
# it, broken and indistinguishable from the first.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${IBID_TRIAL_PORT:-4200}"
STATE="${IBID_TRIAL_STATE:-.trial}"
# Where Word reads sideloaded manifests on this machine. Skipped without complaint if it is
# not there, since only this development setup has it.
CATALOG="${IBID_TRIAL_CATALOG:-/mnt/c/OfficeAddins}"
MANIFEST_NAME="ibid-trial-manifest.xml"
TUNNEL_URL_PATTERN='https://[a-z0-9-]+\.trycloudflare\.com'

mkdir -p "$STATE"

cloudflared_bin="$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")"
if [ ! -x "$cloudflared_bin" ]; then
  echo "cloudflared is not installed. Install it with:" >&2
  echo "  curl -sL -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared" >&2
  exit 1
fi

# ---------------------------------------------------------------- the add-in identity
# Generated once, then never again. See the note above on why reuse is the point.
ID_FILE="$STATE/addin-id"
if [ ! -f "$ID_FILE" ]; then
  node -e 'console.log(require("node:crypto").randomUUID())' > "$ID_FILE"
  echo "Generated a new add-in Id (kept in $ID_FILE, reused from now on)."
fi
ADDIN_ID="$(cat "$ID_FILE")"

# ---------------------------------------------------------------- the pane
if [ "${1:-}" = "--build" ] || [ ! -d addin/dist ]; then
  echo "Building…"
  npm run build >/dev/null
fi

# ---------------------------------------------------------------- the server
# One process serving the pane and the API, which is what makes a single public URL enough.
if curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Server already up on :$PORT."
else
  echo "Starting the server on :$PORT…"
  IBID_STATIC_DIR=./addin/dist IBID_API_PORT="$PORT" \
    nohup node api/server.mjs > "$STATE/server.log" 2>&1 &
  for _ in $(seq 1 20); do
    curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "The server did not come up. Last lines of $STATE/server.log:" >&2
    tail -20 "$STATE/server.log" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------- the tunnel
# Killed by its full command line rather than by name, so an unrelated cloudflared — a real
# named tunnel, say — is left alone.
pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
sleep 1

echo "Opening a tunnel…"
: > "$STATE/tunnel.log"
nohup "$cloudflared_bin" tunnel --url "http://localhost:$PORT" > "$STATE/tunnel.log" 2>&1 &

URL=""
for _ in $(seq 1 30); do
  # Read the whole log each time: the URL is printed inside a drawn box, so a line can be
  # matched before it has been written in full.
  URL="$(grep -oE "$TUNNEL_URL_PATTERN" "$STATE/tunnel.log" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "No tunnel URL after 30s. Last lines of $STATE/tunnel.log:" >&2
  tail -20 "$STATE/tunnel.log" >&2
  exit 1
fi
echo "$URL" > "$STATE/url"

# ---------------------------------------------------------------- the manifest
# Absolute: `npm run -w addin` runs with the workspace as its working directory, so a
# relative --out lands inside addin/ rather than here.
MANIFEST_PATH="$PWD/$STATE/$MANIFEST_NAME"
npm run manifest -w addin -- "$URL" --id "$ADDIN_ID" --out "$MANIFEST_PATH" >/dev/null
if [ -d "$CATALOG" ]; then
  cp "$MANIFEST_PATH" "$CATALOG/$MANIFEST_NAME"
  DELIVERED="$CATALOG/$MANIFEST_NAME"
else
  DELIVERED="$MANIFEST_PATH"
fi

# ---------------------------------------------------------------- confirm, do not assume
# The point of the whole errand is that someone else can reach it, so that is what is
# checked: the public hostname, not the loopback port already known to work.
#
# Checked against a public resolver rather than this machine's, and deliberately. Cloudflare
# publishes DNS for a new quick tunnel a moment after handing out the name, and asking too
# early gets an NXDOMAIN that the local resolver then *caches* — after which this machine
# cannot reach a URL that the rest of the world can, for as long as the negative lives. That
# is a false alarm about the one thing this script exists to confirm, and it cost an
# afternoon once. What the client's machine will do is resolve it themselves, so that is
# what gets tested here.
echo "Checking it from outside…"
sleep 3   # let the name be published before anything asks for it

host="${URL#https://}"
address=""
if command -v dig >/dev/null 2>&1; then
  for _ in $(seq 1 10); do
    address="$(dig +short @1.1.1.1 "$host" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
    [ -n "$address" ] && break
    sleep 2
  done
fi

# `--resolve` pins the lookup to the address a public resolver just gave, so this machine's
# own cache cannot answer for it either way. Without dig, fall back to an ordinary request.
resolve_args=()
[ -n "$address" ] && resolve_args=(--resolve "$host:443:$address")

ok=""
for _ in $(seq 1 15); do
  if curl -sf --max-time 10 "${resolve_args[@]}" "$URL/api/health" >/dev/null 2>&1 \
    && curl -sf --max-time 10 -o /dev/null "${resolve_args[@]}" "$URL/taskpane.html"; then
    ok="yes"
    break
  fi
  sleep 2
done

echo
if [ -n "$ok" ]; then
  echo "  Live:     $URL"
  # Said only when the two disagree, because it looks alarming and is not.
  if [ -n "$address" ] && ! getent hosts "$host" >/dev/null 2>&1; then
    echo "            (This machine cannot resolve it yet — a cached negative lookup, local"
    echo "             to here and invisible to anyone you send it to. It clears itself.)"
  fi
else
  echo "  UNCONFIRMED: $URL"
  echo "            The tunnel is up but did not answer yet. Give it a moment and retry:"
  echo "            curl $URL/api/health"
fi
echo "  Send:     $DELIVERED"
echo "  Add-in:   $ADDIN_ID  (unchanged, so this updates rather than duplicates)"
echo "  Logs:     $STATE/server.log, $STATE/tunnel.log"
echo
echo "  The client uploads that one file in Word on the web:"
echo "    Home > Add-ins > More Settings > Upload My Add-in > Browse > Upload"
echo
echo "  This URL dies when the machine sleeps or the tunnel stops. Run this again for a new one."

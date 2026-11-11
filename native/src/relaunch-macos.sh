# The launcher is passed as argv, never interpolated into shell source.
# Wait for the single-instance owner to exit before asking LaunchServices to open it.
pid=$1
shift
remaining=300
while kill -0 "$pid" 2>/dev/null; do
  if [ "$remaining" -eq 0 ]; then
    echo 'APP_RESTART_TIMEOUT: Desktop did not exit; quit ARC and reopen the application.' >&2
    exit 1
  fi
  remaining=$((remaining - 1))
  /bin/sleep 0.1
done
exec "$@"

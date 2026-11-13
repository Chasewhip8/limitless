#!@runtimeShell@
# Electron runs `xdg-open` from T3's AppImage sandbox, where handlers inherit its
# environment and die with it. Start the handler as a transient user service so it
# runs in the user manager's desktop environment instead. ExitType=cgroup keeps
# editors that outlive their launcher, such as Zed's CLI, from being stopped.
set -eu
unset LD_LIBRARY_PATH LD_PRELOAD

forwarded=()
if [ -n "${XDG_ACTIVATION_TOKEN:-}" ]; then
  forwarded+=(--setenv=XDG_ACTIVATION_TOKEN)
fi

exec @systemdRun@ --user --quiet --collect --expand-environment=no \
  --property=Type=exec --property=ExitType=cgroup \
  --property=WorkingDirectory=-"$PWD" \
  "${forwarded[@]}" -- @xdgOpen@ "$@"

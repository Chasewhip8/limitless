#!@runtimeShell@
# Usage: desktop-host-launch <absolute-executable> [argument...]
# AppImage desktops run external handlers inside their sandbox, where handlers
# inherit its libraries and die with it. Start the command as a transient user
# service so it runs in the user manager's desktop environment instead.
# ExitType=cgroup keeps editors that outlive their launcher, such as Zed's CLI,
# from being stopped. A fixed description keeps link and file targets out of the
# journal's unit messages.
set -eu
unset LD_LIBRARY_PATH LD_PRELOAD

forwarded=()
if [ -n "${XDG_ACTIVATION_TOKEN:-}" ]; then
  forwarded+=(--setenv=XDG_ACTIVATION_TOKEN)
fi

exec @systemdRun@ --user --quiet --collect --expand-environment=no \
  --description="Desktop handler" \
  --property=Type=exec --property=ExitType=cgroup \
  --property=WorkingDirectory=-"$PWD" \
  "${forwarded[@]}" -- "$@"

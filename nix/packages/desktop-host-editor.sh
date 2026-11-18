#!@runtimeShell@
# Installed under an editor command that an AppImage desktop runs by name. Starts
# the first host executable found on PATH outside the sandbox. The resolved path is
# canonicalized because the sandbox's /usr does not exist on the host.
set -eu
unset LD_LIBRARY_PATH LD_PRELOAD

IFS=: read -ra directories <<< "${PATH:-}"
for candidate in @candidates@; do
  for directory in "${directories[@]}"; do
    # Relative and empty entries would search the desktop's working directory.
    [[ $directory == /* ]] || continue
    executable=$directory/$candidate
    if [ -f "$executable" ] && [ -x "$executable" ] && ! [ "$executable" -ef "$0" ]; then
      exec @launch@ "$(@readlink@ -f -- "$executable")" "$@"
    fi
  done
done

echo "${0##*/}: no host command found (tried: @candidates@)" >&2
exit 127

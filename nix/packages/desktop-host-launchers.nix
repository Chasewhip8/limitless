{
  coreutils,
  lib,
  replaceVars,
  runCommand,
  runtimeShell,
  systemd,
  xdg-utils,
  name,
  editors ? { },
}:
let
  launch = replaceVars ./desktop-host-launch.sh {
    inherit runtimeShell;
    systemdRun = "${lib.getBin systemd}/bin/systemd-run";
  };
  xdgOpen = lib.getExe' xdg-utils "xdg-open";
  installEditor = editor: candidates: ''
    substitute ${./desktop-host-editor.sh} "$out/bin/${editor}" \
      --subst-var-by runtimeShell ${runtimeShell} \
      --subst-var-by launch "$out/libexec/desktop-host-launch" \
      --subst-var-by readlink ${lib.getExe' coreutils "readlink"} \
      --subst-var-by candidates ${lib.escapeShellArg (lib.escapeShellArgs candidates)}
    chmod +x "$out/bin/${editor}"
  '';
in
# Prepend bin/ to a desktop's PATH. Its commands start links and editors outside
# the AppImage sandbox; `editors` maps a command name to host commands tried in order.
runCommand "${name}-host-launchers" { } ''
  install -Dm755 ${launch} "$out/libexec/desktop-host-launch"
  mkdir -p "$out/bin"
  printf '%s\n' '#!${runtimeShell}' \
    "exec $out/libexec/desktop-host-launch ${xdgOpen} \"\$@\"" > "$out/bin/xdg-open"
  chmod +x "$out/bin/xdg-open"
  ${lib.concatStrings (lib.mapAttrsToList installEditor editors)}
''

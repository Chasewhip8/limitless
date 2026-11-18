{ pkgs, desktops }:
let
  inherit (pkgs) lib;
  xdgOpen = lib.getExe' pkgs.xdg-utils "xdg-open";
  # Each command a launcher provides must resolve to it inside the AppImage
  # sandbox, ahead of AppRun's AppDir entries and the FHS environment's tools.
  checkDesktop =
    { package, commands }:
    let
      inherit (package) contents fhsenv launchers;
    in
    ''
      test "$(ls ${launchers}/bin)" = ${lib.escapeShellArg (lib.concatStringsSep "\n" (lib.sort lib.lessThan commands))}

      # On the host, launchers must neither enter the profile nor delegate to themselves.
      test ! -e ${package}/bin/xdg-open
      grep -qF -- 'desktop-host-launch ${xdgOpen} "$@"' ${launchers}/bin/xdg-open

      grep -qxF 'export PATH="''${APPDIR}:''${APPDIR}/usr/sbin''${PATH:+:''${PATH}}"' ${contents}/AppRun
      for command in ${launchers}/bin/*; do
        name=''${command##*/}
        resolved=$(
          PATH=/host/bin
          source ${fhsenv}/etc/profile
          IFS=: read -ra directories <<< "${contents}:${contents}/usr/sbin:$PATH"
          for directory in "''${directories[@]}"; do
            [[ $directory == /usr/* ]] && directory=${fhsenv}$directory
            if [[ -x $directory/$name ]]; then
              echo "$directory/$name"
              break
            fi
          done
        )
        test "$resolved" = "$command"
      done
    '';
in
pkgs.runCommand "limitless-desktop-launchers-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  cp ${../packages/desktop-host-launch.sh} desktop-host-launch.sh
  cp ${../packages/desktop-host-editor.sh} desktop-host-editor.sh
  cp ${../packages/desktop-host-launch.test.mjs} desktop-host-launch.test.mjs
  node --test desktop-host-launch.test.mjs

  ${lib.concatMapStrings checkDesktop desktops}
  touch "$out"
''

{ pkgs, package }:
let
  inherit (pkgs) lib;
  inherit (package) contents fhsenv xdgOpen;
in
pkgs.runCommand "limitless-t3-desktop-check" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  cp ${../packages/t3-xdg-open.sh} t3-xdg-open.sh
  cp ${../packages/t3-xdg-open.test.mjs} t3-xdg-open.test.mjs
  node --test t3-xdg-open.test.mjs

  # On the host, the shim must neither enter the profile nor delegate to itself.
  test ! -e ${package}/bin/xdg-open
  grep -qF -- '-- ${lib.getExe' pkgs.xdg-utils "xdg-open"} "$@"' ${xdgOpen}/bin/xdg-open

  # Electron must find the shim before AppRun's AppDir entries and the FHS xdg-utils.
  grep -qxF 'export PATH="''${APPDIR}:''${APPDIR}/usr/sbin''${PATH:+:''${PATH}}"' ${contents}/AppRun
  resolved=$(
    PATH=/host/bin
    source ${fhsenv}/etc/profile
    IFS=: read -ra directories <<< "${contents}:${contents}/usr/sbin:$PATH"
    for directory in "''${directories[@]}"; do
      [[ $directory == /usr/* ]] && directory=${fhsenv}$directory
      if [[ -x $directory/xdg-open ]]; then
        echo "$directory/xdg-open"
        break
      fi
    done
  )
  test "$resolved" = ${xdgOpen}/bin/xdg-open
  test -x ${fhsenv}/usr/bin/xdg-open

  touch "$out"
''

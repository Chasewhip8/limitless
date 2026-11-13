{ pkgs, package }:
let
  inherit (pkgs) lib;
  inherit (package) contents fhsenv xdgOpen;
  original = pkgs.appimageTools.extract {
    pname = "t3-desktop";
    version = lib.getVersion package;
    inherit (package) src;
  };
  bundle = "apps/desktop/dist-electron/main.cjs";
in
pkgs.runCommand "limitless-t3-desktop-check"
  {
    nativeBuildInputs = [
      pkgs.asar
      pkgs.nodejs
    ];
  }
  ''
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

    # The archive rewrite changes only T3's main bundle, as read by upstream asar.
    asar extract ${original}/resources/app.asar original
    asar extract ${contents}/resources/app.asar patched
    mv original/${bundle} original.cjs
    mv patched/${bundle} patched.cjs
    diff -r original patched

    # T3 must keep the shim first after replacing PATH from a login shell or its cache.
    node ${./validate-t3-desktop.mjs} original.cjs patched.cjs ${xdgOpen}/bin

    touch "$out"
  ''

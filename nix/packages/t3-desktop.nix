{
  appimageTools,
  desktop-file-utils,
  fetchurl,
  lib,
  replaceVars,
  runCommand,
  runtimeShell,
  systemd,
  t3,
  xdg-utils,
}:
let
  pname = "t3-desktop";
  inherit (t3) version;
  src = fetchurl {
    url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/T3-Code-${version}-x86_64.AppImage";
    hash = "sha256-4Rdpi+TMWeXsFBbFHf1EKlPvoxQZd7wgy9DYH9P9WCQ=";
  };
  contents = appimageTools.extract { inherit pname version src; };
  xdgOpen = runCommand "${pname}-xdg-open" { } ''
    install -Dm755 ${
      replaceVars ./t3-xdg-open.sh {
        inherit runtimeShell;
        systemdRun = "${lib.getBin systemd}/bin/systemd-run";
        xdgOpen = lib.getExe' xdg-utils "xdg-open";
      }
    } "$out/bin/xdg-open"
  '';
in
appimageTools.wrapType2 {
  inherit pname version src;
  nativeBuildInputs = [ desktop-file-utils ];

  # Electron 44 opens external URLs by searching PATH for `xdg-open`.
  profile = ''
    export PATH="${xdgOpen}/bin:$PATH"
  '';

  extraInstallCommands = ''
    grep -qxF 'X-AppImage-Version=${version}' ${contents}/t3code.desktop
    desktop-file-install --dir "$out/share/applications" \
      --set-key Exec --set-value "${pname} %U" \
      ${contents}/t3code.desktop
    cp -r ${contents}/usr/share/icons "$out/share/"
  '';

  passthru = { inherit contents xdgOpen; };

  meta = {
    description = "T3 Code desktop client";
    homepage = "https://t3.codes";
    changelog = "https://github.com/pingdotgg/t3code/releases/tag/v${version}";
    license = lib.licenses.mit;
    mainProgram = pname;
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}

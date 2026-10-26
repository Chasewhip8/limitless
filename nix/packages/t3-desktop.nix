{
  appimageTools,
  desktop-file-utils,
  fetchurl,
  lib,
  t3,
}:
let
  pname = "t3-desktop";
  inherit (t3) version;
  src = fetchurl {
    url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/T3-Code-${version}-x86_64.AppImage";
    hash = "sha256-zwHi0Wfv+dAcTBAE0xssDaniUizJQmLkFkTRyxXf21w=";
  };
  contents = appimageTools.extract { inherit pname version src; };
in
appimageTools.wrapType2 {
  inherit pname version src;
  nativeBuildInputs = [ desktop-file-utils ];

  extraInstallCommands = ''
    grep -qxF 'X-AppImage-Version=${version}' ${contents}/t3code.desktop
    desktop-file-install --dir "$out/share/applications" \
      --set-key Exec --set-value "${pname} %U" \
      ${contents}/t3code.desktop
    cp -r ${contents}/usr/share/icons "$out/share/"
  '';

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

{
  appimageTools,
  desktop-file-utils,
  fetchurl,
  lib,
  paseo,
}:
let
  pname = "paseo-desktop";
  inherit (paseo) version;
  src = fetchurl {
    name = "paseo-desktop-${version}-x86_64.AppImage";
    url = "https://github.com/getpaseo/paseo/releases/download/v${version}/Paseo-x86_64.AppImage";
    hash = "sha256-jFzqM/w86IsPU6I51lghiMcL1YcRNwTvaX25qDEBQ18=";
  };
  contents = appimageTools.extract { inherit pname version src; };
in
appimageTools.wrapType2 {
  inherit pname version src;

  nativeBuildInputs = [ desktop-file-utils ];

  extraInstallCommands = ''
    desktop-file-install --dir "$out/share/applications" \
      --set-key Exec --set-value "${pname} %U" \
      ${contents}/Paseo.desktop
    cp -r ${contents}/usr/share/icons "$out/share/"
  '';

  meta = {
    description = "Paseo desktop app for agents on local and remote Paseo daemons";
    homepage = "https://paseo.sh";
    changelog = "https://github.com/getpaseo/paseo/releases/tag/v${version}";
    license = lib.licenses.asl20;
    mainProgram = pname;
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}

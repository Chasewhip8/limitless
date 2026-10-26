{
  appimageTools,
  desktop-file-utils,
  fetchurl,
  lib,
  opencode,
}:
let
  pname = "opencode-desktop";
  inherit (opencode) version;
  src = fetchurl {
    # A versioned name prevents a stale hash from reusing an older release.
    name = "${pname}-${version}-x86_64.AppImage";
    url = "https://opencode.ai/files/bin/${version}/opencode-desktop-linux-x86_64.AppImage";
    hash = "sha256-qwVNaEZwDoyD1dCSNuvZCDFE3U5xQdeNXqdq2+iUXdg=";
  };
  contents = appimageTools.extract { inherit pname version src; };
in
appimageTools.wrapType2 {
  inherit pname version src;
  nativeBuildInputs = [ desktop-file-utils ];

  extraInstallCommands = ''
    # Desktop can replace a running shared service when its bundled CLI differs.
    test "$(cat ${contents}/resources/opencode-cli.version)" = ${lib.escapeShellArg version}
    desktop-file-install --dir "$out/share/applications" \
      --set-key Exec --set-value "${pname} %U" \
      ${contents}/ai.opencode.desktop.desktop
    cp -r ${contents}/usr/share/icons "$out/share/"
  '';

  meta = {
    description = "OpenCode V2 desktop client";
    homepage = "https://opencode.ai/v2";
    license = lib.licenses.mit;
    mainProgram = pname;
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}

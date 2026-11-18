{
  appimageTools,
  callPackage,
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
    hash = "sha256-xm8/I2bCYsh21M8U/K9axkNMtPBCByg8TmLAGblkwN4=";
  };
  contents = appimageTools.extract { inherit pname version src; };
  # OpenCode's Linux "Open in" menu runs these editors by name.
  launchers = callPackage ./desktop-host-launchers.nix {
    name = pname;
    editors = {
      code = [ "code" ];
      cursor = [ "cursor" ];
      # Linux packages name the editor zeditor because OpenZFS owns zed.
      zed = [
        "zeditor"
        "zed"
      ];
    };
  };
in
appimageTools.wrapAppImage {
  inherit pname version contents;
  nativeBuildInputs = [ desktop-file-utils ];

  # Electron opens links and editors by searching PATH. OpenCode replaces PATH with
  # its login shell's, which keeps this prefix because NixOS's environment setup has
  # already run in the desktop session.
  profile = ''
    export PATH="${launchers}/bin:$PATH"
  '';

  extraInstallCommands = ''
    # Desktop can replace a running shared service when its bundled CLI differs.
    test "$(cat ${contents}/resources/opencode-cli.version)" = ${lib.escapeShellArg version}
    desktop-file-install --dir "$out/share/applications" \
      --set-key Exec --set-value "${pname} %U" \
      ${contents}/ai.opencode.desktop.desktop
    cp -r ${contents}/usr/share/icons "$out/share/"
  '';

  passthru = { inherit contents src launchers; };

  meta = {
    description = "OpenCode V2 desktop client";
    homepage = "https://opencode.ai/v2";
    license = lib.licenses.mit;
    mainProgram = pname;
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}

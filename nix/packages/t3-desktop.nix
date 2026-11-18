{
  appimageTools,
  callPackage,
  desktop-file-utils,
  fetchurl,
  lib,
  nodejs,
  t3,
}:
let
  pname = "t3-desktop";
  inherit (t3) version;
  src = fetchurl {
    url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/T3-Code-x86_64.AppImage";
    hash = "sha256-fN7RPBB1cVOQHt3ayaJgixVvF0Rd5Qbvn/33PAFSjXk=";
  };
  launchers = callPackage ./desktop-host-launchers.nix { name = pname; };
  contents = appimageTools.extract {
    inherit pname version src;
    postExtract = ''
      chmod u+w "$out/resources" "$out/resources/app.asar"
      ${lib.getExe nodejs} ${./t3-desktop-asar.mjs} "$out/resources/app.asar" ${launchers}/bin
    '';
  };
in
appimageTools.wrapAppImage {
  inherit pname version contents;
  nativeBuildInputs = [ desktop-file-utils ];

  # Electron 44 opens external URLs by searching PATH for `xdg-open`. T3 later
  # prepends its login-shell PATH, so the bundled patch restores this order.
  profile = ''
    export PATH="${launchers}/bin:$PATH"
  '';

  extraInstallCommands = ''
    grep -qxF 'X-AppImage-Version=${version}' ${contents}/t3code.desktop
    desktop-file-install --dir "$out/share/applications" \
      --set-key Exec --set-value "${pname} %U" \
      ${contents}/t3code.desktop
    cp -r ${contents}/usr/share/icons "$out/share/"
  '';

  passthru = { inherit contents src launchers; };

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

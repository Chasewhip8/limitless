{ pkgs, opencode }:
let
  inherit (pkgs) lib;
  version = "2.0.12";
  sources = {
    x86_64-linux = {
      platform = "x86_64";
      hash = "sha256-RA+wAPrnVgaZMdoK6wkDsh4SHCufO14zuwerOP6p8dk=";
    };
    aarch64-linux = {
      platform = "arm64";
      hash = "sha256-j1NoMFgk3ROQcOnX7/hw4dyt6z4vGrcDqJA0A/ub5sg=";
    };
  };
  source =
    sources.${pkgs.stdenv.hostPlatform.system}
      or (throw "OpenCode Desktop is unsupported on ${pkgs.stdenv.hostPlatform.system}");
  appImage = pkgs.appimageTools.extract {
    pname = "opencode-desktop";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://opencode.ai/files/bin/${version}/opencode-desktop-linux-${source.platform}.AppImage";
      inherit (source) hash;
    };
  };
  # Chromium and ANGLE load these at runtime instead of linking them.
  dlopenedLibraries = with pkgs; [
    libGL
    libnotify
    libpulseaudio
    libsecret
    systemd
    wayland
  ];
in
pkgs.stdenv.mkDerivation {
  pname = "opencode-desktop";
  inherit version;
  src = appImage;

  nativeBuildInputs = with pkgs; [
    asar
    autoPatchelfHook
    desktop-file-utils
    makeShellWrapper
    wrapGAppsHook3
  ];
  buildInputs = with pkgs; [
    alsa-lib
    at-spi2-atk
    at-spi2-core
    cairo
    cups
    dbus
    expat
    glib
    gsettings-desktop-schemas
    gtk3
    libdrm
    libgbm
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxkbcommon
    libxrandr
    nspr
    nss
    pango
    stdenv.cc.cc.lib
    systemd
  ];
  appendRunpaths = map (library: "${lib.getLib library}/lib") dlopenedLibraries;

  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  dontWrapGApps = true;

  installPhase = ''
    runHook preInstall

    app=$out/opt/opencode-desktop
    mkdir -p "$app" "$out/bin" "$out/share"
    cp -r . "$app"
    chmod -R u+w "$app"
    cp -r usr/share/icons "$out/share/icons"
    # AppImage launchers, legacy bundled libraries, and the setuid helper do not apply
    # to a Nix store install; Chromium falls back to its user-namespace sandbox.
    rm -r "$app"/{AppRun,usr,chrome-sandbox,.DirIcon,ai.opencode.desktop.png,ai.opencode.desktop.desktop}

    asar extract "$app/resources/app.asar" "$app/resources/app"
    rm -r "$app/resources/app.asar" "$app/resources/app.asar.unpacked"
    # The desktop copies its CLI into userData once per version and reuses that copy.
    # A copy would outlive the Nix generation it came from, so run the CLI in place.
    desktopMain=$(echo "$app"/resources/app/out/main/desktop-*.js)
    substituteInPlace "$desktopMain" \
      --replace-fail \
        'a=z.isPackaged||e?yield*l_(r,i):r;return{version:i,binary:a,command:[a]}' \
        'a=r;return{version:i,binary:a,command:[a]}'

    # Run the given OpenCode runtime so desktop-started services match the CLI's.
    rm "$app/resources/opencode-cli"
    ln -s ${opencode}/bin/opencode "$app/resources/opencode-cli"

    desktop-file-install --dir "$out/share/applications" \
      --set-key Exec --set-value "opencode-desktop %U" \
      --remove-key X-AppImage-Version \
      ai.opencode.desktop.desktop

    runHook postInstall
  '';

  # A shell wrapper expands the Wayland flags at launch; binary wrappers pass them literally.
  postFixup = ''
    makeShellWrapper "$out/opt/opencode-desktop/ai.opencode.desktop" "$out/bin/opencode-desktop" \
      "''${gappsWrapperArgs[@]}" \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}"
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ pkgs.writableTmpDirAsHomeHook ];
  installCheckPhase = ''
    runHook preInstallCheck

    resources=$out/opt/opencode-desktop/resources
    bundled=$(cat "$resources/opencode-cli.version")
    reported=$("$resources/opencode-cli" --version)
    if [ "$reported" != "opencode v$bundled" ]; then
      echo "Desktop expects OpenCode $bundled but its CLI reports: $reported" >&2
      exit 1
    fi
    # Loads the native terminal module through the patched Electron runtime.
    ELECTRON_RUN_AS_NODE=1 "$out/opt/opencode-desktop/ai.opencode.desktop" -e '
      require(process.argv[1])
      if (process.versions.electron === undefined) process.exit(1)
    ' "$(echo "$resources"/app/node_modules/@lydell/node-pty-linux-*)/lib/index.js"

    runHook postInstallCheck
  '';

  meta = {
    description = "OpenCode 2 desktop app";
    homepage = "https://opencode.ai";
    license = lib.licenses.mit;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    mainProgram = "opencode-desktop";
    platforms = builtins.attrNames sources;
  };
}

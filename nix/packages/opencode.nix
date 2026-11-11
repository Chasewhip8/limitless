{ pkgs }:
let
  version = "2.2.7";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
    };
    aarch64-linux = {
      platform = "linux-arm64";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
    };
  };
  source =
    sources.${pkgs.stdenv.hostPlatform.system}
      or (throw "OpenCode 2 is unsupported on ${pkgs.stdenv.hostPlatform.system}");
  # Upstream's packageManager and release workflow pin 1.4.4; the flake's Bun is older.
  bun = import ./opencode-bun.nix { pkgs = pkgs.buildPackages; };
  src = pkgs.fetchurl {
    url = "https://github.com/anomalyco/opencode/archive/fedc6f208aa2bd54c1019227214568083f6380ad.tar.gz";
    hash = "sha256-k5GzARi1PYhV6eaXKic3TfnoGT0YmqazU7k0B4uespk=";
  };
  dependencies = pkgs.stdenvNoCC.mkDerivation {
    name = "opencode-${version}-bun-deps";
    inherit src;
    nativeBuildInputs = [
      bun
      pkgs.cacert
      pkgs.git
    ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      export HOME=$TMPDIR
      bun install --frozen-lockfile --ignore-scripts --no-progress --os='*' --cpu='*' --libc='*'
    '';
    installPhase = ''
      mkdir -p "$out"
      find . -name node_modules -type d -prune -exec cp -r --parents {} "$out" \;
    '';
    outputHash = "sha256-0pprCJUSWQRO9JjQ3/8d7CVa0ztnrTS4/HWk7JxP4uk=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
pkgs.stdenv.mkDerivation {
  pname = "opencode";
  inherit version;

  inherit src;
  patches = [
    ../patches/opencode-persist-events.patch
    ../patches/opencode-password-file.patch
  ];

  nativeBuildInputs = [
    pkgs.makeWrapper
    bun
    pkgs.nodejs
  ]
  ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
  buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];

  dontStrip = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    cp -r ${dependencies}/. .
    chmod -R u+w node_modules packages/*/node_modules
    patchShebangs packages/app/node_modules/vite/bin/vite.js
    bun run --cwd packages/core fix-node-pty
    export OPENCODE_VERSION=${version}
    export OPENCODE_CHANNEL=latest
    export OPENCODE_TARGET=${source.platform}
    bun run packages/cli/script/build.ts --skip-install
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 packages/cli/dist/cli-${source.platform}/bin/opencode $out/bin/opencode
    wrapProgram $out/bin/opencode --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ripgrep ]}

    runHook postInstall
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ pkgs.versionCheckHook ];
  versionCheckProgramArg = "--version";

  passthru = { inherit dependencies bun; };

  meta = {
    description = "OpenCode 2 CLI";
    homepage = "https://opencode.ai";
    downloadPage = "https://www.npmjs.com/package/@opencode/cli?activeTab=versions";
    license = pkgs.lib.licenses.mit;
    mainProgram = "opencode";
    platforms = builtins.attrNames sources;
  };
}

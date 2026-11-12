{ pkgs, self }:
let
  inherit (pkgs) lib;
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
  root = self.outPath or self;
  # Capsule's source compiles against this build's Effect and Core. Its Linux runtime arrives only
  # through OPENCODE_CAPSULE_CONFIG, so no platform's build depends on the Capsule package. The CLI
  # and the SDK provider stay out: the SDK imports the server, which would make a cycle.
  capsuleSource = lib.cleanSourceWith {
    src = self;
    filter =
      path: type:
      let
        relative = lib.removePrefix "${toString root}/" (toString path);
      in
      lib.cleanSourceFilter path type
      && (
        builtins.elem relative [
          "packages"
          "packages/capsule"
          "packages/capsule/src"
        ]
        || (
          lib.hasPrefix "packages/capsule/src/" relative
          && relative != "packages/capsule/src/cli"
          && !lib.hasPrefix "packages/capsule/src/cli/" relative
          && relative != "packages/capsule/src/opencode.ts"
        )
      );
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
    ../patches/opencode-capsule.patch
  ];
  postPatch = ''
    cp -r ${capsuleSource}/packages/capsule/src packages/server/src/limitless-capsule
    chmod -R u+w packages/server/src/limitless-capsule
    cp ${./opencode-capsule.ts} packages/server/src/limitless-capsule.ts
  '';

  nativeBuildInputs = [
    pkgs.makeWrapper
    bun
    pkgs.nodejs
  ]
  ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
  buildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];

  dontStrip = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    cp -r ${dependencies}/. .
    chmod -R u+w node_modules packages/*/node_modules
    patchShebangs packages/app/node_modules/vite/bin/vite.js
    bun run --cwd packages/core fix-node-pty
    # The server graph must resolve Capsule against this build's packages; type-only imports erase.
    cat > "$TMPDIR/capsule-imports.mjs" <<'EOF'
    import assert from "node:assert/strict"
    import { existsSync, readFileSync } from "node:fs"
    import { dirname, relative, resolve } from "node:path"

    const transpiler = new Bun.Transpiler({ loader: "ts" })
    const allowed = /^(node:|effect(\/|$)|@effect\/platform-node$|@opencode\/(core|schema)\/)/
    const visited = new Set()
    const source = (base) => [`''${base}.ts`, `''${base}/index.ts`].find((file) => existsSync(file))
    const visit = (file) => {
      if (visited.has(file)) return
      visited.add(file)
      for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
        if (!path.startsWith(".")) {
          assert(allowed.test(path), `''${file} imports ''${path} at runtime`)
          continue
        }
        const target = source(resolve(dirname(file), path))
        assert(target, `''${file} imports missing ''${path}`)
        visit(target)
      }
    }
    visit(resolve("packages/server/src/limitless-capsule.ts"))
    const reached = [...visited].map((file) => relative("packages/server/src/limitless-capsule", file))
    for (const module of ["host/plugin.ts", "workspace/driver.ts", "service.ts", "source/service.ts"])
      assert(reached.includes(module), `The Capsule bridge does not reach ''${module}`)
    EOF
    bun "$TMPDIR/capsule-imports.mjs"
    # Bun compiles without type checking; Capsule's source targets a newer Effect than this build.
    node packages/server/node_modules/@typescript/native/bin/tsc -b packages/server
    export OPENCODE_VERSION=${version}
    export OPENCODE_CHANNEL=latest
    export OPENCODE_TARGET=${source.platform}
    bun run packages/cli/script/build.ts --skip-install
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 packages/cli/dist/cli-${source.platform}/bin/opencode $out/bin/opencode
    wrapProgram $out/bin/opencode --prefix PATH : ${lib.makeBinPath [ pkgs.ripgrep ]}

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
    license = lib.licenses.mit;
    mainProgram = "opencode";
    platforms = builtins.attrNames sources;
  };
}

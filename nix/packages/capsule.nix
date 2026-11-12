{ pkgs, self }:
let
  inherit (pkgs) lib;
  root = self.outPath or self;
  node = pkgs.nodejs_22;
  source = lib.cleanSourceWith {
    src = self;
    filter =
      path: type:
      let
        relative = lib.removePrefix "${toString root}/" (toString path);
      in
      lib.cleanSourceFilter path type
      && builtins.baseNameOf path != "node_modules"
      && (
        builtins.elem relative [
          "packages"
          "packages/capsule"
        ]
        || lib.hasPrefix "packages/capsule/" relative
      );
  };
  # Bun's frozen install rejects a lockfile whose workspaces are missing on disk.
  workspaces = lib.filter (name: builtins.pathExists (root + "/packages/${name}/package.json")) (
    lib.attrNames (
      lib.filterAttrs (_: type: type == "directory") (builtins.readDir (root + "/packages"))
    )
  );
  manifests = pkgs.runCommand "capsule-dependency-manifests" { } ''
    mkdir -p "$out"
    cp ${root + "/package.json"} "$out/package.json"
    cp ${root + "/bun.lock"} "$out/bun.lock"
    ${lib.concatMapStrings (name: ''
      mkdir -p "$out/packages/${name}"
      cp ${root + "/packages/${name}/package.json"} "$out/packages/${name}/package.json"
    '') workspaces}
  '';
  dependencies = pkgs.stdenvNoCC.mkDerivation {
    name = "capsule-bun-deps";
    src = manifests;
    nativeBuildInputs = [ pkgs.bun ];
    dontConfigure = true;
    dontFixup = true;
    # Omitting peers keeps the optional OpenCode SDK closure out; hosted builds
    # externalize it and the standalone CLI never imports it.
    buildPhase = ''
      export HOME="$TMPDIR"
      bun install --filter @limitless/capsule --no-progress --frozen-lockfile --ignore-scripts \
        --production --omit optional --omit peer
    '';
    installPhase = ''
      mkdir -p "$out/node_modules" "$out/packages/capsule"
      cp -r node_modules/.bun "$out/node_modules/.bun"
      cp -r packages/capsule/node_modules "$out/packages/capsule/node_modules"
      # Bun's executable-link race must not affect the fixed-output tree.
      find "$out" -type d -path '*/node_modules/.bin' -prune -exec rm -rf {} +
    '';
    outputHash = "sha256-kMJruasSpGiQXNFGcAN9YRUEG1uZp1DvY9ESny5RWYY=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
  runtime = {
    bwrap = lib.getExe pkgs.bubblewrap;
    shell = lib.getExe pkgs.bashInteractive;
    env = "${pkgs.coreutils}/bin/env";
    nix = lib.getExe pkgs.nix;
    flock = "${pkgs.util-linux}/bin/flock";
    # Project toolchains, including Node, come from the project's dev shell.
    basePath = lib.makeBinPath [
      pkgs.bashInteractive
      pkgs.coreutils
      pkgs.findutils
      pkgs.diffutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.gawk
      pkgs.gnutar
      pkgs.gzip
      pkgs.xz
      pkgs.which
      pkgs.procps
      pkgs.git
      pkgs.ripgrep
      pkgs.nix
      pkgs.docker-client
      pkgs.docker-compose
    ];
    certificates = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  };
  runtimeConfig = pkgs.writeText "capsule-runtime.json" (builtins.toJSON runtime);
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "capsule";
  version = "0.1.0";
  src = source;
  nativeBuildInputs = [
    pkgs.bun
    pkgs.makeWrapper
  ];
  dontConfigure = true;
  dontFixup = true;
  buildPhase = ''
    mkdir -p node_modules dist/lib
    cp -r ${dependencies}/node_modules/.bun node_modules/.bun
    cp -r ${dependencies}/packages/capsule/node_modules packages/capsule/node_modules

    bun build packages/capsule/cli.ts \
      --target=node --format=esm --packages=bundle \
      --metafile=dist/capsule.meta.json --outfile=dist/capsule.mjs
    # Hosted consumers must share OpenCode's Effect and SDK instances. Splitting
    # keeps core classes shared between the core and provider entries.
    bun build packages/capsule/index.ts packages/capsule/opencode.ts \
      --target=node --format=esm --packages=bundle --splitting \
      --external effect --external 'effect/*' \
      --external @opencode/sdk --external '@opencode/sdk/*' \
      --metafile=dist/lib.meta.json --outdir=dist/lib
  '';
  doCheck = true;
  checkPhase = ''
    # The runtime schema resolves Effect from the Capsule workspace.
    cat > packages/capsule/package-check.ts <<'EOF'
    import assert from "node:assert/strict";
    import { accessSync, constants, readFileSync } from "node:fs";
    import { Schema } from "effect";
    import { RuntimeSettings } from "./schema.ts";

    const settings = Schema.decodeUnknownSync(RuntimeSettings)(
      JSON.parse(readFileSync(process.argv[2], "utf8")),
      { onExcessProperty: "error" },
    );
    for (const name of ["bwrap", "shell", "env", "nix", "flock"]) accessSync(settings[name], constants.X_OK);
    accessSync(settings.certificates, constants.R_OK);
    for (const directory of settings.basePath.split(":")) accessSync(directory, constants.X_OK);
    assert(!settings.basePath.includes("nodejs"), "Project Node runtimes belong to project dev shells");

    const inputs = (file) => Object.keys(JSON.parse(readFileSync(file, "utf8")).inputs);
    const bundles = (paths, name) => paths.some((path) => path.includes(`/node_modules/''${name}/`));
    const cli = inputs("dist/capsule.meta.json");
    for (const name of ["effect", "@effect/platform-node"]) {
      assert(bundles(cli, name), `Standalone Capsule must bundle ''${name}`);
    }
    const library = inputs("dist/lib.meta.json");
    assert(!bundles(library, "effect"), "Hosted Capsule bundles Effect");
    for (const paths of [cli, library]) {
      assert(!paths.some((path) => /(^|\/)node_modules\/@opencode\//.test(path)), "Capsule bundles OpenCode");
    }

    // Externals are absent from output imports, so inspect the emitted core chunks.
    const { outputs } = JSON.parse(readFileSync("dist/lib.meta.json", "utf8"));
    const core = new Set();
    const visit = (output) => {
      if (core.has(output)) return;
      core.add(output);
      for (const { path } of outputs[output].imports) visit(path);
    };
    visit(Object.keys(outputs).find((output) => outputs[output].entryPoint === "packages/capsule/index.ts"));
    for (const output of core) {
      assert(!readFileSync(`dist/lib/''${output}`, "utf8").includes("@opencode/"), "Capsule core imports OpenCode");
    }
    EOF
    bun packages/capsule/package-check.ts ${runtimeConfig}
  '';
  installPhase = ''
    mkdir -p "$out/lib/capsule" "$out/share/capsule" "$out/bin"
    cp dist/capsule.mjs "$out/lib/capsule/capsule.mjs"
    cp dist/lib/*.js "$out/lib/capsule/"
    cat > "$out/lib/capsule/package.json" <<'EOF'
    {
      "name": "@limitless/capsule",
      "version": "0.1.0",
      "type": "module",
      "exports": {
        ".": "./index.js",
        "./opencode": "./opencode.js"
      },
      "peerDependencies": {
        "@opencode/sdk": "2.2.7",
        "effect": "4.1.3"
      },
      "peerDependenciesMeta": {
        "@opencode/sdk": { "optional": true }
      }
    }
    EOF
    ln -s ${runtimeConfig} "$out/share/capsule/runtime.json"
    makeWrapper ${lib.getExe node} "$out/bin/capsule" \
      --set CAPSULE_RUNTIME_CONFIG ${runtimeConfig} \
      --add-flags "$out/lib/capsule/capsule.mjs"
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/capsule" --help > /dev/null
    runHook postInstallCheck
  '';
  passthru = {
    inherit
      dependencies
      node
      runtime
      runtimeConfig
      ;
  };
  meta = {
    description = "Bubblewrap capsules for project development environments";
    mainProgram = "capsule";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}

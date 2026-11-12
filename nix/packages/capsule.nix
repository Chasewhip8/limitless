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
    # Omitting peers keeps the optional OpenCode SDK and plugin closures out; hosted
    # builds externalize them and the standalone CLI never imports them.
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
    outputHash = "sha256-BH4QrgIpnk5p0/XD4RlBoY+TYH93VyhZ5k5ByL9Am0k=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
  runtime = {
    bwrap = lib.getExe pkgs.bubblewrap;
    shell = lib.getExe pkgs.bashInteractive;
    env = "${pkgs.coreutils}/bin/env";
    nix = lib.getExe pkgs.nix;
    flock = "${pkgs.util-linux}/bin/flock";
    gh = lib.getExe pkgs.gh;
    # Supervises source locks only; it never joins a capsule's PATH.
    node = lib.getExe node;
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
      pkgs.gh
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

    bun build packages/capsule/src/cli/main.ts \
      --target=node --format=esm --packages=bundle \
      --metafile=dist/capsule.meta.json --outfile=dist/capsule.mjs
    # Hosted consumers must share OpenCode's Effect, Schema, and SDK instances.
    # Splitting keeps core classes shared between the entries.
    bun build packages/capsule/src/index.ts packages/capsule/src/opencode.ts \
      packages/capsule/src/source/index.ts packages/capsule/src/host/index.ts \
      packages/capsule/src/host/contract.ts \
      --target=node --format=esm --packages=bundle --splitting \
      --root packages/capsule/src \
      --external effect --external 'effect/*' \
      --external '@opencode/*' \
      --metafile=dist/lib.meta.json --outdir=dist/lib
  '';
  doCheck = true;
  checkPhase = ''
    # The runtime schema resolves Effect from the Capsule workspace.
    cat > packages/capsule/package-check.ts <<'EOF'
    import assert from "node:assert/strict";
    import { accessSync, constants, readFileSync } from "node:fs";
    import { Schema } from "effect";
    import { RuntimeSettings } from "./src/schema.ts";

    const settings = Schema.decodeUnknownSync(RuntimeSettings)(
      JSON.parse(readFileSync(process.argv[2], "utf8")),
      { onExcessProperty: "error" },
    );
    for (const name of ["bwrap", "shell", "env", "nix", "flock", "gh", "node"]) {
      accessSync(settings[name], constants.X_OK);
    }
    accessSync(settings.certificates, constants.R_OK);
    for (const directory of settings.basePath.split(":")) accessSync(directory, constants.X_OK);
    assert(!settings.basePath.includes("nodejs"), "Project Node runtimes belong to project dev shells");

    const meta = (file) => JSON.parse(readFileSync(file, "utf8"));
    const bundles = (paths, name) => paths.some((path) => path.includes(`/node_modules/''${name}/`));
    const cli = Object.keys(meta("dist/capsule.meta.json").inputs);
    for (const name of ["effect", "@effect/platform-node"]) {
      assert(bundles(cli, name), `Standalone Capsule must bundle ''${name}`);
    }
    const library = meta("dist/lib.meta.json");
    assert(!bundles(Object.keys(library.inputs), "effect"), "Hosted Capsule bundles Effect");
    for (const paths of [cli, Object.keys(library.inputs)]) {
      assert(!paths.some((path) => /(^|\/)node_modules\/@opencode\//.test(path)), "Capsule bundles OpenCode");
    }

    // Externals are absent from metafile imports, so inspect each emitted
    // chunk reachable from an SDK-free entry.
    const { outputs } = library;
    const entry = (source) => {
      const output = Object.keys(outputs).find((output) => outputs[output].entryPoint === source);
      assert(output, `Hosted Capsule omits ''${source}`);
      return output;
    };
    const exported = {
      "index.ts": "index.js",
      "opencode.ts": "opencode.js",
      "source/index.ts": "source/index.js",
      "host/index.ts": "host/index.js",
      "host/contract.ts": "host/contract.js",
    };
    for (const [source, output] of Object.entries(exported)) {
      assert.equal(entry(`packages/capsule/src/''${source}`).replace(/^\.\//, ""), output);
    }
    const reach = (sources) => {
      const reachable = new Set();
      const visit = (output) => {
        if (reachable.has(output)) return;
        reachable.add(output);
        for (const { path } of outputs[output].imports) if (path in outputs) visit(path);
      };
      for (const source of sources) visit(entry(`packages/capsule/src/''${source}`));
      return [...reachable].map((output) => readFileSync(`dist/lib/''${output}`, "utf8"));
    };
    const imports = (code) =>
      new Bun.Transpiler({ loader: "js" }).scanImports(code).map(({ path }) => path).filter((path) => !path.startsWith("."));
    const only = (sources, allowed) => {
      for (const path of reach(sources).flatMap(imports)) {
        assert(allowed.test(path), `''${sources.join(", ")} reach unexpected external ''${path}`);
      }
    };
    only(["index.ts", "source/index.ts"], /^(node:|effect(\/|$))/);
    // The native host and RPC contract run inside OpenCode's server, which the SDK imports.
    only(["host/index.ts", "host/contract.ts"], /^(node:|effect(\/|$)|@opencode\/schema\/)/);
    EOF
    bun packages/capsule/package-check.ts ${runtimeConfig}
  '';
  installPhase = ''
    mkdir -p "$out/lib/capsule" "$out/share/capsule" "$out/bin"
    cp dist/capsule.mjs "$out/lib/capsule/capsule.mjs"
    cp -r dist/lib/. "$out/lib/capsule/"
    cat > "$out/lib/capsule/package.json" <<'EOF'
    {
      "name": "@limitless/capsule",
      "version": "0.1.0",
      "type": "module",
      "exports": {
        ".": "./index.js",
        "./opencode": "./opencode.js",
        "./source": "./source/index.js",
        "./host": "./host/index.js",
        "./rpc": "./host/contract.js"
      },
      "peerDependencies": {
        "@opencode/schema": "2.2.7",
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

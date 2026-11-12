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
          "packages/pipeline"
          "packages/capsule"
          "packages/capsule/package.json"
          "packages/capsule/src"
        ]
        || lib.hasPrefix "packages/pipeline/" relative
        || lib.hasPrefix "packages/capsule/src/" relative
      );
  };
  manifests = pkgs.runCommand "pipeline-dependency-manifests" { } ''
    mkdir -p "$out/packages/limitless" "$out/packages/pipeline" "$out/packages/capsule"
    cp ${root + "/package.json"} "$out/package.json"
    cp ${root + "/bun.lock"} "$out/bun.lock"
    cp ${root + "/packages/limitless/package.json"} "$out/packages/limitless/package.json"
    cp ${root + "/packages/pipeline/package.json"} "$out/packages/pipeline/package.json"
    cp ${root + "/packages/capsule/package.json"} "$out/packages/capsule/package.json"
  '';
  dependencies = pkgs.stdenvNoCC.mkDerivation {
    name = "pipeline-bun-deps";
    src = manifests;
    nativeBuildInputs = [ pkgs.bun ];
    dontConfigure = true;
    dontFixup = true;
    # Omitting peers keeps Capsule's optional OpenCode SDK and plugin out of the dispatcher.
    buildPhase = ''
      export HOME="$TMPDIR"
      bun install --filter @limitless/pipeline --no-progress --frozen-lockfile --ignore-scripts \
        --production --omit optional --omit peer
    '';
    installPhase = ''
      mkdir -p "$out/node_modules" "$out/packages/pipeline" "$out/packages/capsule"
      cp -r node_modules/.bun "$out/node_modules/.bun"
      cp -r packages/pipeline/node_modules "$out/packages/pipeline/node_modules"
      cp -r packages/capsule/node_modules "$out/packages/capsule/node_modules"
      # Bun's executable-link race must not affect the fixed-output tree.
      find "$out" -type d -path '*/node_modules/.bin' -prune -exec rm -rf {} +
    '';
    outputHash = "sha256-IQCfJNQTQN7yMIYHlz1piEDP5Qcss0TBkFKuazueIWE=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
assert lib.versionAtLeast node.version "22.19.0";
pkgs.stdenvNoCC.mkDerivation {
  pname = "pipeline";
  version = "0.1.0";
  src = source;
  nativeBuildInputs = [
    pkgs.bun
    pkgs.makeWrapper
  ];
  dontConfigure = true;
  dontFixup = true;
  buildPhase = ''
    mkdir -p node_modules dist
    cp -r ${dependencies}/node_modules/.bun node_modules/.bun
    cp -r ${dependencies}/packages/pipeline/node_modules packages/pipeline/node_modules
    cp -r ${dependencies}/packages/capsule/node_modules packages/capsule/node_modules
    bun build packages/pipeline/cli.ts \
      --target=node --format=esm --packages=bundle \
      --metafile=dist/pipeline.meta.json --outfile=dist/pipeline.mjs
  '';
  doCheck = true;
  checkPhase = ''
    ${lib.getExe node} --input-type=module <<'EOF'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(":memory:");
    const statement = db.prepare("SELECT 42 AS answer");
    statement.setReturnArrays(true);
    assert.deepEqual(statement.get(), [42]);
    db.close();
    const inputs = Object.keys(JSON.parse(readFileSync("dist/pipeline.meta.json", "utf8")).inputs);
    for (const name of ["effect", "@effect/platform-node", "@effect/sql-sqlite-node", "@opencode/client", "@opencode/schema"]) {
      assert(inputs.some(path => path.includes(`/node_modules/''${name}/`)),
        `Standalone Pipeline must bundle ''${name}`);
    }
    // Pipeline speaks only Capsule's RPC contract; the native OpenCode host runs Capsule itself.
    const capsule = inputs.filter(path => path.startsWith("packages/capsule/"));
    const contract = ["host/contract.ts", "identity.ts", "schema.ts", "source/schema.ts"].map(file => `packages/capsule/src/''${file}`);
    assert(capsule.includes(contract[0]), "Pipeline must use the Capsule RPC contract");
    assert(capsule.every(path => contract.includes(path)), `Pipeline bundles Capsule internals: ''${capsule}`);
    for (const name of ["sdk", "plugin", "core", "server"]) {
      assert(!inputs.some(path => path.includes(`/node_modules/@opencode/''${name}/`)),
        `Pipeline must not bundle @opencode/''${name}`);
    }
    // One Effect instance keeps Capsule's schemas and errors shared with Pipeline.
    const effects = new Set(inputs.flatMap(path => path.match(/^.*\/node_modules\/effect\//) ?? []));
    assert.equal(effects.size, 1, `Pipeline bundles several Effect copies: ''${[...effects]}`);
    EOF
  '';
  installPhase = ''
    mkdir -p "$out/lib/pipeline" "$out/bin"
    cp dist/pipeline.mjs "$out/lib/pipeline/"
    makeWrapper ${lib.getExe node} "$out/bin/pipeline" \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/pipeline/pipeline.mjs"
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/pipeline" --help > help.txt
    grep -qE '^ +serve +' help.txt
    # Workspaces belong to the native OpenCode host; the retired helper protocol stays gone.
    for command in protocol workspace; do
      if "$out/bin/pipeline" "$command" > /dev/null 2>&1; then
        echo "pipeline $command must not exist" >&2
        exit 1
      fi
    done
    if "$out/bin/pipeline" serve --config "$TMPDIR/missing.json" > /dev/null 2>&1; then
      echo "pipeline serve must refuse a missing configuration" >&2
      exit 1
    fi
    runHook postInstallCheck
  '';
  passthru = { inherit dependencies node; };
  meta = {
    description = "Thin OpenCode task dispatcher for native Capsule sessions";
    mainProgram = "pipeline";
    platforms = lib.platforms.linux;
  };
}

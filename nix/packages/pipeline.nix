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
        ]
        || lib.hasPrefix "packages/pipeline/" relative
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
    buildPhase = ''
      export HOME="$TMPDIR"
      bun install --filter @limitless/pipeline --no-progress --frozen-lockfile --ignore-scripts --production --omit optional
    '';
    installPhase = ''
      mkdir -p "$out/node_modules" "$out/packages/pipeline"
      cp -r node_modules/.bun "$out/node_modules/.bun"
      cp -r packages/pipeline/node_modules "$out/packages/pipeline/node_modules"
      # Bun's executable-link race must not affect the fixed-output tree.
      find "$out" -type d -path '*/node_modules/.bin' -prune -exec rm -rf {} +
    '';
    outputHash = "sha256-GWIgjKX5RS789mkGd9Nxrr8hFtIXhyNDkBL6aGRPcck=";
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
    const { inputs } = JSON.parse(readFileSync("dist/pipeline.meta.json", "utf8"));
    for (const name of ["effect", "@effect/platform-node", "@effect/sql-sqlite-node", "@opencode/client"]) {
      assert(Object.keys(inputs).some(path => path.includes(`/node_modules/''${name}/`)),
        `Standalone Pipeline must bundle ''${name}`);
    }
    EOF
  '';
  installPhase = ''
    mkdir -p "$out/lib/pipeline" "$out/bin"
    cp dist/pipeline.mjs "$out/lib/pipeline/"
    makeWrapper ${lib.getExe node} "$out/bin/pipeline" \
      --prefix PATH : ${
        lib.makeBinPath [
          node
          pkgs.git
          pkgs.gnutar
          pkgs.util-linux
          pkgs.coreutils
        ]
      } \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/pipeline/pipeline.mjs"
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test "$("$out/bin/pipeline" protocol)" = '{"protocolVersion":2}'
    request=$(${lib.getExe node} --input-type=module -e 'process.stdout.write(Buffer.from(JSON.stringify({operation:"inspect",taskId:"a4ea0530-d3eb-4e0d-afc5-dda8e9e50b00"})).toString("base64url"))')
    "$out/bin/pipeline" workspace --root "$TMPDIR/workspaces" --request "$request" > status.json
    if "$out/bin/pipeline" workspace --root "$TMPDIR/workspaces" --request e30 > invalid.json; then
      echo "An invalid workspace request must fail" >&2
      exit 1
    fi
    ${lib.getExe node} --input-type=module <<'EOF'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const taskId = "a4ea0530-d3eb-4e0d-afc5-dda8e9e50b00";
    assert.deepEqual(JSON.parse(readFileSync("status.json", "utf8")), {
      _tag: "Absent", taskId, directory: join(process.env.TMPDIR, "workspaces", taskId, "checkout")
    });
    assert.equal(JSON.parse(readFileSync("invalid.json", "utf8")).code, "invalid_input");
    EOF
    runHook postInstallCheck
  '';
  passthru = { inherit dependencies node; };
  meta = {
    description = "Thin OpenCode task dispatcher and retained workspace helper";
    mainProgram = "pipeline";
    platforms = lib.platforms.linux;
  };
}

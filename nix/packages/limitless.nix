{ pkgs, self }:
let
  source = pkgs.lib.cleanSourceWith {
    src = self;
    filter =
      path: type:
      pkgs.lib.cleanSourceFilter path type
      && builtins.baseNameOf path != "node_modules"
      && builtins.baseNameOf path != ".limitless";
  };

  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    name = "limitless-bun-deps";
    src = source;

    nativeBuildInputs = [ pkgs.bun ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      export HOME=$TMPDIR
      bun install --cwd packages/limitless --no-progress --frozen-lockfile --ignore-scripts --production --omit optional
      bun ${./limitless-bun-links.mjs}
    '';

    installPhase = ''
      mkdir -p $out/node_modules $out/packages/limitless
      cp -r node_modules/.bun $out/node_modules/.bun
      cp -r packages/limitless/node_modules $out/packages/limitless/node_modules

      # Bun races when linking dependency executables; bundling uses no package bins.
      find "$out" -type d -path '*/node_modules/.bin' -prune -exec rm -rf {} +
    '';

    outputHash = "sha256-rf+TS0oph0QlBofSa+IUkQsu3qaz4IantxI+QrTsJ9E=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "limitless";
  version = "1.0.0";

  src = source;
  nativeBuildInputs = [ pkgs.bun ];

  dontConfigure = true;
  dontFixup = true;

  buildPhase = ''
    mkdir -p node_modules packages/limitless dist
    cp -r ${bunDeps}/node_modules/.bun node_modules/.bun
    cp -r ${bunDeps}/packages/limitless/node_modules packages/limitless/node_modules

    # Hosted plugins must reuse OpenCode's Effect/plugin instances to preserve host-owned state.
    buildHostedPlugin() {
      bun build "$1" \
        --target=node \
        --format=esm \
        --packages=bundle \
        --external effect --external 'effect/*' \
        --external @opencode/plugin --external '@opencode/plugin/*' \
        --metafile="dist/$2.meta.json" \
        --outfile="dist/$2.js"
    }
    buildHostedPlugin packages/limitless/index.ts limitless
    buildHostedPlugin packages/limitless/tui.ts tui
    # The T3 bridge runs outside OpenCode, so it must carry its own dependencies.
    # It runs under Bun, which provides undici; the bridge uses Node's HTTP client
    # and never calls platform-node's undici client.
    bun build packages/limitless/t3/cli.ts \
      --target=node \
      --format=esm \
      --packages=bundle \
      --external undici \
      --outfile=dist/t3.js
  '';

  doCheck = true;
  checkPhase = ''
    bun -e '
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      for (const name of ["limitless", "tui"]) {
        const { inputs } = JSON.parse(fs.readFileSync(`dist/''${name}.meta.json`, "utf8"));
        const bundled = Object.keys(inputs);
        assert(bundled.length > 0, `Missing build inputs for ''${name}`);
        for (const path of bundled) {
          assert(!/(^|\/)node_modules\/(effect|@opencode\/plugin)\//.test(path),
            `Hosted plugin ''${name} bundles host runtime: ''${path}`);
        }
      }
    '
  '';

  installPhase = ''
    mkdir -p "$out"
    substitute "dist/limitless.js" "$out/limitless.js" \
      --replace-fail "@GIT_BIN@" "${pkgs.git}/bin/git"
    cp "$out/limitless.js" "$out/index.js"
    cp "dist/tui.js" "$out/tui.js"
    cp "dist/t3.js" "$out/t3.js"
    cp -r packages/limitless/t3/prompts "$out/prompts"
    # OpenCode's TUI compiles discovered Solid sources and links them to its own runtime.
    mkdir -p "$out/cache-status"
    cp packages/limitless/cache-status/tui.tsx packages/limitless/cache-status/status.ts "$out/cache-status/"
    cat > "$out/package.json" <<'EOF'
    {
      "name": "limitless",
      "version": "1.0.0",
      "type": "module",
      "exports": {
        ".": "./limitless.js",
        "./tui": "./tui.js"
      }
    }
    EOF
  '';

  passthru.dependencies = bunDeps;

  meta = with pkgs.lib; {
    description = "Effect-native OpenCode 2 plugin for artifacts, source research, and client policies";
    platforms = platforms.all;
  };
}

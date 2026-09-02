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
      cp -r patches packages/limitless/patches
      bun install --cwd packages/limitless --no-progress --frozen-lockfile --ignore-scripts --production --omit optional
    '';

    installPhase = ''
      mkdir -p $out/node_modules $out/packages/limitless
      cp -r node_modules/.bun $out/node_modules/.bun
      cp -r packages/limitless/node_modules $out/packages/limitless/node_modules
    '';

    outputHash = "sha256-uspJVlnjQB5kN+th4Ia/gPETnQ4gPYGF3rEIPSR/SxM=";
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

    bun build packages/limitless/index.ts \
      --target=node \
      --format=esm \
      --packages=bundle \
      --outfile=dist/limitless.js

    bun build packages/limitless/integrations/slack/image-worker.ts \
      --target=node \
      --format=esm \
      --packages=bundle \
      --outfile=dist/slack-image-worker.mjs
  '';

  installPhase = ''
    mkdir -p "$out"
    substitute "dist/limitless.js" "$out/limitless.js" \
      --replace-fail "@AST_GREP_BIN@" "${pkgs.ast-grep}/bin/ast-grep" \
      --replace-fail "@GIT_BIN@" "${pkgs.git}/bin/git" \
      --replace-fail "@TYPST_BIN@" "${pkgs.typst}/bin/typst"
    cp "$out/limitless.js" "$out/index.js"

    cp ${bunDeps}/packages/limitless/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$out/"
    cp dist/slack-image-worker.mjs "$out/"
    cp -r templates "$out/templates"
    cp -r frameworks "$out/frameworks"
    cat > "$out/package.json" <<'EOF'
    {
      "name": "limitless",
      "version": "1.0.0",
      "type": "module",
      "exports": "./limitless.js"
    }
    EOF
  '';

  meta = with pkgs.lib; {
    description = "Effect-native OpenCode 2 plugin that adds local code-intelligence tools and integrations";
    platforms = platforms.all;
  };
}

{ pkgs, self }:
let
  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    name = "limitless-bun-deps";
    src = self;

    nativeBuildInputs = [ pkgs.bun ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      export HOME=$TMPDIR
      bun install --cwd packages/limitless --no-progress --frozen-lockfile --ignore-scripts --production --omit optional
    '';

    installPhase = ''
      mkdir -p $out/node_modules $out/packages/limitless
      cp -r node_modules/.bun $out/node_modules/.bun
      cp -r packages/limitless/node_modules $out/packages/limitless/node_modules
    '';

    outputHash = "sha256-l8cvLStiMGS8f3LZR/yqe23bf9qJEgLf/OYumcMFW+w=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "limitless";
  version = "1.0.0";

  src = self;
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
  '';

  installPhase = ''
    mkdir -p "$out"
    substitute "dist/limitless.js" "$out/limitless.js" \
      --replace-fail "@AST_GREP_BIN@" "${pkgs.ast-grep}/bin/ast-grep" \
      --replace-fail "@TYPST_BIN@" "${pkgs.typst}/bin/typst"
  '';

  meta = with pkgs.lib; {
    description = "OpenCode plugin that adds local code-intelligence tools";
    platforms = platforms.all;
  };
}

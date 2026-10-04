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
      bun ${./limitless-bun-links.mjs}
    '';

    installPhase = ''
      mkdir -p $out/node_modules $out/packages/limitless
      cp -r node_modules/.bun $out/node_modules/.bun
      cp -r packages/limitless/node_modules $out/packages/limitless/node_modules

      # Patch-cache markers vary across Bun versions and are unused by bun build.
      find "$out/node_modules/.bun" -type f -name '.bun-tag-*' -empty -delete
    '';

    outputHash = "sha256-8CR4pRd023CjZ6+aiF4QCCubf2tEckkywyCTaXLwZjg=";
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
    bun build packages/limitless/tui.ts \
      --target=node \
      --format=esm \
      --packages=bundle \
      --outfile=dist/tui.js
  '';

  installPhase = ''
    mkdir -p "$out"
    substitute "dist/limitless.js" "$out/limitless.js" \
      --replace-fail "@AST_GREP_BIN@" "${pkgs.ast-grep}/bin/ast-grep" \
      --replace-fail "@GIT_BIN@" "${pkgs.git}/bin/git"
    cp "$out/limitless.js" "$out/index.js"
    cp "dist/tui.js" "$out/tui.js"
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
    description = "Effect-native OpenCode 2 plugin for code intelligence, artifacts, and source research";
    platforms = platforms.all;
  };
}

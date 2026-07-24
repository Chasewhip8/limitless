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
    name = "anthropic-auth-bun-deps";
    src = source;

    nativeBuildInputs = [ pkgs.bun ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      export HOME=$TMPDIR
      bun install --cwd packages/anthropic-auth --no-progress --frozen-lockfile --ignore-scripts --production --omit optional
    '';

    installPhase = ''
      mkdir -p $out/node_modules $out/packages/anthropic-auth
      cp -r node_modules/.bun $out/node_modules/.bun
      cp -r packages/anthropic-auth/node_modules $out/packages/anthropic-auth/node_modules
    '';

    outputHash = "sha256-mzwhl/7Pv2I9NIi+BM/cdFgbsV3ZNluLN0+OEId8FaA=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "anthropic-auth";
  version = "0.1.0";

  src = source;
  nativeBuildInputs = [ pkgs.bun ];

  dontConfigure = true;
  dontFixup = true;

  buildPhase = ''
    mkdir -p node_modules packages/anthropic-auth dist
    cp -r ${bunDeps}/node_modules/.bun node_modules/.bun
    cp -r ${bunDeps}/packages/anthropic-auth/node_modules packages/anthropic-auth/node_modules

    bun build packages/anthropic-auth/index.ts \
      --target=node \
      --format=esm \
      --packages=bundle \
      --outfile=dist/anthropic-auth.js
  '';

  doCheck = true;
  checkPhase = ''
    bun -e '
      const module = await import("./dist/anthropic-auth.js")
      if (module.default?.id !== "limitless.anthropic-auth") throw new Error("missing V2 plugin export")
      if (typeof module.default?.effect !== "function") throw new Error("missing Effect plugin implementation")
      if (typeof module.model !== "function") throw new Error("missing native provider export")
    '
  '';

  installPhase = ''
    mkdir -p "$out"
    cp dist/anthropic-auth.js "$out/anthropic-auth.js"
    cp packages/anthropic-auth/LICENSE "$out/LICENSE"
  '';

  meta = with pkgs.lib; {
    description = "OpenCode 2 Anthropic OAuth plugin and native provider adapter";
    homepage = "https://github.com/ex-machina-co/opencode-anthropic-auth";
    license = licenses.mit;
    platforms = platforms.all;
  };
}

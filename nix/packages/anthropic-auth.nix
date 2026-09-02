{ pkgs }:
let
  rev = "f043583c24085c60fc7f95059f2d6f36f44f4a8e";
  packageVersion = "2.0.0-pr211-${builtins.substring 0 7 rev}";
  upstreamPluginSdkVersion = "0.0.0-next-17444";
  src = pkgs.fetchFromGitHub {
    owner = "CasualDeveloper";
    repo = "opencode-anthropic-auth";
    inherit rev;
    hash = "sha256-v24QlWKuZJ0BXr86B+qxJ/tjesG3l5hocOKcCC+8c1A=";
  };

  bunDeps = pkgs.stdenvNoCC.mkDerivation {
    name = "opencode-anthropic-auth-bun-deps-${builtins.substring 0 7 rev}";
    inherit src;

    nativeBuildInputs = [ pkgs.bun ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      export HOME=$TMPDIR
      bun install --no-progress --frozen-lockfile --ignore-scripts --production --omit optional
    '';

    installPhase = ''
      mkdir -p $out
      cp -r node_modules $out/node_modules
    '';

    outputHash = "sha256-aAJHeQd0E/c1BaRY1zxBsR0lwwdyVlwTMIY7BjWMJto=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "opencode-anthropic-auth";
  version = packageVersion;
  inherit src;

  nativeBuildInputs = [ pkgs.bun ];

  dontConfigure = true;
  dontFixup = true;

  buildPhase = ''
    cp -r ${bunDeps}/node_modules node_modules
    mkdir -p dist
    bun build src/index.ts \
      --target=node \
      --format=esm \
      --packages=bundle \
      --outfile=dist/anthropic-auth.js
  '';

  doCheck = true;
  checkPhase = ''
    bun -e '
      const module = await import("./dist/anthropic-auth.js")
      if (module.default?.id !== "ex-machina.anthropic-auth") {
        throw new Error("missing upstream OpenCode 2 plugin export")
      }
      if (typeof module.default?.setup !== "function") {
        throw new Error("missing upstream Promise plugin implementation")
      }
    '
  '';

  installPhase = ''
    mkdir -p $out
    cp dist/anthropic-auth.js $out/anthropic-auth.js
    cp dist/anthropic-auth.js $out/index.js
    cp LICENSE $out/LICENSE
    cat > $out/package.json <<'EOF'
    {
      "name": "opencode-anthropic-auth",
      "version": "${packageVersion}",
      "type": "module",
      "exports": "./anthropic-auth.js"
    }
    EOF
  '';

  passthru = {
    inherit rev upstreamPluginSdkVersion;
  };

  meta = with pkgs.lib; {
    description = "OpenCode 2 Anthropic OAuth plugin from upstream pull request 211";
    homepage = "https://github.com/ex-machina-co/opencode-anthropic-auth/pull/211";
    license = licenses.mit;
    platforms = platforms.all;
  };
}

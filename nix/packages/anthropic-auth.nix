{ pkgs }:
let
  rev = "c6921e486e9d180b1c2ace318211f7156a5f09b0";
  packageVersion = "2.0.0-next.1-${builtins.substring 0 7 rev}";
  upstreamPluginSdkVersion = "2.0.4";
  src = pkgs.fetchFromGitHub {
    owner = "ex-machina-co";
    repo = "opencode-anthropic-auth";
    inherit rev;
    hash = "sha256-Ym7kbbET2yhGFKM8Ohp1jfTSrXkJBl7CK+Dlzml4Oto=";
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

    outputHash = "sha256-f7/r26LtMwT0K+68q4shpJMLpxS12D+G5eb7icFOcMU=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "opencode-anthropic-auth";
  version = packageVersion;
  inherit src;

  # OpenCode disables WebSockets for every provider matched by an HTTP hook.
  patches = [ ../../patches/opencode-anthropic-auth-provider-hooks.patch ];

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
    cp ${./anthropic-auth.test.mjs} ./anthropic-auth.test.mjs
    bun test ./anthropic-auth.test.mjs ./src/tests/index.test.ts
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
    description = "OpenCode 2 Anthropic OAuth plugin";
    homepage = "https://github.com/ex-machina-co/opencode-anthropic-auth";
    license = licenses.mit;
    platforms = platforms.all;
  };
}

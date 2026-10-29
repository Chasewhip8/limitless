{ pkgs, paseo }:
# Upstream's recorded npmDepsHash does not match what
# fetchNpmDeps produces for its lockfile, with upstream's own nixpkgs or ours.
# When bumping Paseo, set lib.fakeHash, build, and record the reported hash.
paseo.packages.${pkgs.stdenv.hostPlatform.system}.paseo.override {
  npmDepsHash = "sha256-DZOPOf81PkUxdD65BrfkTZhs6/DkfDWCFZ/SU+QrZbg=";
}

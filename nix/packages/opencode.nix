{ opencode, system }:
let
  # v1.17.19 was tagged before upstream's hash-refresh commit c9976d69c0 landed.
  nodeModulesHashes = {
    x86_64-linux = "sha256-pk5JjO3RHjdOX1T9qX4UWOv7dST/i3DmHGhxTb5QJDA=";
    aarch64-linux = "sha256-g5XAu5mzLYathkgXlRC5YLVOFTTILUxNrYgLwc/XYPM=";
    aarch64-darwin = "sha256-Xurqq3CNzUlCJCDVlFMENsZPRaP6ETCFGEDkLErd79I=";
    x86_64-darwin = "sha256-jxS1tzOLfpWL6nNOkOk5SE/E/EyMZe9e7ACM/cgB+5A=";
  };
  packages = opencode.packages.${system};
in
packages.opencode.override {
  node_modules = packages.node_modules_updater.override {
    hash = nodeModulesHashes.${system};
  };
}

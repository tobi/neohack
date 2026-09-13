{
  description = "Pinned neohack native, WASM and browser build environment";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lua = pkgs.lua5_4.override {
        version = "5.4.9";
        hash = "2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6";
      };
      emscripten = assert pkgs.emscripten.version == "6.0.9"; pkgs.emscripten;
      bun = pkgs.bun.overrideAttrs {
        version = "1.3.14";
        src = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip";
          hash = "sha256-oGOQiuCLeFLKEJObvcbO7T3avOj7lALc6D1l1zs25sc=";
        };
      };
      shell = node: pkgs.mkShell {
        packages = with pkgs; [
          node lua emscripten cmake ninja pkg-config ncurses libuuid
          clang gnumake git curl gnutar gzip unzip util-linux uv
        ] ++ [ bun ];
        LUA_HOME = "${lua}";
        NNH_LUA_ARCHIVE = "${lua.src}";
        EMSCRIPTEN_ROOT = "${emscripten}/share/emscripten";
        # A development shell has no installed output. Do not embed its
        # synthetic $PWD/outputs/out/lib in shipped native executables.
        NIX_NO_SELF_RPATH = 1;
        # Chromium must retain its sandbox. Hosts may override this to use an
        # installed browser with the required user-namespace/setuid support.
        shellHook = ''
          export CHROMIUM="''${CHROMIUM:-${pkgs.chromium}/bin/chromium}"
          neohack_root="$PWD"
          while [ ! -f "$neohack_root/flake.nix" ] && [ "$neohack_root" != / ]; do
            neohack_root="$(dirname "$neohack_root")"
          done
          export EM_CACHE="$neohack_root/lib/neonethack/build/emscripten-cache"
          unset neohack_root
        '';
      };
    in {
      devShells.${system} = {
        default = shell pkgs.nodejs_24;
        node24 = shell pkgs.nodejs_24;
        node22 = shell pkgs.nodejs_22;
      };
    };
}

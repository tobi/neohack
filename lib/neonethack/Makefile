# Enter the project's locked shell once for the entire invocation. A dedicated
# marker avoids mistaking an unrelated Nix shell for this build environment.
.DEFAULT_GOAL := all
ifneq ($(NNH_NIX_SHELL),1)
.PHONY: all configure native engine wasm test test-wasm install mcp generate check-generated clean __nix
all configure native engine wasm test test-wasm install mcp generate check-generated clean: __nix
__nix:
	@command -v nix >/dev/null || { echo 'Install Nix with flakes enabled to build neohack.' >&2; exit 1; }
	+nix develop "$(abspath ../..)" --command $(MAKE) $(MAKECMDGOALS)
else
# The same CMake graph supports both Make and Ninja. No JavaScript runtime is
# needed to build/link the native C library from committed generated sources.
BUILD ?= build/native
# GNU Make 4.3 can select Emscripten's cmake/ directory from PATH as an
# executable. Shell lookup skips directories; keep explicit CMAKE overrides.
CMAKE ?= $(shell command -v cmake)
GENERATOR ?= Ninja
PREFIX ?= /usr/local
LIBDIR ?= lib
MCP_PREFIX ?= $(abspath ../..)
WASM_BUILD ?= build/wasm
.PHONY: all configure native engine wasm test test-wasm install mcp generate check-generated clean
all: native
configure:
	$(CMAKE) -S . -B $(BUILD) -G "$(GENERATOR)" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$(PREFIX) -DCMAKE_INSTALL_LIBDIR=$(LIBDIR) -DCMAKE_C_COMPILER="$(shell command -v $(CC))" -DLUA_HOME="$(LUA_HOME)"
native: configure
	$(CMAKE) --build $(BUILD) --target native
engine:
	sh scripts/build-engine.sh
wasm:
	sh scripts/build-wasm.sh $(WASM_BUILD) "$(GENERATOR)"
test-wasm: wasm
	npm run test:wasm
	npm run test:browser
test: native
	$(CMAKE) --build $(BUILD)
	ctest --test-dir $(BUILD) --output-on-failure
install: native
	$(CMAKE) --install $(BUILD)
mcp: wasm
	npm run build
	node scripts/install-mcp.mjs "$(MCP_PREFIX)"
generate:
	node scripts/generate.ts
check-generated:
	node scripts/generate.ts --check
clean:
	$(CMAKE) --build $(BUILD) --target clean
endif

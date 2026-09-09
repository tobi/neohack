# The same CMake graph supports both Make and Ninja. No JavaScript runtime is
# needed to build/link the native C library from committed generated sources.
BUILD ?= build/native
# GNU Make 4.3 can select Emscripten's cmake/ directory from PATH as an
# executable. Shell lookup skips directories; keep explicit CMAKE overrides.
CMAKE ?= $(shell command -v cmake)
GENERATOR ?= Ninja
PREFIX ?= /usr/local
MCP_PREFIX ?= $(HOME)/.local
WASM_BUILD ?= build/wasm
.PHONY: all configure native bundle engine wasm test test-wasm install mcp generate check-generated clean
all: native
configure:
	$(CMAKE) -S . -B $(BUILD) -G "$(GENERATOR)" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$(PREFIX)
native: configure
	$(CMAKE) --build $(BUILD) --target native
bundle:
	sh scripts/build-bundle.sh
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
mcp: native
	$(CMAKE) --install $(BUILD) --prefix "$(MCP_PREFIX)"
	ln -sfn neonethack-mcp "$(MCP_PREFIX)/bin/neohack-mcp"
	@printf 'Installed C MCP server: %s/bin/neohack-mcp\n' "$(MCP_PREFIX)"
generate:
	node scripts/generate.ts
check-generated:
	node scripts/generate.ts --check
clean:
	$(CMAKE) --build $(BUILD) --target clean

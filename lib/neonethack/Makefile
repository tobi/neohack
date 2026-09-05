# The same CMake graph supports both Make and Ninja. No JavaScript runtime is
# needed to build/link the native C library from committed generated sources.
BUILD ?= build/native
CMAKE ?= cmake
GENERATOR ?= Ninja
PREFIX ?= /usr/local
WASM_BUILD ?= build/wasm
.PHONY: all configure native engine wasm test test-wasm install generate check-generated clean
all: native
configure:
	$(CMAKE) -S . -B $(BUILD) -G "$(GENERATOR)" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$(PREFIX)
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
generate:
	node scripts/generate.ts
check-generated:
	node scripts/generate.ts --check
clean:
	$(CMAKE) --build $(BUILD) --target clean

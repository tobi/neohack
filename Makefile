# The root is only a convenience entry point; lib/neonethack owns the build.
.PHONY: all native wasm test test-wasm install
all: native
native wasm test test-wasm install:
	$(MAKE) -C lib/neonethack $@

# The root is only a convenience entry point; lib/neonethack owns the build.
.PHONY: all native wasm test test-wasm install mcp
all: native
native wasm test test-wasm install mcp:
	$(MAKE) -C lib/neonethack $@

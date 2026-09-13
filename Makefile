# The root is only a convenience entry point; lib/neonethack owns the build.
.DEFAULT_GOAL := all
.PHONY: all native wasm test test-wasm install mcp __library
all native wasm test test-wasm install mcp: __library
__library:
	+$(MAKE) -C lib/neonethack $(MAKECMDGOALS)

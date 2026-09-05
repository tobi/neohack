/* WASM uses the downloaded target Lua headers, never a host SDK include. */
#include <lua.h>
ATTRNORETURN LUA_API int (lua_error)(lua_State *L) NORETURN;
#include <lualib.h>
#include <lauxlib.h>

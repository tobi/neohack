# Included by the top-level project when configured with emcmake.
include(FetchContent)
set(NNH_LUA_URL https://www.lua.org/ftp/lua-5.4.9.tar.gz)
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/lua-5.4.9.tar.gz")
  set(NNH_LUA_URL "${CMAKE_CURRENT_SOURCE_DIR}/third_party/lua-5.4.9.tar.gz")
endif()
FetchContent_Declare(lua URL "${NNH_LUA_URL}"
  URL_HASH SHA256=2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(lua)
find_program(NNH_NODE node REQUIRED)
set(ARTIFACTS "${CMAKE_BINARY_DIR}/artifacts")
file(MAKE_DIRECTORY "${ARTIFACTS}")
set(CORE_SOURCES src/api.c src/schema.c src/explorer.c src/minjson.c wasm/session.c wasm/core.c wasm/platform.c)
add_executable(neonethack-core ${CORE_SOURCES})
target_include_directories(neonethack-core PRIVATE include src)
target_compile_definitions(neonethack-core PRIVATE fsync=nnh_wasm_fsync flock=nnh_wasm_flock)
target_compile_options(neonethack-core PRIVATE -Wall -Wextra)
target_link_options(neonethack-core PRIVATE --no-entry -lidbfs.js
  "-sEXPORTED_FUNCTIONS=['_nnh_wasm_open','_nnh_wasm_request','_nnh_wasm_close','_malloc','_free']"
  "-sEXPORTED_RUNTIME_METHODS=['ccall','FS','IDBFS']")

file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/wasm/engine-sources.txt" ENGINE_SOURCES)
list(TRANSFORM ENGINE_SOURCES PREPEND "engine/")
file(GLOB LUA_SOURCES CONFIGURE_DEPENDS "${lua_SOURCE_DIR}/src/*.c")
list(FILTER LUA_SOURCES EXCLUDE REGEX "/(lua|luac)\\.c$")
add_executable(neonethack-engine ${ENGINE_SOURCES} ${LUA_SOURCES} wasm/engine-input.c)
# Snapshot generated engine headers, replacing only the host-specific Lua
# include. Never compile WASM against absolute headers from a native Lua SDK.
file(GLOB ENGINE_HEADERS CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/engine/include/*.h")
foreach(header ${ENGINE_HEADERS})
  get_filename_component(name "${header}" NAME)
  if(NOT name STREQUAL "nhlua.h")
    configure_file("${header}" "${CMAKE_BINARY_DIR}/include/${name}" COPYONLY)
  endif()
endforeach()
configure_file(wasm/nhlua.h "${CMAKE_BINARY_DIR}/include/nhlua.h" COPYONLY)
target_include_directories(neonethack-engine PRIVATE "${CMAKE_BINARY_DIR}/include" "${lua_SOURCE_DIR}/src")
target_compile_definitions(neonethack-engine PRIVATE NOTTYGRAPHICS HEADLESS_GRAPHICS
  DLB HACKDIR="/nh" DEFAULT_WINDOW_SYS="headless" SYSCF SYSCF_FILE="/nh/sysconf"
  SECURE DUMPLOG CONFIG_ERROR_SECURE=FALSE COMPRESS="/bin/gzip" COMPRESS_EXTENSION=".gz"
  SELF_RECOVER NOSTATICFN)
set(STAGE "${CMAKE_BINARY_DIR}/stage")
set(DATA_INPUTS engine/playground/nhdat engine/playground/sysconf engine/playground/symbols engine/dat/license)
add_custom_command(OUTPUT "${STAGE}/ready"
  COMMAND "${NNH_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/stage-engine-data.mjs" "${STAGE}"
  DEPENDS ${DATA_INPUTS} scripts/stage-engine-data.mjs VERBATIM)
add_custom_target(wasm-data DEPENDS "${STAGE}/ready")
add_dependencies(neonethack-engine wasm-data)
set_property(TARGET neonethack-engine APPEND PROPERTY LINK_DEPENDS "${STAGE}/ready")
target_link_options(neonethack-engine PRIVATE "--preload-file=${STAGE}/nh@/nh"
  -sEXIT_RUNTIME=1 "-sEXPORTED_RUNTIME_METHODS=['FS','ENV']")
foreach(target neonethack-core neonethack-engine)
  target_compile_options(${target} PRIVATE
    "-ffile-prefix-map=${CMAKE_CURRENT_SOURCE_DIR}=."
    "-ffile-prefix-map=${CMAKE_BINARY_DIR}=build"
    "-ffile-prefix-map=${lua_SOURCE_DIR}=lua")
  set_target_properties(${target} PROPERTIES SUFFIX ".mjs" RUNTIME_OUTPUT_DIRECTORY "${ARTIFACTS}")
  target_link_options(${target} PRIVATE -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=262144
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB
    -sENVIRONMENT=web,worker,node -sMODULARIZE=1 -sEXPORT_ES6=1 -sFORCE_FILESYSTEM=1)
endforeach()
add_custom_target(wasm
  COMMAND "${NNH_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/stage-wasm.mjs" "${ARTIFACTS}" "${lua_SOURCE_DIR}" "${EMSCRIPTEN_ROOT_PATH}"
  DEPENDS neonethack-core neonethack-engine USES_TERMINAL VERBATIM)

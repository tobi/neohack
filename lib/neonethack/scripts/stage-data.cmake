# Static release data only: never package playground saves, locks or logs.
file(MAKE_DIRECTORY "${OUT}")
foreach(name nhdat symbols)
  configure_file("${ROOT}/engine/dat/${name}" "${OUT}/${name}" COPYONLY)
endforeach()
configure_file("${ROOT}/engine/dat/license" "${OUT}/license" COPYONLY)
file(READ "${ROOT}/engine/sys/unix/sysconf" config)
# A headless library must not require host debugger/compressor paths to exist.
string(REGEX REPLACE "(^|\n)(GREPPATH|COMPRESS|GDBPATH)=[^\n]*" "\\1" config "${config}")
string(REPLACE "PANICTRACE_GDB=1" "PANICTRACE_GDB=0" config "${config}")
file(WRITE "${OUT}/sysconf" "${config}")

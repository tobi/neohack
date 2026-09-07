/* Test-only interposer: stop after the driver committed its receipt, immediately
 * before the worker publishes its full response to the supervisor. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int puts(const char *text)
{
    int (*original)(const char *) = dlsym(RTLD_NEXT,"puts");
    const char *armed = getenv("NNH_TEST_STOP_REPLY");
    if (armed && strstr(text,"\"outcome\"") && !unlink(armed)) raise(SIGSTOP);
    return original(text);
}

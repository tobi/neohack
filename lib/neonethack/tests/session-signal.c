#define _POSIX_C_SOURCE 200809L
#include "session.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
    nh_session_t *session;
    struct sigaction action;
    sigset_t blocked, previous, pending;
    char *line;
    int signal_number;
    assert(argc == 2);
    signal(SIGPIPE, SIG_DFL);
    session = nh_session_start(argv[1], "/tmp", NULL);
    assert(session);
    line = nh_session_read_line(session, 2000);
    assert(line && !strcmp(line, "ready")); free(line);
    assert(nh_session_write(session, "must not terminate the host") == -1 && errno == EPIPE);
    assert(sigaction(SIGPIPE, NULL, &action) == 0 && action.sa_handler == SIG_DFL);
    sigemptyset(&blocked); sigaddset(&blocked, SIGPIPE);
    assert(pthread_sigmask(SIG_BLOCK, &blocked, &previous) == 0);
    assert(raise(SIGPIPE) == 0);
    assert(nh_session_write(session, "preserve a pre-existing pending signal") == -1 && errno == EPIPE);
    assert(sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE));
    assert(sigwait(&blocked, &signal_number) == 0 && signal_number == SIGPIPE);
    assert(pthread_sigmask(SIG_SETMASK, &previous, NULL) == 0);
    nh_session_abort(session);
    return 0;
}

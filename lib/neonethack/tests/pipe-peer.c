/* Test-only child: close the read end before acknowledging readiness. */
#include <stdio.h>
#include <unistd.h>
int main(void) {
    close(STDIN_FILENO);
    puts("ready"); fflush(stdout);
    for (;;) pause();
}

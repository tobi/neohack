#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
    char cwd[4096], input[32];
    if ((argc != 2 && argc != 3) || !getcwd(cwd, sizeof cwd)) return 2;
    printf("%s\n%s\n%s\n%s\n", cwd, getenv("NETHACKDIR"), getenv("NETHACKOPTIONS"), argv[argc - 1]);
    if (argc == 3) printf("%s\n", getenv("NNH_FORBIDDEN") ? "inherited" : "isolated");
    fflush(stdout);
    if (!fgets(input, sizeof input, stdin)) return 3;
    printf("%s", input); fflush(stdout);
    return 0;
}

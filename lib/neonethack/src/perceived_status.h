#ifndef NNH_PERCEIVED_STATUS_H
#define NNH_PERCEIVED_STATUS_H
#include <ctype.h>
#include <string.h>

/* Only normalize status text the engine already displayed. Empty status is
 * its normal state; unavailable or unfamiliar text is explicitly unknown. */
static const char *nnh_perceived_status(const char *label, int hunger)
{
    static const char *const hungry[] = {
        "satiated", "not_hungry", "hungry", "weak", "fainting", "fainted", "starved", NULL
    };
    static const char *const burden[] = {
        "unencumbered", "burdened", "stressed", "strained", "overtaxed", "overloaded", NULL
    };
    const char *const *states = hunger ? hungry : burden;
    char value[64]; size_t length, i;
    if (!label) return "unknown";
    while (isspace((unsigned char) *label)) label++;
    length = strlen(label);
    while (length && isspace((unsigned char) label[length - 1])) length--;
    if (!length) return hunger ? "not_hungry" : "unencumbered";
    if (length >= sizeof value) return "unknown";
    for (i = 0; i < length; i++) value[i] = (char) tolower((unsigned char) label[i]);
    value[length] = '\0';
    if (hunger && !strcmp(value, "not hungry")) return "not_hungry";
    for (i = 0; states[i]; i++) if (!strcmp(value, states[i])) return states[i];
    return "unknown";
}
#endif

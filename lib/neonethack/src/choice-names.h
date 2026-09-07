#ifndef NNH_CHOICE_NAMES_H
#define NNH_CHOICE_NAMES_H
#include <stddef.h>
#include <string.h>
/* Readable aliases derived only from a displayed label. Deliberately not
 * identities: equal/colliding labels keep equal names and require clarification.
 * Locale-independent ASCII folding; preserve complete non-ASCII UTF-8 sequences. */
static void nnh_choice_name(const char *label, char *out, size_t capacity)
{
    size_t used = 0; int separator = 0;
    const unsigned char *p = (const unsigned char *)(label ? label : "");
    if (!capacity) return;
    while (*p) {
        unsigned char c = *p;
        size_t count = 1;
        int word = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c >= 128;
        if (!word) { separator = used != 0; p++; continue; }
        if (c >= 128) {
            if (c < 0xc2 || c > 0xf4) { p++; separator = used != 0; continue; }
            count = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
            size_t i; for (i = 1; i < count; i++) if (!p[i] || (p[i] & 0xc0) != 0x80) break;
            if (i != count) { p++; separator = used != 0; continue; }
        }
        if (used + (separator ? 1 : 0) + count >= capacity) break;
        if (separator) out[used++] = '-';
        separator = 0;
        if (count == 1 && c >= 'A' && c <= 'Z') out[used++] = (char)(c + ('a'-'A'));
        else { memcpy(out+used,p,count); used += count; }
        p += count;
    }
    if (!used && capacity >= sizeof "option") { memcpy(out,"option",sizeof "option"); return; }
    out[used] = '\0';
}
#endif

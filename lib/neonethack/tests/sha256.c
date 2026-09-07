#include "../engine/include/nh_sha256.h"
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv){
    nh_sha256 state;unsigned char bytes[79];size_t n;char hex[65];nh_sha_init(&state);
    if(argc==2){
        size_t size=(size_t)strtoul(argv[1],NULL,10),offset=0;
        if(size>1000000)return 2;
        while(offset<size){size_t i;n=size-offset;if(n>sizeof bytes)n=sizeof bytes;for(i=0;i<n;i++)bytes[i]=(unsigned char)(((offset+i)*71+19)%256);nh_sha_update(&state,bytes,n);offset+=n;}
    }else{while((n=fread(bytes,1,sizeof bytes,stdin)))nh_sha_update(&state,bytes,n);if(ferror(stdin))return 1;}
    nh_sha_final(&state,hex);puts(hex);return 0;
}

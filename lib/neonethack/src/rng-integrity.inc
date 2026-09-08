/* Private, durable engine-boundary evidence. Never copied into public frames.
 * Record before answering input. Replay compares rather than rewriting it. */
static int rng_fail(game_t *g,const char *message)
{
    snprintf(g->rng_error,sizeof g->rng_error,"%s",message);
    g->recovery_required=1;return -1;
}
static int rng_decimal(mj_val value)
{
    char *s=mj_str(value),*end; unsigned long long n; int ok=0;
    if(!s)return 0;
    if(*s && strspn(s,"0123456789")==strlen(s) && (s[0]!='0'||!s[1])){
        errno=0;n=strtoull(s,&end,10);(void)n;ok=!errno&&!*end;
    }
    free(s);return ok;
}
static int rng_shape(mj_val value)
{
    static const char *const keys[]={"algorithm","core","display",NULL};
    static const char *const fields[]={"draws","seeds","state",NULL};
    const char *streams[]={"core","display"};mj_val v,stream;int i;
    if(!value.p||!request_fields(value.p,keys)||!mj_find(value.p,"algorithm",&v)||!record_is(v,"isaac64-sha256-v1"))return 0;
    for(i=0;i<2;i++){
        char *hash;int valid;
        if(!mj_find(value.p,streams[i],&stream)||!request_fields(stream.p,fields)||
           !mj_find(stream.p,"draws",&v)||!rng_decimal(v)||!mj_find(stream.p,"seeds",&v)||!rng_decimal(v)||
           !mj_find(stream.p,"state",&v)||!(hash=mj_str(v)))return 0;
        valid=strlen(hash)==64&&strspn(hash,"0123456789abcdef")==64;free(hash);if(!valid)return 0;
    }
    return 1;
}
static int rng_replay_open(game_t *g)
{
    char path[PATH_MAX];int fd;
    if(!g->rng_version)return 0;
    g->rng_error[0]=0;
    snprintf(path,sizeof path,"%s/rng.jsonl",g->dir);
    fd=record_regular(path,O_RDONLY);
    if(fd<0)return rng_fail(g,"private RNG boundary records are missing or inaccessible");
    if(fstat(fd,&g->rng_stat)||g->rng_stat.st_size>INPUT_MAX_BYTES){close(fd);return rng_fail(g,"invalid private RNG record size");}
    g->rng_reader=fdopen(fd,"r");if(!g->rng_reader){close(fd);return rng_fail(g,"cannot read private RNG records");}
    g->rng_have_stat=1;return 0;
}
static int rng_replay_close(game_t *g,int complete)
{
    int extra=0;
    if(g->rng_reader){
        if(complete)extra=fgetc(g->rng_reader)!=EOF||ferror(g->rng_reader);
        fclose(g->rng_reader);g->rng_reader=NULL;
    }
    return extra?rng_fail(g,"private RNG records extend beyond the replayed input history"):0;
}
static int rng_boundary(game_t *g,long long id,const char *kind,const char *params)
{
    mj_val value;char *fingerprint,*record; mj_Buf b;size_t count;
    if(!g->rng_version)return 0;
    if(g->rng_error[0])return -1;
    if(!mj_find(params,"rngIntegrity",&value)||!rng_shape(value)||!(fingerprint=mj_canonical(value)))
        return rng_fail(g,"pinned engine did not supply valid private RNG metadata");
    if(strlen(fingerprint)>=sizeof g->rng_last){free(fingerprint);return rng_fail(g,"private RNG fingerprint is oversized");}
    strcpy(g->rng_last,fingerprint);
    count=g->replaying?g->rng_replay_position:g->input_count;
    mj_init(&b);mj_obj(&b);mj_key(&b,"inputCount");mj_intv(&b,(long long)count);
    mj_key(&b,"inputId");mj_intv(&b,id);mj_key(&b,"kind");mj_strv(&b,kind);
    mj_key(&b,"rng");mj_rawv(&b,fingerprint);mj_endobj(&b);free(fingerprint);record=mj_take(&b);
    if(!record)return rng_fail(g,"cannot allocate private RNG record");
#ifdef __EMSCRIPTEN__
    nnh_protocol_rng(record);
#endif
    if(g->replaying){
        char expected[1024];size_t length;
        if(!g->rng_reader||!fgets(expected,sizeof expected,g->rng_reader)){
            free(record);return rng_fail(g,"private RNG boundary record is missing; it was not invented");
        }
        length=strlen(expected);
        if(!length||expected[length-1]!='\n'){free(record);return rng_fail(g,"private RNG record is torn or oversized");}
        expected[length-1]=0;
        if(strcmp(expected,record)){free(record);return rng_fail(g,"private RNG replay boundary mismatch");}
        free(record);return 0;
    }
    {
        char path[PATH_MAX];struct stat st;int fd,ok;FILE *f;
        snprintf(path,sizeof path,"%s/rng.jsonl",g->dir);
        fd=record_regular(path,O_WRONLY|O_APPEND|O_CREAT);
        if(fd<0){free(record);return rng_fail(g,"cannot open private RNG records for durable append");}
        if(fstat(fd,&st)||(!g->rng_have_stat&&st.st_size)||
           (g->rng_have_stat&&!record_same(&st,&g->rng_stat))||st.st_size+(off_t)strlen(record)+1>INPUT_MAX_BYTES){
            close(fd);free(record);return rng_fail(g,"private RNG record file changed unexpectedly");
        }
        f=fdopen(fd,"a");if(!f){close(fd);free(record);return rng_fail(g,"cannot append private RNG record");}
        ok=fputs(record,f)>=0&&fputc('\n',f)!=EOF&&fflush(f)==0&&fsync(fileno(f))==0;
        free(record);if(ok&&fstat(fileno(f),&st))ok=0;if(fclose(f))ok=0;
        fd=open(g->dir,O_RDONLY|O_DIRECTORY|O_CLOEXEC);
        if(fd<0)ok=0;else{if(fsync(fd))ok=0;close(fd);}
        if(!ok)return rng_fail(g,"private RNG boundary could not be durably recorded; no answer was sent");
        g->rng_stat=st;g->rng_have_stat=1;return 0;
    }
}

/* Private link namespace, shared by native and WASM translation units.
 * Keep short implementation spellings local to uninstalled headers; emit only
 * nnh_private_* linkage names. No alias symbols or compatibility API are built.
 * Visibility alone cannot prevent generic-name collisions in a static archive.
 */
#ifndef NNH_PRIVATE_SYMBOLS_H
#define NNH_PRIVATE_SYMBOLS_H
#define mj_find nnh_private_mj_find
#define mj_str nnh_private_mj_str
#define mj_int nnh_private_mj_int
#define mj_bool nnh_private_mj_bool
#define mj_is_null nnh_private_mj_is_null
#define mj_raw nnh_private_mj_raw
#define mj_canonical nnh_private_mj_canonical
#define mj_valid nnh_private_mj_valid
#define mj_arr_next nnh_private_mj_arr_next
#define mj_init nnh_private_mj_init
#define mj_free nnh_private_mj_free
#define mj_take nnh_private_mj_take
#define mj_obj nnh_private_mj_obj
#define mj_endobj nnh_private_mj_endobj
#define mj_arr nnh_private_mj_arr
#define mj_endarr nnh_private_mj_endarr
#define mj_key nnh_private_mj_key
#define mj_strv nnh_private_mj_strv
#define mj_intv nnh_private_mj_intv
#define mj_boolv nnh_private_mj_boolv
#define mj_nullv nnh_private_mj_nullv
#define mj_rawv nnh_private_mj_rawv
#define nnh_object_next nnh_private_object_next
#define nnh_schema_valid nnh_private_schema_valid
#define nnh_item_actions nnh_private_item_actions
#define nnh_terrain_names nnh_private_terrain_names
#define nnh_compass_names nnh_private_compass_names
#define nnh_resolve_cell nnh_private_resolve_cell
#define nnh_known_route nnh_private_known_route
#define nnh_known_paths nnh_private_known_paths
#define nnh_known_block nnh_private_known_block
#define nnh_emit_basis nnh_private_emit_basis
#define nnh_emit_gate nnh_private_emit_gate
#define nnh_emit_cell_actions nnh_private_emit_cell_actions
#define nnh_emit_display nnh_private_emit_display
#define nnh_terrain_freshness nnh_private_terrain_freshness
#define nnh_terrain_mark nnh_private_terrain_mark
#define nnh_emit_neighborhood nnh_private_emit_neighborhood
#define nhx_open nnh_private_open
#define nhx_call nnh_private_call
#define nhx_free nnh_private_free
#define nhx_close nnh_private_close
#define nh_session_start nnh_private_session_start
#define nh_session_start_with_lease nnh_private_session_start_with_lease
#define nh_session_write nnh_private_session_write
#define nh_session_read_line nnh_private_session_read_line
#define nh_session_close nnh_private_session_close
#define nh_session_abort nnh_private_session_abort
#define nh_session_ended nnh_private_session_ended
#endif

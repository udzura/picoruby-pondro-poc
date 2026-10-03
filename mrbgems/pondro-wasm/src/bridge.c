#include <mruby.h>
#include <mruby/class.h>
#include <mruby/string.h>
#include <stdlib.h>
#include <string.h>

static mrb_state *vm;

__attribute__((import_module("pondro"), import_name("rpc_start")))
extern int pondro_rpc_start(const char *json, int length);
__attribute__((import_module("pondro"), import_name("rpc_await")))
extern char *pondro_rpc_await(int token);

static mrb_value rpc_start(mrb_state *mrb, mrb_value self)
{
  mrb_value json;
  mrb_get_args(mrb, "S", &json);
  return mrb_int_value(mrb, pondro_rpc_start(RSTRING_PTR(json), RSTRING_LEN(json)));
}

static mrb_value rpc_await(mrb_state *mrb, mrb_value self)
{
  mrb_int token;
  mrb_get_args(mrb, "i", &token);
  char *json = pondro_rpc_await(token);
  if (!json) mrb_raise(mrb, E_RUNTIME_ERROR, "RPC result allocation failed");
  mrb_value result = mrb_str_new_cstr(mrb, json);
  free(json);
  return result;
}

int pondro_init(void)
{
  vm = mrb_open();
  return vm && !vm->exc;
}

/* Returns an owned, null-terminated UTF-8 JSON string. Host frees the result. */
char *pondro_dispatch(const char *json)
{
  int arena = mrb_gc_arena_save(vm);
  mrb_value input = mrb_str_new_cstr(vm, json);
  mrb_value result = mrb_funcall(vm, mrb_obj_value(mrb_module_get(vm, "Pondro")),
                                "dispatch", 1, input);
  char *output = NULL;
  if (!vm->exc && mrb_string_p(result)) {
    size_t length = RSTRING_LEN(result);
    output = malloc(length + 1);
    if (output) {
      memcpy(output, RSTRING_PTR(result), length);
      output[length] = '\0';
    }
  }
  vm->exc = NULL;
  mrb_gc_arena_restore(vm, arena);
  return output;
}

void pondro_destroy(void)
{
  if (vm) mrb_close(vm);
  vm = NULL;
}

void mrb_pondro_wasm_gem_init(mrb_state *mrb)
{
  struct RClass *pondro = mrb_module_get(mrb, "Pondro");
  mrb_define_module_function(mrb, pondro, "__rpc_start", rpc_start, MRB_ARGS_REQ(1));
  mrb_define_module_function(mrb, pondro, "__rpc_await", rpc_await, MRB_ARGS_REQ(1));
}
void mrb_pondro_wasm_gem_final(mrb_state *mrb) { (void)mrb; }

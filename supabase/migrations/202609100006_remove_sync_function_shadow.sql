begin;

-- PostgreSQL creates the integer FOR-loop variable automatically. Remove the
-- redundant declaration from the function installed by 005 so strict
-- plpgsql linting remains clean without changing behavior.
do $migration$
declare
  function_definition text;
  corrected_definition text;
begin
  select pg_get_functiondef('public.sync_offline_sale(uuid,uuid,jsonb)'::regprocedure)
  into function_definition;

  corrected_definition := replace(
    function_definition,
    E'  item_index integer;\n',
    ''
  );

  if corrected_definition = function_definition then
    raise exception 'Expected item_index declaration was not found';
  end if;

  execute corrected_definition;
end;
$migration$;

commit;

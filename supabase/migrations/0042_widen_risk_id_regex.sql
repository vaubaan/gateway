-- Widen the valid_risk_id_array() regex to allow hyphens in the provider
-- prefix segment (e.g. cloudflare-dns.*, upstash-redis.*).
-- Old: ^[a-z][a-z0-9]*(...
-- New: ^[a-z][a-z0-9-]*(...
-- The function is IMMUTABLE so replacing it in place is safe; existing rows
-- that passed the old regex trivially pass the new one (superset).

create or replace function valid_risk_id_array(arr jsonb) returns boolean
language plpgsql immutable as $$
declare
  re text := '^[a-z][a-z0-9-]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$';
  elem jsonb;
begin
  if jsonb_typeof(arr) <> 'array' then
    return false;
  end if;
  for elem in select * from jsonb_array_elements(arr) loop
    if jsonb_typeof(elem) <> 'string' then
      return false;
    end if;
    if (elem #>> '{}') !~ re then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

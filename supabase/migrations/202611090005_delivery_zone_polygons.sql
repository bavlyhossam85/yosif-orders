-- Yosif Orders: polygon delivery zones and server-side customer coverage checks.
begin;

create or replace function public.delivery_point_inside_polygon(
  p_latitude double precision,
  p_longitude double precision,
  p_polygon jsonb
) returns boolean
language plpgsql immutable
set search_path = public
as $$
declare
  v_ring jsonb;
  v_count integer;
  v_i integer;
  v_j integer;
  v_xi double precision;
  v_yi double precision;
  v_xj double precision;
  v_yj double precision;
  v_inside boolean := false;
  v_type text;
  v_center_lat double precision;
  v_center_lng double precision;
  v_radius double precision;
  v_distance double precision;
begin
  if p_polygon is null or jsonb_typeof(p_polygon) <> 'object' then return false; end if;
  v_type := p_polygon->>'type';
  -- Backward compatibility for legacy circle-shaped JSON records, if present.
  if lower(coalesce(v_type,'')) = 'circle' then
    v_center_lat := coalesce((p_polygon->'center'->>'latitude')::double precision,(p_polygon->'center'->>0)::double precision);
    v_center_lng := coalesce((p_polygon->'center'->>'longitude')::double precision,(p_polygon->'center'->>1)::double precision);
    v_radius := coalesce((p_polygon->>'radius_m')::double precision,(p_polygon->>'radius')::double precision);
    if v_center_lat is null or v_center_lng is null or v_radius is null or v_radius <= 0 then return false; end if;
    v_distance := 2 * 6371000 * asin(sqrt(
      power(sin(radians(p_latitude-v_center_lat)/2),2) +
      cos(radians(v_center_lat))*cos(radians(p_latitude))*power(sin(radians(p_longitude-v_center_lng)/2),2)
    ));
    return v_distance <= v_radius;
  end if;
  if v_type = 'Feature' then p_polygon := p_polygon->'geometry'; v_type := p_polygon->>'type'; end if;
  if v_type <> 'Polygon' or jsonb_typeof(p_polygon->'coordinates') <> 'array' then return false; end if;
  v_ring := p_polygon->'coordinates'->0;
  if jsonb_typeof(v_ring) <> 'array' then return false; end if;
  v_count := jsonb_array_length(v_ring);
  if v_count < 4 then return false; end if;
  v_j := v_count - 1;
  for v_i in 0..v_count-1 loop
    v_xi := (v_ring->v_i->>0)::double precision; v_yi := (v_ring->v_i->>1)::double precision;
    v_xj := (v_ring->v_j->>0)::double precision; v_yj := (v_ring->v_j->>1)::double precision;
    if ((v_yi > p_latitude) <> (v_yj > p_latitude)) and
       (p_longitude < (v_xj-v_xi)*(p_latitude-v_yi)/nullif(v_yj-v_yi,0)+v_xi) then
      v_inside := not v_inside;
    end if;
    v_j := v_i;
  end loop;
  return v_inside;
exception when others then return false;
end;
$$;

create or replace function public.get_delivery_zone_for_point(
  p_latitude double precision,
  p_longitude double precision
) returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_zone record;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'Invalid coordinates';
  end if;
  select dz.id,dz.name,dz.delivery_fee,dz.min_order into v_zone
  from public.delivery_zones dz
  where dz.active = true and public.delivery_point_inside_polygon(p_latitude,p_longitude,dz.polygon)
  order by dz.created_at asc limit 1;
  if not found then return jsonb_build_object('inside',false); end if;
  return jsonb_build_object('inside',true,'id',v_zone.id,'name',v_zone.name,
    'delivery_fee',v_zone.delivery_fee,'min_order',v_zone.min_order);
end;
$$;

revoke all on function public.delivery_point_inside_polygon(double precision,double precision,jsonb) from public, anon, authenticated;
revoke all on function public.get_delivery_zone_for_point(double precision,double precision) from public, anon;
grant execute on function public.get_delivery_zone_for_point(double precision,double precision) to authenticated;

create or replace function public.enforce_order_delivery_zone()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_match boolean;
begin
  if new.latitude is not null and new.longitude is not null then
    select exists(select 1 from public.delivery_zones dz
      where dz.active = true and public.delivery_point_inside_polygon(new.latitude,new.longitude,dz.polygon)) into v_match;
    if not v_match then raise exception 'Customer location is outside active delivery zones'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_order_delivery_zone_before_insert on public.orders;
create trigger enforce_order_delivery_zone_before_insert
before insert or update of latitude,longitude on public.orders
for each row execute function public.enforce_order_delivery_zone();

commit;

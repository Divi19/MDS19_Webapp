alter table public.predictions
  add column response_json jsonb,
  add column response_format text not null default 'legacy',
  add column predictor_mode text,
  add column tile_count integer,
  add column reference_scope text,
  add column applicability_status text,
  add column analysis_version text,
  add column provenance_summary jsonb,
  add column qc_summary jsonb;

alter table public.predictions
  add constraint predictions_response_json_object_check
    check (response_json is null or jsonb_typeof(response_json) = 'object'),
  add constraint predictions_response_format_check
    check (response_format in ('legacy', 'expanded_v1')),
  add constraint predictions_response_format_payload_check
    check (
      (response_format = 'legacy' and response_json is null)
      or (response_format = 'expanded_v1' and response_json is not null)
    ),
  add constraint predictions_predictor_mode_check
    check (predictor_mode is null or predictor_mode in ('real', 'demo')),
  add constraint predictions_tile_count_check
    check (tile_count is null or tile_count >= 0),
  add constraint predictions_applicability_status_check
    check (applicability_status is null or applicability_status in ('within_scope', 'outside_scope')),
  add constraint predictions_provenance_summary_object_check
    check (provenance_summary is null or jsonb_typeof(provenance_summary) = 'object'),
  add constraint predictions_qc_summary_object_check
    check (qc_summary is null or jsonb_typeof(qc_summary) = 'object');

create index predictions_user_mode_created_at_idx
  on public.predictions(user_id, predictor_mode, created_at desc)
  where response_format = 'expanded_v1';

create or replace function public.save_research_run(
  p_filename text,
  p_image_path text,
  p_response jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_prediction_id uuid;
  v_status text;
  v_model_version text;
  v_metadata_model_version text;
  v_predictor_mode text;
  v_created_at timestamptz;
  v_tile_count integer;
  v_within_scope boolean;
  v_analysis_version text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  if p_filename is null or btrim(p_filename) = '' then
    raise exception using errcode = '22023', message = 'Filename is required';
  end if;

  if p_image_path is null
    or split_part(p_image_path, '/', 1) <> v_user_id::text
    or split_part(p_image_path, '/', 2) = '' then
    raise exception using errcode = '22023', message = 'Image path must belong to the authenticated user';
  end if;

  if p_response is null or jsonb_typeof(p_response) <> 'object' then
    raise exception using errcode = '22023', message = 'Expanded response must be a JSON object';
  end if;

  begin
    v_prediction_id := nullif(p_response ->> 'prediction_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'prediction_id must be a UUID';
  end;

  if v_prediction_id is null then
    raise exception using errcode = '22023', message = 'prediction_id is required';
  end if;

  if split_part(p_image_path, '/', 2) not like v_prediction_id::text || '.%' then
    raise exception using errcode = '22023', message = 'Image path must match prediction_id';
  end if;

  v_status := p_response ->> 'status';
  if v_status is distinct from 'complete' then
    raise exception using errcode = '22023', message = 'Only complete predictions can be saved';
  end if;

  if jsonb_typeof(p_response -> 'model_metadata') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'model_metadata is required';
  end if;

  v_model_version := nullif(btrim(p_response ->> 'model_version'), '');
  v_metadata_model_version := nullif(btrim(p_response #>> '{model_metadata,model_version}'), '');
  v_predictor_mode := p_response #>> '{model_metadata,mode}';

  if v_model_version is null
    or v_metadata_model_version is null
    or v_model_version <> v_metadata_model_version then
    raise exception using errcode = '22023', message = 'Consistent model version metadata is required';
  end if;

  if v_predictor_mode is null or v_predictor_mode not in ('real', 'demo') then
    raise exception using errcode = '22023', message = 'Predictor mode must be real or demo';
  end if;

  if jsonb_typeof(p_response -> 'prediction_tiles') is distinct from 'array'
    or jsonb_typeof(p_response -> 'spots') is distinct from 'array'
    or jsonb_typeof(p_response -> 'top_genes') is distinct from 'array'
    or jsonb_typeof(p_response -> 'image_metadata') is distinct from 'object'
    or jsonb_typeof(p_response -> 'coordinate_metadata') is distinct from 'object'
    or jsonb_typeof(p_response -> 'qc') is distinct from 'object'
    or jsonb_typeof(p_response -> 'applicability') is distinct from 'object'
    or jsonb_typeof(p_response -> 'all_gene_summary') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Expanded response is missing required payload sections';
  end if;

  v_tile_count := jsonb_array_length(p_response -> 'prediction_tiles');
  if v_tile_count = 0 then
    raise exception using errcode = '22023', message = 'At least one prediction tile is required';
  end if;

  if jsonb_typeof(p_response #> '{applicability,within_reference_scope}') is distinct from 'boolean' then
    raise exception using errcode = '22023', message = 'Applicability status is required';
  end if;
  v_within_scope := (p_response #>> '{applicability,within_reference_scope}')::boolean;

  begin
    v_created_at := nullif(p_response ->> 'created_at', '')::timestamptz;
  exception
    when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'created_at must be a timestamp';
  end;

  if v_created_at is null then
    raise exception using errcode = '22023', message = 'created_at is required';
  end if;

  v_analysis_version := coalesce(
    nullif(btrim(p_response ->> 'analysis_version'), ''),
    nullif(btrim(p_response #>> '{analysis_method,analysis_version}'), '')
  );

  insert into public.predictions (
    id,
    user_id,
    created_at,
    filename,
    image_path,
    model_version,
    status,
    response_json,
    response_format,
    predictor_mode,
    tile_count,
    reference_scope,
    applicability_status,
    analysis_version,
    provenance_summary,
    qc_summary
  ) values (
    v_prediction_id,
    v_user_id,
    v_created_at,
    p_filename,
    p_image_path,
    v_model_version,
    v_status,
    p_response,
    'expanded_v1',
    v_predictor_mode,
    v_tile_count,
    coalesce(
      nullif(btrim(p_response #>> '{applicability,reference_scope}'), ''),
      nullif(btrim(p_response #>> '{model_metadata,reference_scope}'), '')
    ),
    case when v_within_scope then 'within_scope' else 'outside_scope' end,
    v_analysis_version,
    jsonb_build_object(
      'model_metadata', p_response -> 'model_metadata',
      'image_metadata', p_response -> 'image_metadata',
      'coordinate_metadata', p_response -> 'coordinate_metadata'
    ),
    jsonb_build_object(
      'tissue_fraction', p_response #> '{qc,tissue_fraction}',
      'brightness', p_response #> '{qc,brightness}',
      'contrast', p_response #> '{qc,contrast}',
      'mean_saturation', p_response #> '{qc,mean_saturation}',
      'focus_proxy', p_response #> '{qc,focus_proxy}',
      'accepted_tile_count', p_response #> '{qc,accepted_tile_count}',
      'rejected_tile_count', p_response #> '{qc,rejected_tile_count}',
      'warnings', p_response #> '{qc,warnings}'
    )
  );

  return v_prediction_id;
end;
$$;

revoke all on function public.save_research_run(text, text, jsonb) from public;
revoke all on function public.save_research_run(text, text, jsonb) from anon;
grant execute on function public.save_research_run(text, text, jsonb) to authenticated;

/**
 * Cloudflare Pages Function — /api/search
 * Proxy vers l'API FHIR Annuaire Santé
 */

const API_BASE = 'https://gateway.api.esante.gouv.fr/fhir/v2';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    const url = new URL(request.url);
    return await handleSearch(url.searchParams, env);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleSearch(params, env) {
  // ─── Handle "load more" pagination ───
  const nextUrl = params.get('next');
  if (nextUrl) {
    return await handleLoadMore(nextUrl, env);
  }

  const name = params.get('name') || '';
  const city = params.get('city') || '';
  const specialty = params.get('specialty') || '';
  const specialtyCode = params.get('specialty_code') || '';
  const rpps = params.get('rpps') || '';
  const count = Math.min(parseInt(params.get('count') || '200', 10), 500);

  // ─── Strategy 1: Search by RPPS ───
  if (rpps) {
    return await searchByRpps(rpps, env);
  }

  // ─── Strategy 2: Search by specialty code (qualification-code on Practitioner) ───
  if (specialtyCode) {
    return await searchByQualificationCode(specialtyCode, name, city, count, env);
  }

  // ─── Strategy 3: Search by name (+ optional city post-filter) ───
  if (name) {
    return await searchByName(name, city, specialty, count, env);
  }

  // ─── Strategy 4: Search by city only (via PractitionerRole) ───
  if (city) {
    return await searchByRoleFilters(city, specialty, count, env);
  }

  return jsonResponse({ error: 'Remplis au moins un critère de recherche' }, 400);
}

// ─── Load More (pagination) ───
async function handleLoadMore(nextUrl, env) {
  // Validate URL is from the FHIR API
  if (!nextUrl.startsWith(API_BASE)) {
    return jsonResponse({ error: 'Invalid pagination URL' }, 400);
  }

  const bundle = await fhirFetch(nextUrl, env);
  if (!bundle?.entry?.length) return jsonResponse({ total: 0, results: [], nextPage: null });

  const practitioners = bundle.entry.map(e => parsePractitioner(e.resource));
  const roles = await fetchRolesForPractitioners(practitioners.map(p => p.id), env);
  const results = mergePractitionersAndRoles(practitioners, roles.practitionerRoles, roles.organizations);

  const fhirNext = bundle.link?.find(l => l.relation === 'next')?.url || null;

  return jsonResponse({
    total: results.length,
    totalFhir: bundle.total || 0,
    results,
    nextPage: fhirNext,
  });
}

// ─── Search by qualification-code (specialty) ───
async function searchByQualificationCode(code, name, city, count, env) {
  // If city is provided: search Organizations in that city first, then find practitioners
  if (city && !name) {
    return await searchBySpecialtyAndCity(code, city, count, env);
  }

  // Build name params — try most precise first, stop on first match
  const parts = name ? name.trim().split(/\s+/) : [];
  let bundle = null;

  if (parts.length >= 2) {
    const p1 = new URLSearchParams({ 'qualification-code': code, family: parts[0], given: parts.slice(1).join(' '), _count: '200' });
    bundle = await fhirFetch(`${API_BASE}/Practitioner?${p1}`, env);
    if (!bundle.entry?.length) {
      const p2 = new URLSearchParams({ 'qualification-code': code, family: parts[parts.length - 1], given: parts.slice(0, -1).join(' '), _count: '200' });
      bundle = await fhirFetch(`${API_BASE}/Practitioner?${p2}`, env);
    }
  } else if (parts.length === 1) {
    const p1 = new URLSearchParams({ 'qualification-code': code, family: name, _count: '200' });
    bundle = await fhirFetch(`${API_BASE}/Practitioner?${p1}`, env);
    if (!bundle.entry?.length) {
      const p2 = new URLSearchParams({ 'qualification-code': code, name: name, _count: '200' });
      bundle = await fhirFetch(`${API_BASE}/Practitioner?${p2}`, env);
    }
  } else {
    const p1 = new URLSearchParams({ 'qualification-code': code, _count: '200' });
    bundle = await fhirFetch(`${API_BASE}/Practitioner?${p1}`, env);
  }

  if (!bundle?.entry?.length) return jsonResponse({ total: 0, totalFhir: bundle?.total || 0, results: [], nextPage: null });

  const practitioners = bundle.entry.map(e => parsePractitioner(e.resource));
  const roles = await fetchRolesForPractitioners(practitioners.map(p => p.id), env);
  let results = mergePractitionersAndRoles(practitioners, roles.practitionerRoles, roles.organizations);

  // Post-filter by city if provided (when name is also given)
  results = filterByCity(results, city);

  const fhirNext = bundle.link?.find(l => l.relation === 'next')?.url || null;
  return jsonResponse({ total: results.length, totalFhir: bundle.total || 0, results, nextPage: fhirNext });
}

// ─── Search by specialty + city (reverse lookup via Organizations) ───
async function searchBySpecialtyAndCity(qualCode, city, count, env) {
  // Step 1: Find ALL organizations in that city (paginate up to 3 pages = 600 orgs)
  const orgParams = new URLSearchParams();
  orgParams.set('address-city', city);
  orgParams.set('_count', '200');
  orgParams.set('_elements', 'id,name,address,telecom');

  const orgBundle = await fhirFetch(`${API_BASE}/Organization?${orgParams}`, env);
  if (!orgBundle.entry?.length) return jsonResponse({ total: 0, results: [], message: `Aucune structure trouvée à ${city}` });

  let allOrgEntries = [...orgBundle.entry];
  // Paginate if more orgs exist
  // Max 1 extra page to stay within Cloudflare subrequest limits
  const nextOrgUrl = orgBundle.link?.find(l => l.relation === 'next')?.url;
  if (nextOrgUrl) {
    const nextBundle = await fhirFetch(nextOrgUrl, env);
    if (nextBundle.entry) allOrgEntries.push(...nextBundle.entry);
  }

  const orgs = {};
  const orgIds = [];
  for (const entry of allOrgEntries) {
    const org = parseOrganization(entry.resource);
    orgs[org.id] = org;
    orgIds.push(org.id);
  }

  // Step 2: Find PractitionerRoles linked to those organizations
  // Limit org batches to stay within Cloudflare's 50 subrequest limit
  const practitionerIds = new Set();
  const rolesByPractitioner = {};
  const batchSize = 50;
  const maxOrgBatches = 6; // 6 batches × 50 orgs = 300 orgs max
  const limitedOrgIds = orgIds.slice(0, batchSize * maxOrgBatches);

  for (let i = 0; i < limitedOrgIds.length && i / batchSize < maxOrgBatches; i += batchSize) {
    const batch = limitedOrgIds.slice(i, i + batchSize);
    const roleParams = new URLSearchParams();
    roleParams.set('organization', batch.join(','));
    roleParams.set('_count', '200');

    const roleBundle = await fhirFetch(`${API_BASE}/PractitionerRole?${roleParams}`, env);
    if (!roleBundle.entry) continue;

    for (const entry of roleBundle.entry) {
      const r = entry.resource;
      if (r.resourceType === 'PractitionerRole') {
        const role = parsePractitionerRole(r);
        if (role.organizationId && orgs[role.organizationId]) {
          role.organization = orgs[role.organizationId];
        }
        const pid = role.practitionerId;
        practitionerIds.add(pid);
        if (!rolesByPractitioner[pid]) rolesByPractitioner[pid] = [];
        rolesByPractitioner[pid].push(role);
      }
    }
  }

  if (practitionerIds.size === 0) return jsonResponse({ total: 0, results: [] });

  // Step 3: Fetch those practitioners filtered by qualification-code
  // Use larger batches, limit total requests
  const matchedPractitioners = [];
  const pidArray = [...practitionerIds];
  const maxPractBatches = 5;

  for (let i = 0; i < pidArray.length && i / batchSize < maxPractBatches; i += batchSize) {
    const batch = pidArray.slice(i, i + batchSize);
    const practParams = new URLSearchParams();
    practParams.set('_id', batch.join(','));
    practParams.set('qualification-code', qualCode);
    practParams.set('_count', '200');

    const practBundle = await fhirFetch(`${API_BASE}/Practitioner?${practParams}`, env);
    if (practBundle.entry) {
      for (const entry of practBundle.entry) {
        matchedPractitioners.push(parsePractitioner(entry.resource));
      }
    }
  }

  // Merge
  const results = matchedPractitioners.map(p => ({
    ...p,
    roles: rolesByPractitioner[p.id] || [],
  })).slice(0, count);

  return jsonResponse({ total: results.length, results });
}

// ─── Search by RPPS ───
async function searchByRpps(rpps, env) {
  const fhirParams = new URLSearchParams();
  fhirParams.set('identifier', `https://rpps.esante.gouv.fr|${rpps}`);
  fhirParams.set('_count', '10');

  const bundle = await fhirFetch(`${API_BASE}/Practitioner?${fhirParams}`, env);
  if (!bundle.entry?.length) return jsonResponse({ total: 0, results: [] });

  const practitioners = bundle.entry.map(e => parsePractitioner(e.resource));
  const roles = await fetchRolesForPractitioners(practitioners.map(p => p.id), env);
  const results = mergePractitionersAndRoles(practitioners, roles.practitionerRoles, roles.organizations);

  return jsonResponse({ total: results.length, results });
}

// ─── Search by name ───
async function searchByName(name, city, specialty, count, env) {
  const parts = name.trim().split(/\s+/);
  
  // Strategy: try the most precise search first, fallback if 0 results
  let bundle = null;

  if (parts.length >= 2) {
    // Try family=first + given=rest
    const p1 = new URLSearchParams({ family: parts[0], given: parts.slice(1).join(' '), _count: '200' });
    bundle = await fhirFetch(`${API_BASE}/Practitioner?${p1}`, env);

    // If 0 results, try reversed: family=last + given=first
    if (!bundle.entry?.length) {
      const p2 = new URLSearchParams({ family: parts[parts.length - 1], given: parts.slice(0, -1).join(' '), _count: '200' });
      bundle = await fhirFetch(`${API_BASE}/Practitioner?${p2}`, env);
    }

    // If still 0, try just family name (first word)
    if (!bundle.entry?.length) {
      const p3 = new URLSearchParams({ family: parts[0], _count: '200' });
      bundle = await fhirFetch(`${API_BASE}/Practitioner?${p3}`, env);
    }
  } else {
    // Single word: try family first
    const p1 = new URLSearchParams({ family: name, _count: '200' });
    bundle = await fhirFetch(`${API_BASE}/Practitioner?${p1}`, env);

    // If 0, try broad name search
    if (!bundle.entry?.length) {
      const p2 = new URLSearchParams({ name: name, _count: '200' });
      bundle = await fhirFetch(`${API_BASE}/Practitioner?${p2}`, env);
    }
  }

  if (!bundle?.entry?.length) return jsonResponse({ total: 0, totalFhir: bundle?.total || 0, results: [] });

  if (!bundle.entry?.length) return jsonResponse({ total: 0, totalFhir: bundle.total || 0, results: [] });

  // If filtering by city or specialty, paginate 1 extra page for more results
  let allEntries = [...bundle.entry];
  const needsPostFilter = !!(city || specialty);
  if (needsPostFilter && bundle.total > allEntries.length) {
    const nextUrl = bundle.link?.find(l => l.relation === 'next')?.url;
    if (nextUrl) {
      const page2 = await fhirFetch(nextUrl, env);
      if (page2.entry) allEntries.push(...page2.entry);
    }
  }

  const practitioners = allEntries.map(e => parsePractitioner(e.resource));
  const roles = await fetchRolesForPractitioners(practitioners.map(p => p.id), env);
  let results = mergePractitionersAndRoles(practitioners, roles.practitionerRoles, roles.organizations);

  // Post-filter
  results = filterByCity(results, city);
  results = filterBySpecialty(results, specialty);

  // Cap results
  const totalFhir = bundle.total || 0;
  results = results.slice(0, count);

  return jsonResponse({
    total: results.length,
    totalFhir,
    message: totalFhir > 200 && !needsPostFilter ? `${totalFhir} résultats au total — affinez votre recherche (ville, spécialité) pour des résultats plus précis` : undefined,
    results,
    nextPage: (!needsPostFilter && bundle.link?.find(l => l.relation === 'next')?.url) || null,
  });
}

// ─── Search by role filters (specialty/city without name) ───
async function searchByRoleFilters(city, specialty, count, env) {
  // Search PractitionerRole directly — supports specialty as a search param
  const fhirParams = new URLSearchParams();
  fhirParams.set('_count', count.toString());
  fhirParams.set('_include', 'PractitionerRole:practitioner');
  fhirParams.set('_include', 'PractitionerRole:organization');

  if (specialty) {
    // FHIR supports text search on specialty
    fhirParams.set('role', specialty);
  }

  const bundle = await fhirFetch(`${API_BASE}/PractitionerRole?${fhirParams}`, env);
  if (!bundle.entry?.length) return jsonResponse({ total: 0, results: [] });

  // Separate resources by type
  const practitionerRoles = [];
  const practitioners = {};
  const organizations = {};

  for (const entry of bundle.entry) {
    const r = entry.resource;
    if (r.resourceType === 'PractitionerRole') {
      practitionerRoles.push(parsePractitionerRole(r));
    } else if (r.resourceType === 'Practitioner') {
      practitioners[r.id] = parsePractitioner(r);
    } else if (r.resourceType === 'Organization') {
      organizations[r.id] = parseOrganization(r);
    }
  }

  // Group roles by practitioner
  const practByRoles = {};
  for (const role of practitionerRoles) {
    if (role.organizationId && organizations[role.organizationId]) {
      role.organization = organizations[role.organizationId];
    }
    const pid = role.practitionerId;
    if (!practByRoles[pid]) practByRoles[pid] = [];
    practByRoles[pid].push(role);
  }

  // Build results
  let results = Object.entries(practByRoles).map(([pid, roles]) => {
    const pract = practitioners[pid] || { id: pid, lastName: '', firstName: '', rpps: null, identifiers: [], qualifications: [] };
    return { ...pract, roles };
  });

  // Post-filter by city
  results = filterByCity(results, city);

  // Post-filter by specialty text (more precise than FHIR role param)
  results = filterBySpecialty(results, specialty);

  return jsonResponse({ total: results.length, totalFhir: bundle.total || 0, results });
}

// ─── Shared: fetch roles for practitioner IDs ───
async function fetchRolesForPractitioners(ids, env) {
  const practitionerRoles = [];
  const organizations = {};
  const batchSize = 50; // Larger batches = fewer subrequests
  const maxBatches = 6; // Stay within Cloudflare limits

  for (let i = 0; i < ids.length && i / batchSize < maxBatches; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const params = new URLSearchParams();
    params.set('practitioner', batch.join(','));
    params.set('_count', '200');
    params.set('_include', 'PractitionerRole:organization');

    const bundle = await fhirFetch(`${API_BASE}/PractitionerRole?${params}`, env);

    if (bundle.entry) {
      for (const entry of bundle.entry) {
        if (entry.resource.resourceType === 'PractitionerRole') {
          practitionerRoles.push(parsePractitionerRole(entry.resource));
        } else if (entry.resource.resourceType === 'Organization') {
          organizations[entry.resource.id] = parseOrganization(entry.resource);
        }
      }
    }
  }

  return { practitionerRoles, organizations };
}

// ─── Filters ───
function filterByCity(results, city) {
  if (!city) return results;
  const cityLower = city.toLowerCase();
  return results.filter(r =>
    r.roles.some(role =>
      role.address?.toLowerCase().includes(cityLower) ||
      role.city?.toLowerCase().includes(cityLower) ||
      role.organization?.city?.toLowerCase().includes(cityLower) ||
      role.organization?.address?.toLowerCase().includes(cityLower)
    )
  );
}

function filterBySpecialty(results, specialty) {
  if (!specialty) return results;
  const specLower = specialty.toLowerCase();
  return results.filter(r =>
    r.roles.some(role =>
      role.specialties?.some(s => s.toLowerCase().includes(specLower))
    ) ||
    r.qualifications?.some(q => q.display?.toLowerCase().includes(specLower))
  );
}

// ─── Merge ───
function mergePractitionersAndRoles(practitioners, roles, orgs) {
  const rolesByPractitioner = {};
  for (const role of roles) {
    if (!role.practitionerId) continue;
    if (role.organizationId && orgs[role.organizationId]) {
      role.organization = orgs[role.organizationId];
    }
    if (!rolesByPractitioner[role.practitionerId]) {
      rolesByPractitioner[role.practitionerId] = [];
    }
    rolesByPractitioner[role.practitionerId].push(role);
  }

  return practitioners.map(p => ({
    ...p,
    roles: rolesByPractitioner[p.id] || [],
  }));
}

// ─── Parsers ───

function parsePractitioner(resource) {
  const name = resource.name?.[0] || {};
  const identifiers = (resource.identifier || []).map(id => ({
    system: id.system,
    value: id.value,
    type: id.system?.includes('rpps') ? 'RPPS'
      : id.system?.includes('adeli') ? 'ADELI'
      : id.type?.coding?.[0]?.code || 'OTHER',
  }));

  const qualifications = (resource.qualification || []).map(q => ({
    code: q.code?.coding?.[0]?.code,
    display: q.code?.coding?.[0]?.display || q.code?.text,
    system: q.code?.coding?.[0]?.system,
  }));

  const rpps = identifiers.find(i => i.type === 'RPPS')?.value || null;

  return {
    id: resource.id,
    rpps,
    identifiers,
    lastName: name.family || '',
    firstName: (name.given || []).join(' '),
    prefix: (name.prefix || []).join(' '),
    suffix: (name.suffix || []).join(' '),
    qualifications,
    active: resource.active !== false,
  };
}

function parsePractitionerRole(resource) {
  const specialties = (resource.specialty || []).flatMap(s =>
    (s.coding || []).map(c => c.display || c.code)
  );

  const telecoms = (resource.telecom || []).map(t => ({
    system: t.system,
    value: t.value,
    use: t.use,
  }));

  const practRef = resource.practitioner?.reference || '';
  const practitionerId = practRef.replace('Practitioner/', '');

  const orgRef = resource.organization?.reference || '';
  const organizationId = orgRef.replace('Organization/', '');

  return {
    id: resource.id,
    practitionerId,
    organizationId,
    specialties,
    telecoms,
    active: resource.active !== false,
  };
}

function parseOrganization(resource) {
  const addr = resource.address?.[0] || null;
  const telecoms = (resource.telecom || []).map(t => ({
    system: t.system,
    value: t.value,
  }));

  return {
    id: resource.id,
    name: resource.name || '',
    type: resource.type?.[0]?.coding?.[0]?.display || '',
    address: addr ? formatAddress(addr) : null,
    city: addr?.city || null,
    postalCode: addr?.postalCode || null,
    telecoms,
  };
}

function formatAddress(addr) {
  if (!addr) return null;
  const parts = [
    ...(addr.line || []),
    [addr.postalCode, addr.city].filter(Boolean).join(' '),
    addr.country,
  ].filter(Boolean);
  return parts.join(', ');
}

// ─── Helpers ───

async function fhirFetch(url, env) {
  const apiKey = env.ESANTE_API_KEY || 'PLACEHOLDER_KEY';
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/fhir+json',
      'ESANTE-API-KEY': apiKey,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FHIR API ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

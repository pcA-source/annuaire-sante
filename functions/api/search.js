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
  const name = params.get('name') || '';
  const city = params.get('city') || '';
  const specialty = params.get('specialty') || '';
  const rpps = params.get('rpps') || '';
  const count = Math.min(parseInt(params.get('count') || '50', 10), 200);

  const fhirParams = new URLSearchParams();
  fhirParams.set('_count', count.toString());

  if (rpps) {
    fhirParams.set('identifier', `https://rpps.esante.gouv.fr|${rpps}`);
  } else {
    if (name) fhirParams.set('name', name);
  }

  // Fetch Practitioners
  const practitionerUrl = `${API_BASE}/Practitioner?${fhirParams.toString()}`;
  const bundle = await fhirFetch(practitionerUrl, env);

  if (!bundle.entry || bundle.entry.length === 0) {
    return jsonResponse({ total: 0, results: [] });
  }

  const practitioners = bundle.entry.map(e => parsePractitioner(e.resource));
  const practitionerIds = practitioners.map(p => p.id);

  // Fetch PractitionerRoles with Organization included
  const roles = await fetchRolesForPractitioners(practitionerIds, env);

  // Merge
  const results = mergePractitionersAndRoles(practitioners, roles.practitionerRoles, roles.organizations);

  // Post-filter by city
  let filtered = results;
  if (city) {
    const cityLower = city.toLowerCase();
    filtered = filtered.filter(r =>
      r.roles.some(role =>
        role.address?.toLowerCase().includes(cityLower) ||
        role.city?.toLowerCase().includes(cityLower) ||
        role.organization?.city?.toLowerCase().includes(cityLower) ||
        role.organization?.address?.toLowerCase().includes(cityLower)
      )
    );
  }
  // Post-filter by specialty
  if (specialty) {
    const specLower = specialty.toLowerCase();
    filtered = filtered.filter(r =>
      r.roles.some(role =>
        role.specialties?.some(s => s.toLowerCase().includes(specLower))
      ) ||
      r.qualifications?.some(q => q.display?.toLowerCase().includes(specLower))
    );
  }

  return jsonResponse({
    total: filtered.length,
    totalFhir: bundle.total || 0,
    results: filtered,
  });
}

async function fetchRolesForPractitioners(ids, env) {
  const practitionerRoles = [];
  const organizations = {};
  const batchSize = 20;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const params = new URLSearchParams();
    params.set('practitioner', batch.join(','));
    params.set('_count', '200');
    params.set('_include', 'PractitionerRole:organization');

    const url = `${API_BASE}/PractitionerRole?${params.toString()}`;
    const bundle = await fhirFetch(url, env);

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

function mergePractitionersAndRoles(practitioners, roles, orgs) {
  const rolesByPractitioner = {};
  for (const role of roles) {
    if (!role.practitionerId) continue;
    // Attach org
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
